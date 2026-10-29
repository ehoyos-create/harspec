#!/usr/bin/env node
/**
 * harspec — turn recorded web traffic into an API spec, a typed client and a
 * risk report.
 *
 * Deterministic pipeline:
 *   HAR → normalize → cluster into operations → infer schemas → emit artifacts
 *
 * The core calls no model: same capture in, same files out.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { buildClient } from './client.ts';
import { clusterEntries, readHar, type Entry } from './har.ts';
import { buildOpenApi, summariseDocument } from './openapi.ts';
import { passiveFindings, renderReportMarkdown, severityRank, type Finding } from './report.ts';
import { activeFindings } from './replay.ts';
import { scanBundles } from './scan.ts';
import { plural, uniq } from './util.ts';
import { toYaml } from './yaml.ts';

const VERSION = '0.1.0';

interface Args {
  har?: string;
  out: string;
  title?: string;
  replay: boolean;
  allowHosts: string[];
  scanBundles: boolean;
  quiet: boolean;
  json: boolean;
  help: boolean;
  version: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    out: 'harspec-out',
    replay: false,
    allowHosts: [],
    scanBundles: false,
    quiet: false,
    json: false,
    help: false,
    version: false,
  };

  const rest: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '-h' || arg === '--help') args.help = true;
    else if (arg === '-v' || arg === '--version') args.version = true;
    else if (arg === '-o' || arg === '--out') args.out = argv[++i] ?? args.out;
    else if (arg === '--title') args.title = argv[++i];
    else if (arg === '--replay') args.replay = true;
    else if (arg === '--allow-host') args.allowHosts.push(argv[++i] ?? '');
    else if (arg === '--scan-bundles') args.scanBundles = true;
    else if (arg === '--quiet' || arg === '-q') args.quiet = true;
    else if (arg === '--json') args.json = true;
    else if (arg.startsWith('-')) throw new Error(`Unknown option: ${arg}`);
    else rest.push(arg);
  }

  args.har = rest[0];
  return args;
}

function help(): string {
  return [
    '',
    '  harspec — turn recorded web traffic into an API spec, a typed client and a risk report',
    '',
    '  Usage',
    '    harspec <capture.har> [options]',
    '',
    '  Options',
    '    -o, --out <dir>        Output directory (default: ./harspec-out)',
    '        --title <text>     API title used in the spec',
    '        --scan-bundles     Fetch the JS in the capture and scan it for secrets and source maps',
    '        --replay           Replay captured writes with tampered fields (localhost by default)',
    '        --allow-host <h>   Extend the replay allowlist to another host (repeatable)',
    '    -q, --quiet            Only print the output directory',
    '        --json             Print the summary as JSON',
    '    -v, --version          Print version',
    '    -h, --help             Print this help',
    '',
    '  How to capture',
    '    Chrome / Edge: DevTools → Network → right click → "Save all as HAR with content"',
    '    Firefox:       Network → gear icon → "Save All As HAR"',
    '    Safari:        Network → Export',
    '',
    '  Example',
    '    harspec session.har --scan-bundles --replay',
    '',
  ].join('\n');
}

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code: string) => (text: string) => (useColor ? `\u001b[${code}m${text}\u001b[0m` : text);
const bold = paint('1');
const dim = paint('2');
const red = paint('31');
const green = paint('32');
const yellow = paint('33');
const magenta = paint('35');
const cyan = paint('36');
const blue = paint('34');

const severityColor: Record<string, (text: string) => string> = {
  critical: red,
  high: magenta,
  medium: yellow,
  low: cyan,
  info: blue,
};

function sortFindings(findings: Finding[]): Finding[] {
  return [...findings].sort((a, b) => severityRank(a.severity) - severityRank(b.severity));
}

async function main(): Promise<number> {
  let args: Args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error: any) {
    console.error(red(`error: ${error.message}`));
    console.error(help());
    return 1;
  }

  if (args.version) {
    console.log(VERSION);
    return 0;
  }
  if (args.help) {
    console.log(help());
    return 0;
  }
  if (!args.har) {
    console.log(help());
    return 1;
  }

  const harPath = resolve(args.har);
  let entries: Entry[];
  try {
    entries = readHar(harPath);
  } catch (error: any) {
    console.error(red(`error: could not read HAR at ${harPath}`));
    console.error(dim(`  ${error.message}`));
    return 1;
  }

  if (!entries.length) {
    console.error(red('error: the HAR contains no requests'));
    return 1;
  }

  const clusters = clusterEntries(entries);
  if (!clusters.length) {
    console.error(red('error: no API requests found (only documents or static assets)'));
    return 1;
  }

  const hosts = uniq(entries.map((e) => e.host).filter(Boolean));
  const target = hosts.length === 1 ? hosts[0] : `${hosts[0]} (+${hosts.length - 1} more)`;
  const origin = entries.find((e) => e.origin)?.origin ?? `https://${hosts[0]}`;
  const capturedAt = entries.find((e) => e.startedAt)?.startedAt ?? '';

  const quiet = args.quiet || args.json;
  if (!quiet) {
    console.log('');
    console.log(`${bold('harspec')} ${dim(`v${VERSION}`)}`);
    console.log(`${dim('target   ')} ${target}`);
    console.log(
      `${dim('capture  ')} ${plural(entries.length, 'request', 'requests')} → ${plural(clusters.length, 'operation', 'operations')}`,
    );
    console.log('');
  }

  const document = buildOpenApi(clusters, entries, { title: args.title });
  const client = buildClient(clusters, origin);
  const summary = summariseDocument(document);

  const findings: Finding[] = [...passiveFindings(entries)];

  if (args.scanBundles) {
    const scanned = await scanBundles(entries, {
      onProgress: quiet ? undefined : (m) => console.log(dim(`  ${m}`)),
    });
    findings.push(...scanned);
  }

  if (args.replay) {
    const localHosts = entries.map((e) => e.host).filter((h) => h === 'localhost' || h === '127.0.0.1');
    const allowHosts = uniq(['localhost', '127.0.0.1', ...localHosts, ...args.allowHosts.filter(Boolean)]);

    if (!quiet) {
      const extra = args.allowHosts.filter(Boolean);
      console.log(
        dim(`  replay allowlist: localhost${extra.length ? `, ${extra.join(', ')}` : ' (use --allow-host for others)'}`),
      );
    }

    findings.push(
      ...(await activeFindings(clusters, {
        allowHosts,
        onProgress: quiet ? undefined : (m) => console.log(dim(`  ${m}`)),
      })),
    );
  }

  const sorted = sortFindings(findings);
  const outDir = resolve(args.out);
  mkdirSync(outDir, { recursive: true });

  writeFileSync(join(outDir, 'openapi.json'), `${JSON.stringify(document, null, 2)}\n`);
  writeFileSync(join(outDir, 'openapi.yaml'), toYaml(document));
  writeFileSync(join(outDir, 'client.ts'), client);
  writeFileSync(
    join(outDir, 'findings.json'),
    `${JSON.stringify({ target, capturedAt, findings: sorted }, null, 2)}\n`,
  );
  writeFileSync(
    join(outDir, 'report.md'),
    renderReportMarkdown({
      target,
      capturedAt,
      entries,
      operations: summary.operations,
      findings: sorted,
    }),
  );

  if (args.json) {
    console.log(
      JSON.stringify(
        {
          target,
          out: outDir,
          operations: summary.operations,
          paths: summary.paths,
          findings: sorted.map((f) => ({ severity: f.severity, title: f.title, id: f.id })),
        },
        null,
        2,
      ),
    );
    return 0;
  }

  if (args.quiet) {
    console.log(outDir);
    return 0;
  }

  console.log(
    `${green('✓')} ${bold('openapi.json')}  ${dim(`${plural(summary.paths, 'path', 'paths')}, ${plural(summary.operations, 'operation', 'operations')}`)}`,
  );
  console.log(`${green('✓')} ${bold('openapi.yaml')}`);
  console.log(`${green('✓')} ${bold('client.ts')}     ${dim(plural(clusters.length, 'method', 'methods'))}`);

  const counts = sorted.reduce<Record<string, number>>((acc, f) => {
    acc[f.severity] = (acc[f.severity] ?? 0) + 1;
    return acc;
  }, {});
  const summaryLine = ['critical', 'high', 'medium', 'low', 'info']
    .filter((s) => counts[s])
    .map((s) => `${counts[s]} ${s}`)
    .join(', ');

  console.log(
    `${green('✓')} ${bold('report.md')}     ${dim(sorted.length ? `${plural(sorted.length, 'finding', 'findings')} (${summaryLine})` : 'no findings')}`,
  );
  console.log('');

  for (const finding of sorted.slice(0, 10)) {
    const tag = severityColor[finding.severity](finding.severity.toUpperCase().padEnd(8));
    console.log(`  ${tag} ${finding.title}`);
  }
  if (sorted.length > 10) console.log(dim(`  … ${sorted.length - 10} more in report.md`));
  if (sorted.length) console.log('');

  console.log(dim(`  output: ${outDir}`));
  console.log('');

  return 0;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    console.error(red(`error: ${error?.stack ?? error}`));
    process.exitCode = 1;
  });
