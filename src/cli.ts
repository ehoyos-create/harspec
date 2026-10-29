#!/usr/bin/env node
/**
 * harspec — turn web apps into an API spec, a typed client and a risk report.
 *
 * Two modes:
 *   harspec <capture.har>        full pipeline from recorded traffic
 *   harspec web <url>            public surface, no session, no browser
 *
 * The core is deterministic: same input in, same files out. No model calls.
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
import { analyseWeb, buildSkeletonOpenApi } from './web.ts';
import { toYaml } from './yaml.ts';

const VERSION = '0.1.0';

interface Args {
  mode: 'har' | 'web';
  input?: string;
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
    mode: 'har',
    out: 'harspec-out',
    replay: false,
    allowHosts: [],
    scanBundles: false,
    quiet: false,
    json: false,
    help: false,
    version: false,
  };

  let rest = argv;
  if (rest[0] === 'web') {
    args.mode = 'web';
    rest = rest.slice(1);
  }

  const positionals: string[] = [];
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (arg === '-h' || arg === '--help') args.help = true;
    else if (arg === '-v' || arg === '--version') args.version = true;
    else if (arg === '-o' || arg === '--out') args.out = rest[++i] ?? args.out;
    else if (arg === '--title') args.title = rest[++i];
    else if (arg === '--replay') args.replay = true;
    else if (arg === '--allow-host') args.allowHosts.push(rest[++i] ?? '');
    else if (arg === '--scan-bundles') args.scanBundles = true;
    else if (arg === '--quiet' || arg === '-q') args.quiet = true;
    else if (arg === '--json') args.json = true;
    else if (arg.startsWith('-')) throw new Error(`Unknown option: ${arg}`);
    else positionals.push(arg);
  }

  args.input = positionals[0];
  return args;
}

function help(): string {
  return [
    '',
    '  harspec — web app → API spec, typed client, risk report',
    '',
    '  Usage',
    '    harspec <capture.har> [options]      full pipeline from recorded traffic',
    '    harspec web <url> [options]          public surface, no session, no browser',
    '',
    '  Options',
    '    -o, --out <dir>        Output directory (default: ./harspec-out)',
    '        --title <text>     API title used in the spec',
    '        --scan-bundles     (har) Fetch the JS in the capture and scan it',
    '        --replay           (har) Replay captured writes with tampered fields (localhost by default)',
    '        --allow-host <h>   (har) Extend the replay allowlist (repeatable)',
    '    -q, --quiet            Only print the output directory',
    '        --json             Print the summary as JSON',
    '    -v, --version          Print version',
    '    -h, --help             Print this help',
    '',
    '  Two modes, one honest difference',
    '    web     Reads the HTML and JavaScript any anonymous visitor receives.',
    '            Finds endpoints, routes and leaked secrets. No schemas, because',
    '            it never calls the API.',
    '    har     Reads a capture of a real session, including authenticated calls.',
    '            Infers schemas and emits a typed client that actually runs.',
    '',
    '  How to capture a HAR',
    '    Chrome / Edge: DevTools → Network → right click → "Save all as HAR with content"',
    '    Firefox:       Network → gear icon → "Save All As HAR"',
    '    Safari:        Network → Export',
    '',
    '  Examples',
    '    harspec web https://app.example.com',
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

function printFindings(findings: Finding[]) {
  for (const finding of findings.slice(0, 10)) {
    const tag = severityColor[finding.severity](finding.severity.toUpperCase().padEnd(8));
    console.log(`  ${tag} ${finding.title}`);
  }
  if (findings.length > 10) console.log(dim(`  … ${findings.length - 10} more in report.md`));
}

function findingsLine(findings: Finding[]): string {
  if (!findings.length) return 'no findings';
  const counts = findings.reduce<Record<string, number>>((acc, f) => {
    acc[f.severity] = (acc[f.severity] ?? 0) + 1;
    return acc;
  }, {});
  const detail = ['critical', 'high', 'medium', 'low', 'info']
    .filter((s) => counts[s])
    .map((s) => `${counts[s]} ${s}`)
    .join(', ');
  return `${plural(findings.length, 'finding', 'findings')} (${detail})`;
}

function writeReport(outDir: string, input: {
  target: string;
  capturedAt: string;
  entries: Entry[];
  operations: number;
  findings: Finding[];
}) {
  writeFileSync(join(outDir, 'report.md'), renderReportMarkdown(input));
  writeFileSync(
    join(outDir, 'findings.json'),
    `${JSON.stringify({ target: input.target, findings: sortFindings(input.findings) }, null, 2)}\n`,
  );
}

// ---------------------------------------------------------------------------
// HAR mode: full pipeline
// ---------------------------------------------------------------------------

async function runHar(args: Args): Promise<number> {
  const harPath = resolve(args.input as string);
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
    findings.push(
      ...(await scanBundles(entries, { onProgress: quiet ? undefined : (m) => console.log(dim(`  ${m}`)) })),
    );
  }

  if (args.replay) {
    const localHosts = entries.map((e) => e.host).filter((h) => h === 'localhost' || h === '127.0.0.1');
    const allowHosts = uniq(['localhost', '127.0.0.1', ...localHosts, ...args.allowHosts.filter(Boolean)]);
    if (!quiet) {
      console.log(dim('  replay allowlist: localhost (use --allow-host for others)'));
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
  writeReport(outDir, { target, capturedAt, entries, operations: summary.operations, findings: sorted });

  if (args.json) {
    console.log(
      JSON.stringify(
        {
          mode: 'har',
          target,
          out: outDir,
          paths: summary.paths,
          operations: summary.operations,
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
  console.log(`${green('✓')} ${bold('report.md')}     ${dim(findingsLine(sorted))}`);
  console.log('');
  if (sorted.length) {
    printFindings(sorted);
    console.log('');
  }
  console.log(dim(`  output: ${outDir}`));
  console.log('');

  return 0;
}

// ---------------------------------------------------------------------------
// Web mode: public surface, no session
// ---------------------------------------------------------------------------

async function runWeb(args: Args): Promise<number> {
  const quiet = args.quiet || args.json;
  const target = args.input as string;

  let analysis;
  try {
    analysis = await analyseWeb(target, {
      onProgress: quiet ? undefined : (m) => console.log(dim(`  ${m}`)),
    });
  } catch (error: any) {
    console.error(red(`error: ${error.message}`));
    return 1;
  }

  const sorted = sortFindings(analysis.findings);
  const document = buildSkeletonOpenApi(analysis);
  const outDir = resolve(args.out);
  mkdirSync(outDir, { recursive: true });

  writeFileSync(join(outDir, 'surface.md'), analysis.surfaceMarkdown);
  writeFileSync(join(outDir, 'openapi.json'), `${JSON.stringify(document, null, 2)}\n`);
  writeFileSync(join(outDir, 'openapi.yaml'), toYaml(document));
  writeReport(outDir, {
    target: analysis.finalUrl,
    capturedAt: analysis.entries[0]?.startedAt ?? '',
    entries: analysis.entries,
    operations: analysis.apiEndpoints.length,
    findings: sorted,
  });

  if (args.json) {
    console.log(
      JSON.stringify(
        {
          mode: 'web',
          target: analysis.finalUrl,
          out: outDir,
          frameworks: analysis.frameworks,
          apiPaths: analysis.apiEndpoints.length,
          routes: analysis.routes.length,
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

  console.log('');
  console.log(`${bold('harspec')} ${dim(`v${VERSION} · static mode (no session)`)}`);
  console.log(`${dim('url      ')} ${analysis.finalUrl}`);
  console.log(`${dim('stack    ')} ${analysis.frameworks.join(', ') || 'not identified'}`);
  console.log(
    `${dim('read     ')} ${plural(analysis.entries.length, 'resource', 'resources')} · ${plural(analysis.apiEndpoints.length, 'API path', 'API paths')} · ${plural(analysis.routes.length, 'UI route', 'UI routes')}`,
  );
  console.log('');
  console.log(`${green('✓')} ${bold('surface.md')}    ${dim('what the public bundle reveals')}`);
  console.log(`${green('✓')} ${bold('openapi.json')}  ${dim(`${plural(analysis.apiEndpoints.length, 'path', 'paths')} (skeleton, no schemas)`)}`);
  console.log(`${green('✓')} ${bold('openapi.yaml')}`);
  console.log(`${green('✓')} ${bold('report.md')}     ${dim(findingsLine(sorted))}`);
  console.log('');

  if (sorted.length) {
    printFindings(sorted);
    console.log('');
  }

  console.log(
    dim(
      '  static mode cannot see schemas or authenticated routes. capture a HAR for the full pipeline.',
    ),
  );
  console.log(dim(`  output: ${outDir}`));
  console.log('');

  return 0;
}

// ---------------------------------------------------------------------------

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
  if (!args.input) {
    console.log(help());
    return 1;
  }

  return args.mode === 'web' ? runWeb(args) : runHar(args);
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    console.error(red(`error: ${error?.stack ?? error}`));
    process.exitCode = 1;
  });
