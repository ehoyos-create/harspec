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

import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { captureSession, harFromEntries } from './capture.ts';
import { buildClient } from './client.ts';
import { clusterEntries, readHar, type Entry } from './har.ts';
import { buildOpenApi, summariseDocument } from './openapi.ts';
import { appSummary, deriveAppModel, writeApp } from './reproduce.ts';
import {
  observePage,
  rasterise,
  summariseEvidence,
  writeBriefPack,
  type Evidence,
} from './brief.ts';
import { passiveFindings, renderReportMarkdown, severityRank, type Finding } from './report.ts';
import { activeFindings } from './replay.ts';
import { scanBundles } from './scan.ts';
import { plural, uniq } from './util.ts';
import { analyseWeb, buildSkeletonOpenApi } from './web.ts';
import { toYaml } from './yaml.ts';

const VERSION = '0.1.0';

interface Args {
  mode: 'har' | 'web' | 'reproduce' | 'capture' | 'brief';
  input?: string;
  out: string;
  title?: string;
  replay: boolean;
  allowHosts: string[];
  scanBundles: boolean;
  interactive: boolean;
  seconds?: number;
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
    interactive: false,
    quiet: false,
    json: false,
    help: false,
    version: false,
  };

  let rest = argv;
  if (rest[0] === 'web') {
    args.mode = 'web';
    rest = rest.slice(1);
  } else if (rest[0] === 'reproduce') {
    args.mode = 'reproduce';
    rest = rest.slice(1);
  } else if (rest[0] === 'capture') {
    args.mode = 'capture';
    rest = rest.slice(1);
  } else if (rest[0] === 'brief') {
    args.mode = 'brief';
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
    else if (arg === '--interactive' || arg === '-i') args.interactive = true;
    else if (arg === '--seconds') args.seconds = Number(rest[++i] ?? 0) || undefined;
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
    '    harspec capture <url> [options]      drive your local browser, write a HAR',
    '    harspec reproduce <url|har>          generate a standalone app from the capture',
    '    harspec brief <url|har> [options]    write an evidence pack an agent rebuilds from',
    '',
    '  Options',
    '    -o, --out <dir>        Output directory (default: ./harspec-out)',
    '        --title <text>     Name for the generated app / API title',
    '    -i, --interactive      Open a visible browser and record while you use it',
    '        --seconds <n>      Hard stop for interactive capture (default: 300)',
    '        --scan-bundles     (har) Fetch the JS in the capture and scan it',
    '        --replay           (har) Replay captured writes with tampered fields (localhost by default)',
    '        --allow-host <h>   (har) Extend the replay allowlist (repeatable)',
    '    -q, --quiet            Only print the output directory',
    '        --json             Print the summary as JSON',
    '    -v, --version          Print version',
    '    -h, --help             Print this help',
    '',
    '  Modes',
    '    brief      Measures the rendered page — layout tree, tokens, screenshot,',
    '               controls — and writes a BRIEF.md for a coding agent to rebuild the',
    '               UI with original code. The evidence REA collects, for web apps.',
    '    reproduce  A URL or a HAR goes in; a standalone app comes out. Own server,',
    '               own UI, seeded from the capture. Nothing from the target is copied.',
    '    capture    Drives a local Chromium browser over the DevTools protocol and',
    '               writes a HAR. Use --interactive to browse and log in yourself.',
    '    web        Reads the HTML and JavaScript any anonymous visitor receives.',
    '               Finds endpoints, routes and leaked secrets. No schemas, because',
    '               it never calls the API.',
    '    har        Reads a capture of a real session, including authenticated calls.',
    '               Infers schemas, emits a typed client, and can generate an app.',
    '',
    '  How to capture a HAR',
    '    Chrome / Edge: DevTools → Network → right click → "Save all as HAR with content"',
    '    Firefox:       Network → gear icon → "Save All As HAR"',
    '    Safari:        Network → Export',
    '',
    '  Examples',
    '    harspec brief https://music.youtube.com -o pack/',
    '    harspec reproduce https://calendly.com/rick -o my-app',
    '    harspec reproduce https://example.com --interactive',
    '    harspec capture https://example.com -o session.har',
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
// Reproduce: capture → standalone app
// ---------------------------------------------------------------------------

async function loadEntries(args: Args, quiet: boolean): Promise<{ entries: Entry[]; label: string }> {
  const input = args.input as string;

  if (/^https?:\/\//i.test(input)) {
    const entries = await captureSession(input, {
      interactive: args.interactive,
      seconds: args.seconds,
      onProgress: quiet ? undefined : (m) => console.log(dim(`  ${m}`)),
    });
    return { entries, label: input };
  }

  const path = resolve(input);
  if (!existsSync(path)) throw new Error(`no such file: ${path}`);
  const entries = readHar(path);
  return { entries, label: entries[0]?.host ?? path };
}

function deriveAppName(entries: Entry[], fallbackHost: string): string {
  const document = entries.find((e) => e.kind === 'document' && e.resText);
  const raw = document?.resText.match(/<title[^>]*>([^<]*)</i)?.[1]?.trim() ?? '';

  // Titles are marketing copy: "Rick Pollak | Calendly" → "Rick Pollak".
  const cleaned = raw
    .split(/\s+[|·—–-]\s+/)
    .map((part) => part.trim())
    .filter(Boolean)
    .sort((a, b) => b.length - a.length)[0];

  const brand = fallbackHost
    .replace(/^https?:\/\//, '')
    .split('/')[0]
    .split(':')[0]
    .replace(/^www\./, '')
    .split('.')[0];

  const title = (cleaned ?? raw).replace(/\s+/g, ' ').trim();

  // A long headline ("Bring Your Idea Online With a Website") is not an app
  // name; the brand is the more useful default.
  if (title && title.length <= 32) return title;
  if (brand) return brand.charAt(0).toUpperCase() + brand.slice(1);
  return 'Rebuilt App';
}

async function runReproduce(args: Args): Promise<number> {
  const quiet = args.quiet || args.json;

  if (!quiet) {
    console.log('');
    console.log(`${bold('harspec')} ${dim(`v${VERSION} · reproduce`)}`);
  }

  let loaded: { entries: Entry[]; label: string };
  try {
    loaded = await loadEntries(args, quiet);
  } catch (error: any) {
    console.error(red(`error: ${error.message}`));
    return 1;
  }

  const { entries, label } = loaded;
  const clusters = clusterEntries(entries);
  if (!clusters.length) {
    console.error(red('error: no API requests found in the capture'));
    return 1;
  }

  const model = deriveAppModel(clusters, {
    name: args.title ?? deriveAppName(entries, label),
    documents: entries
      .filter((entry) => entry.kind === 'document' && entry.resText)
      .map((entry) => ({
        path: entry.pathname,
        html: entry.resText,
        title: entry.resText.match(/<title[^>]*>([^<]*)</i)?.[1]?.trim(),
      })),
  });

  if (!model.collections.length) {
    console.error(red('error: no resources with data were found, so there is nothing to rebuild'));
    console.error(dim('  the capture has endpoints, but none returned records we could model'));
    return 1;
  }

  const outDir = resolve(args.out);
  mkdirSync(outDir, { recursive: true });
  writeApp(model, outDir);

  if (args.json) {
    console.log(
      JSON.stringify(
        {
          mode: 'reproduce',
          app: model.name,
          out: outDir,
          source: label,
          collections: model.collections.map((c) => ({ key: c.key, records: c.items.length })),
          actions: model.actions.length,
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

  const source = (model.sourceHost || label).replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  console.log(`${dim('source   ')} ${source}`);
  console.log(`${dim('app      ')} ${model.name}`);
  console.log('');
  console.log(appSummary(model));
  console.log('');
  console.log(`${green('✓')} server.mjs      ${dim('own backend, seeded from the capture')}`);
  console.log(`${green('✓')} public/         ${dim('own UI, no framework, no dependencies')}`);
  console.log(`${green('✓')} README.md`);
  console.log('');
  console.log(`  run it:  ${bold(`cd ${outDir} && npm start`)}`);
  console.log(dim('  original code only: nothing from the target was copied'));
  console.log('');

  return 0;
}

// ---------------------------------------------------------------------------
// Capture: drive a local browser, write a HAR
// ---------------------------------------------------------------------------

async function runCapture(args: Args): Promise<number> {
  const quiet = args.quiet || args.json;
  const target = args.input as string;

  if (!/^https?:\/\//i.test(target)) {
    console.error(red('error: capture needs an http(s) URL'));
    return 1;
  }

  try {
    const entries = await captureSession(target, {
      interactive: args.interactive,
      seconds: args.seconds,
      onProgress: quiet ? undefined : (m) => console.log(dim(`  ${m}`)),
    });

    const outFile = args.out.endsWith('.har') ? args.out : join(args.out, 'session.har');
    mkdirSync(resolve(outFile, '..'), { recursive: true });

    writeFileSync(resolve(outFile), `${JSON.stringify(harFromEntries(entries, VERSION), null, 2)}\n`);

    if (args.json) {
      console.log(JSON.stringify({ mode: 'capture', target, out: resolve(outFile), requests: entries.length }, null, 2));
      return 0;
    }
    if (args.quiet) {
      console.log(resolve(outFile));
      return 0;
    }

    console.log('');
    console.log(`${green('✓')} captured ${plural(entries.length, 'request', 'requests')} → ${dim(outFile)}`);
    console.log(dim(`  next: harspec ${outFile}`));
    console.log('');
    return 0;
  } catch (error: any) {
    console.error(red(`error: ${error.message}`));
    return 1;
  }
}

// ---------------------------------------------------------------------------
// Brief: evidence pack for an agent to rebuild from
// ---------------------------------------------------------------------------

async function runBrief(args: Args): Promise<number> {
  const quiet = args.quiet || args.json;
  const target = args.input as string;
  const outDir = resolve(args.out);
  const progress = quiet ? undefined : (m: string) => console.log(dim(`  ${m}`));
  const onProgress = progress ?? (() => {});

  const isUrl = /^https?:\/\//i.test(target);
  if (!isUrl) {
    const path = resolve(target);
    if (!existsSync(path)) {
      console.error(red(`error: no such file: ${path}`));
      return 1;
    }
  }

  if (!quiet) {
    console.log('');
    console.log(`${bold('harspec')} ${dim(`v${VERSION} · brief`)}`);
  }

  let entries: Entry[] = [];
  let evidence: Evidence | undefined = undefined;
  let label = target;
  let captureError: Error | undefined;

  if (isUrl) {
    // A wedged renderer is real and not rare on heavy single-page apps. Two
    // tries with a fresh browser costs a minute and turns a dead run into a
    // usable pack; a single try turns it into a bug report.
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        entries = await captureSession(target, {
          interactive: args.interactive,
          seconds: args.seconds,
          onProgress: progress,
          observe: async (cdp) => {
            evidence = await observePage(cdp, onProgress);
          },
        });
        if (!evidence || evidence.nodes.length < 20) {
          throw new Error('the page rendered nothing measurable');
        }
        captureError = undefined;
        break;
      } catch (error: any) {
        captureError = error;
        evidence = undefined;
        if (attempt === 1) {
          if (!quiet) console.log(yellow(`  ${error.message} — retrying with a fresh browser`));
          continue;
        }
      }
    }

    if (captureError) {
      console.error(red(`error: ${captureError.message}`));
      console.error(dim('  try again, or use --interactive so the page loads in a real window'));
      return 1;
    }
  } else {
    try {
      entries = readHar(resolve(target));
      label = entries[0]?.host ?? target;
    } catch (error: any) {
      console.error(red(`error: ${error.message}`));
      return 1;
    }
  }

  const clusters = clusterEntries(entries);
  const model = deriveAppModel(clusters, {
    name: args.title ?? deriveAppName(entries, label),
    documents: entries
      .filter((entry) => entry.kind === 'document' && entry.resText)
      .map((entry) => ({
        path: entry.pathname,
        html: entry.resText,
        title: entry.resText.match(/<title[^>]*>([^<]*)</i)?.[1]?.trim(),
      })),
  });

  mkdirSync(outDir, { recursive: true });

  // A full-page PDF is the only capture path some browsers allow; turn it into
  // the PNG an agent (and a person) can actually look at.
  let screenshots: { full?: string; viewport?: string } | undefined;
  if (evidence?.screenshot?.pdf) {
    if (!quiet) console.log(dim(`  converting the page image`));
    const raster = await rasterise(evidence.screenshot.pdf, join(outDir, 'evidence'), {
      width: evidence.screenshot.width ?? evidence.meta.viewport.width,
      height: Math.min(evidence.meta.viewport.height, evidence.screenshot.height ?? 900),
    });
    screenshots = { full: raster.full, viewport: raster.viewport };
  } else if (evidence?.screenshot?.full) {
    // The compositor already gave us a PNG; write it as-is.
    const dir = join(outDir, 'evidence');
    mkdirSync(dir, { recursive: true });
    const full = join(dir, 'screenshot.png');
    writeFileSync(full, Buffer.from(evidence.screenshot.full, 'base64'));
    let viewport: string | undefined;
    if (evidence.screenshot.viewportBase64) {
      viewport = join(dir, 'viewport.png');
      writeFileSync(viewport, Buffer.from(evidence.screenshot.viewportBase64, 'base64'));
    }
    screenshots = { full, viewport };
  }
  // A screenshot of the first screen beats a crop of the tall image: the crop
  // is where fixed headers and sidebars disappear.
  if (evidence?.screenshot?.viewportBase64) {
    const viewportPath = join(outDir, 'evidence', 'viewport.png');
    mkdirSync(join(outDir, 'evidence'), { recursive: true });
    writeFileSync(viewportPath, Buffer.from(evidence.screenshot.viewportBase64, 'base64'));
    screenshots = { ...(screenshots ?? {}), viewport: viewportPath };
  }

  const written = writeBriefPack({
    label,
    outDir,
    evidence,
    appName: model.name,
    screenshots,
    collections: model.collections.map((collection) => ({
      key: collection.key,
      label: collection.label,
      fields: collection.fields.map((field) => field.name),
      items: collection.items,
    })),
    endpoints: clusters.map((cluster) => ({
      method: cluster.method,
      path: cluster.template,
      status: cluster.entries[0]?.status ?? 0,
      contentType: cluster.entries[0]?.mime ?? 'unknown',
    })),
  });

  if (args.json) {
    console.log(
      JSON.stringify(
        {
          mode: 'brief',
          out: outDir,
          source: label,
          app: model.name,
          files: written,
          evidence: evidence
            ? {
                nodes: evidence.nodes.length,
                interactions: evidence.interactions.length,
                images: evidence.images.length,
                viewport: evidence.meta.viewport,
                document: evidence.meta.document,
              }
            : null,
          collections: model.collections.map((c) => ({ key: c.key, records: c.items.length })),
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
  if (evidence) {
    for (const line of summariseEvidence(evidence)) console.log(`  ${line}`);
    console.log('');
  } else {
    console.log(yellow('  no page evidence: this pack came from a HAR, so there is no layout,'));
    console.log(yellow('  no screenshot and no computed styles — only traffic and data.'));
    console.log('');
  }
  console.log(`  ${green('✓')} ${plural(model.collections.length, 'collection', 'collections')}, ${plural(
    model.collections.reduce((sum, c) => sum + c.items.length, 0),
    'record',
    'records',
  )}, ${plural(clusters.length, 'endpoint', 'endpoints')}`);
  console.log('');
  for (const file of written) console.log(`  ${dim('·')} ${file}`);
  console.log('');
  console.log(`  open:  ${bold(outDir)}/BRIEF.md`);
  console.log(dim('  point a coding agent at that folder; it has the evidence, not the answer'));
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

  return args.mode === 'web'
    ? runWeb(args)
    : args.mode === 'reproduce'
      ? runReproduce(args)
      : args.mode === 'capture'
        ? runCapture(args)
        : args.mode === 'brief'
          ? runBrief(args)
          : runHar(args);
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    console.error(red(`error: ${error?.stack ?? error}`));
    process.exitCode = 1;
  });
