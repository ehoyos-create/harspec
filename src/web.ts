/**
 * Public-surface analysis: URL in, no session, no HAR, no browser.
 *
 * What it can know without a login is bounded and this module is honest about
 * it: it reads the HTML you would get as an anonymous visitor, plus the
 * JavaScript that page already ships to everyone. From that it derives the
 * endpoint surface, UI routes, third-party hosts and credential leaks.
 *
 * It cannot see authenticated endpoints or response schemas. That is what the
 * HAR mode is for.
 */

import type { Entry } from './har.ts';
import { templatize } from './har.ts';
import { passiveFindings, type Finding } from './report.ts';
import { inspectSource, sourceMapResolves } from './scan.ts';
import { plural, uniq } from './util.ts';
const CDN_HOSTS = [
  'fonts.googleapis.com',
  'fonts.gstatic.com',
  'cdn.jsdelivr.net',
  'unpkg.com',
  'cdnjs.cloudflare.com',
  'ajax.googleapis.com',
  'googletagmanager.com',
  'google-analytics.com',
  'segment.com',
  'sentry.io',
  'sentry-cdn.com',
  'stripe.com',
  'js.stripe.com',
  'cloudflare.com',
  'gstatic.com',
  'facebook.net',
  'hotjar.com',
  'intercom.io',
  'clarity.ms',
];

const API_PATH_RX = /\/(?:api|v\d+|graphql|gql|rest|rpc|internal|_next\/data)\/[A-Za-z0-9_\-.{}$/%:]*/g;
const ROUTE_PATH_RX = /(?:path|to|href|redirect)\s*:\s*["'](\/[A-Za-z0-9_\-\/:.{}]*)["']/g;
const FULL_URL_RX = /https?:\/\/[A-Za-z0-9.\-]+(?::\d+)?(?:\/[A-Za-z0-9_\-.{}$/%:?=&]*)?/g;
const GRAPHQL_RX = /(?:query|mutation|subscription)\s+[A-Za-z0-9_]+\s*(?:\(|\{)/;
const AUTH_RX = /(?:authorization|bearer\s+|x-api-key|localStorage\.(?:get|set)Item\(\s*["'](?:token|jwt|access_token|id_token))/i;

export interface Endpoint {
  path: string;
  kind: 'api' | 'route';
  sources: string[];
}

export interface WebAnalysis {
  url: string;
  finalUrl: string;
  title: string;
  frameworks: string[];
  entries: Entry[];
  endpoints: Endpoint[];
  apiEndpoints: Endpoint[];
  routes: Endpoint[];
  hosts: string[];
  authSignals: boolean;
  graphql: boolean;
  findings: Finding[];
  surfaceMarkdown: string;
}

const ASSET_RX = /\.(js|mjs|css|png|jpe?g|gif|svg|webp|avif|ico|woff2?|ttf|eot|mp4|webm|map|txt|xml)$/i;

function normalizePath(raw: string): string | undefined {
  let path = raw.trim();
  if (!path.startsWith('/')) return undefined;
  path = path.replace(/\$\{[^}]*\}/g, '{id}');
  path = path.split('?')[0].split('#')[0];
  path = path.replace(/\/{2,}/g, '/');
  if (path.length > 1) path = path.replace(/\/$/, '');
  if (path.length < 2 || path.length > 140) return undefined;
  if (ASSET_RX.test(path)) return undefined;
  if (/\s/.test(path)) return undefined;
  return path;
}

function isApiPath(path: string): boolean {
  return /^\/(api|v\d+|graphql|gql|rest|rpc|internal|_next\/data)\b/i.test(path);
}

function isHostNoise(host: string): boolean {
  return CDN_HOSTS.some((cdn) => host === cdn || host.endsWith(`.${cdn}`));
}

async function fetchEntry(url: string, kind: string): Promise<{ entry: Entry; text: string } | undefined> {
  const started = new Date();
  const t0 = Date.now();
  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(15_000),
      headers: {
        'user-agent': 'harspec/0.1 (+https://github.com/harspec)',
        accept: 'text/html,application/xhtml+xml,application/javascript,*/*;q=0.8',
      },
      redirect: 'follow',
    });
    const text = await response.text();
    const headers: Record<string, string> = {};
    response.headers.forEach((value, name) => {
      if (name.toLowerCase() === 'set-cookie') {
        headers[name] = `${headers[name] ? `${headers[name]}, ` : ''}${value}`;
        return;
      }
      headers[name] = value;
    });

    const parsed = new URL(url);
    const entry: Entry = {
      index: 0,
      method: 'GET',
      url,
      host: parsed.host,
      origin: `${parsed.protocol}//${parsed.host}`,
      pathname: parsed.pathname,
      query: Object.fromEntries(parsed.searchParams.entries()),
      status: response.status,
      kind,
      mime: response.headers.get('content-type') ?? '',
      reqHeaders: {},
      resHeaders: headers,
      reqBody: undefined,
      resBody: undefined,
      resText: text,
      timeMs: Date.now() - t0,
      startedAt: started.toISOString(),
    };
    return { entry, text };
  } catch {
    return undefined;
  }
}

function detectFrameworks(html: string, scripts: string[]): string[] {
  const haystack = `${html}\n${scripts.join('\n')}`;
  const checks: Array<[string, RegExp]> = [
    ['Next.js', /__NEXT_DATA__|\/_next\//],
    ['Nuxt', /__NUXT__|\/_nuxt\//],
    ['Remix', /__remixContext|__remixManifest/],
    ['Astro', /\/_astro\//],
    ['SvelteKit', /data-sveltekit|__sveltekit/],
    ['Angular', /ng-version|angular\.min\.js|\/runtime\.[a-f0-9]+\.js/],
    ['Vue', /vue(?:\.runtime)?(?:\.global)?(?:\.prod)?\.js|__VUE__/i],
    ['React', /react-dom|data-reactroot|__REACT_DEVTOOLS/],
    ['Shopify', /cdn\.shopify\.com|\/cdn\/shop\//],
    ['WordPress', /wp-content|wp-includes/],
  ];
  return checks.filter(([, rx]) => rx.test(haystack)).map(([name]) => name);
}

function extractScripts(html: string, base: string): string[] {
  const urls: string[] = [];
  const rx = /<script[^>]+src=["']([^"']+)["']/gi;
  let match: RegExpExecArray | null;
  while ((match = rx.exec(html))) {
    try {
      urls.push(new URL(match[1], base).toString());
    } catch {
      // ignore malformed
    }
  }

  const preload = /<link[^>]+rel=["'](?:modulepreload|preload)["'][^>]+href=["']([^"']+)["']/gi;
  while ((match = preload.exec(html))) {
    try {
      const url = new URL(match[1], base);
      if (/\.(js|mjs)$/.test(url.pathname)) urls.push(url.toString());
    } catch {
      // ignore
    }
  }

  return uniq(urls);
}

export async function analyseWeb(
  rawUrl: string,
  options: { maxScripts?: number; onProgress?: (message: string) => void } = {},
): Promise<WebAnalysis> {
  const url = /^https?:\/\//i.test(rawUrl) ? rawUrl : `https://${rawUrl}`;
  const onProgress = options.onProgress ?? (() => {});

  onProgress(`fetching ${url}`);
  const page = await fetchEntry(url, 'document');
  if (!page) throw new Error(`could not fetch ${url}`);
  if (page.entry.status >= 400) throw new Error(`${url} responded with HTTP ${page.entry.status}`);

  const html = page.text;
  const finalUrl = page.entry.url;
  const finalHostname = new URL(finalUrl).hostname;
  const pageLabel = new URL(finalUrl).pathname.split('/').filter(Boolean).pop() ?? 'index.html';
  const title = (html.match(/<title[^>]*>([^<]*)</i)?.[1] ?? '').trim();
  const scripts = extractScripts(html, finalUrl).slice(0, options.maxScripts ?? 10);

  const entries: Entry[] = [{ ...page.entry, index: 0 }];
  const findings: Finding[] = [];
  let authSignals = false;
  let graphql = false;

  const endpointMap = new Map<string, Endpoint>();
  const routeMap = new Map<string, Endpoint>();
  const hosts = new Set<string>();

  const addEndpoint = (rawPath: string, source: string) => {
    const normalized = normalizePath(rawPath);
    if (!normalized) return;
    const path = templatize(normalized).template;
    const api = isApiPath(path);
    const map = api ? endpointMap : routeMap;
    const existing = map.get(path);
    if (existing) {
      if (!existing.sources.includes(source)) existing.sources.push(source);
    } else {
      map.set(path, { path, kind: api ? 'api' : 'route', sources: [source] });
    }
  };

  const inspect = (source: string, sourceUrl: string) => {
    const name = sourceUrl.split('/').pop() ?? sourceUrl;

    const apiMatches = source.match(API_PATH_RX) ?? [];
    for (const raw of apiMatches) addEndpoint(raw, name);

    const routeMatches = [...source.matchAll(ROUTE_PATH_RX)].map((m) => m[1]);
    for (const raw of routeMatches) addEndpoint(raw, name);

    for (const raw of source.match(FULL_URL_RX) ?? []) {
      try {
        const parsed = new URL(raw);
        if (!isHostNoise(parsed.hostname) && parsed.hostname !== finalHostname) {
          hosts.add(parsed.hostname);
        }
        if (isApiPath(parsed.pathname)) addEndpoint(parsed.pathname, name);
      } catch {
        // ignore
      }
    }

    if (GRAPHQL_RX.test(source)) graphql = true;
    if (AUTH_RX.test(source)) authSignals = true;
  };

  inspect(html, pageLabel);

  // UI routes from real anchors: cheap, accurate, and works on every framework.
  for (const match of html.matchAll(/<a[^>]+href=["']([^"'#?]+)["']/g)) {
    const href = match[1];
    if (!href.startsWith('/') || href.startsWith('//')) continue;
    addEndpoint(href, pageLabel);
  }

  let index = 1;
  for (const scriptUrl of scripts) {
    onProgress(`reading ${scriptUrl.split('/').pop()}`);
    const script = await fetchEntry(scriptUrl, 'script');
    if (!script) continue;
    const entry = { ...script.entry, index };
    index += 1;
    entries.push(entry);
    inspect(script.text, scriptUrl);
    findings.push(...inspectSource(script.text, scriptUrl, entries));
  }

  // Confirm at least one source map actually resolves; a reference alone is a
  // hint, a resolvable map is a finding you can act on.
  for (const entry of entries) {
    if (!entry.resText.includes('sourceMappingURL')) continue;
    const ref = entry.resText.match(/[#@]\s*sourceMappingURL=(\S+)/)?.[1];
    if (!ref) continue;
    try {
      const mapUrl = new URL(ref, entry.url).toString();
      if (await sourceMapResolves(mapUrl)) {
        findings.push({
          id: `sourcemap-confirmed/${entry.url}`,
          severity: 'critical',
          title: 'Exposed source map resolves publicly',
          evidence: `${mapUrl} returns content`,
          impact: 'The original source, comments included, can be downloaded by anyone.',
          remediation: 'Stop serving .map files in production.',
          entries: [entry.index],
        });
      }
    } catch {
      // ignore
    }
  }

  // A confirmed, resolvable map supersedes the "referenced" hint for that file.
  const confirmedMaps = new Set(
    findings
      .filter((f) => f.id.startsWith('sourcemap-confirmed/'))
      .map((f) => f.id.slice('sourcemap-confirmed/'.length)),
  );

  const hints = findings.filter((f) => f.id.startsWith('sourcemap/'));
  const rest = findings.filter((f) => !f.id.startsWith('sourcemap/'));

  findings.length = 0;
  findings.push(...rest);

  // One aggregate hint instead of one finding per chunk: a page with 40 bundles
  // should not produce 40 identical warnings.
  if (!confirmedMaps.size && hints.length) {
    const files = hints.map((h) => h.id.replace('sourcemap/', '').split('/').pop() ?? '');
    findings.push({
      id: 'sourcemap/referenced',
      severity: 'medium',
      title: `${plural(hints.length, 'bundle', 'bundles')} reference a source map`,
      evidence: `${files.slice(0, 3).join(', ')}${files.length > 3 ? `, +${files.length - 3} more` : ''} — none of them resolved`,
      impact:
        'The reference is a hint, not proof: these maps did not return content. But a deploy with the maps included would expose the original source.',
      remediation: 'Verify .map files are not served in production.',
      entries: hints.flatMap((h) => h.entries),
    });
  }

  findings.push(...passiveFindings(entries));

  const apiEndpoints = [...endpointMap.values()].sort((a, b) => a.path.localeCompare(b.path));
  const routes = [...routeMap.values()].sort((a, b) => a.path.localeCompare(b.path));
  const frameworks = detectFrameworks(html, scripts);

  const surfaceMarkdown = renderSurface({
    url: finalUrl,
    title,
    frameworks,
    entries,
    apiEndpoints,
    routes,
    hosts: [...hosts].sort(),
    authSignals,
    graphql,
    findings,
  });

  return {
    url,
    finalUrl,
    title,
    frameworks,
    entries,
    endpoints: [...apiEndpoints, ...routes],
    apiEndpoints,
    routes,
    hosts: [...hosts].sort(),
    authSignals,
    graphql,
    findings,
    surfaceMarkdown,
  };
}

function renderSurface(input: {
  url: string;
  title: string;
  frameworks: string[];
  entries: Entry[];
  apiEndpoints: Endpoint[];
  routes: Endpoint[];
  hosts: string[];
  authSignals: boolean;
  graphql: boolean;
  findings: Finding[];
}): string {
  const lines: string[] = [];
  lines.push(`# Public surface: ${input.url}`);
  lines.push('');
  lines.push(
    `${input.title ? `**${input.title}** · ` : ''}${input.entries.length} resources read · ${input.apiEndpoints.length} API paths · ${input.routes.length} UI routes`,
  );
  lines.push('');
  lines.push(
    '> Static analysis only. Everything below was extracted from HTML and JavaScript that any anonymous visitor receives. No request was made to the API itself, and nothing behind a login is visible.',
  );
  lines.push('');

  lines.push('## Stack');
  lines.push('');
  lines.push(input.frameworks.length ? input.frameworks.join(', ') : 'Not identified');
  lines.push('');

  lines.push(`## API paths (${input.apiEndpoints.length})`);
  lines.push('');
  if (input.apiEndpoints.length) {
    lines.push('| Path | Found in |');
    lines.push('|---|---|');
    for (const endpoint of input.apiEndpoints.slice(0, 60)) {
      lines.push(`| \`${endpoint.path}\` | ${endpoint.sources.slice(0, 2).join(', ')} |`);
    }
    if (input.apiEndpoints.length > 60) lines.push(`| … ${input.apiEndpoints.length - 60} more | |`);
  } else {
    lines.push('No API paths found in the shipped JavaScript. The app may build them dynamically.');
  }
  lines.push('');

  lines.push(`## UI routes (${input.routes.length})`);
  lines.push('');
  if (input.routes.length) {
    for (const route of input.routes.slice(0, 40)) lines.push(`- \`${route.path}\``);
    if (input.routes.length > 40) lines.push(`- … ${input.routes.length - 40} more`);
  } else {
    lines.push('None detected.');
  }
  lines.push('');

  if (input.hosts.length) {
    lines.push('## Third-party hosts');
    lines.push('');
    for (const host of input.hosts.slice(0, 25)) lines.push(`- \`${host}\``);
    lines.push('');
  }

  lines.push('## Signals');
  lines.push('');
  lines.push(`- Auth tokens handled in client code: ${input.authSignals ? 'yes' : 'not detected'}`);
  lines.push(`- GraphQL operations in bundle: ${input.graphql ? 'yes' : 'not detected'}`);
  lines.push(`- Source maps: ${input.entries.some((e) => e.resText.includes('sourceMappingURL')) ? 'referenced' : 'none seen'}`);
  lines.push(`- Findings: ${input.findings.length}`);
  lines.push('');

  lines.push('## What this cannot see');
  lines.push('');
  lines.push('- Request and response schemas, because no API call was made.');
  lines.push('- Anything behind authentication.');
  lines.push('- Runtime-generated URLs, which appear only after user interaction.');
  lines.push('');
  lines.push('Capture a HAR of the flow you care about and run `harspec <file.har>` for the full picture.');
  lines.push('');

  return lines.join('\n');
}

export function buildSkeletonOpenApi(analysis: WebAnalysis): any {
  const paths: Record<string, any> = {};

  for (const endpoint of analysis.apiEndpoints) {
    paths[endpoint.path] = {
      get: {
        operationId: `get${endpoint.path.replace(/[^A-Za-z0-9]+(.)?/g, (_, c) => (c ? c.toUpperCase() : ''))}`,
        summary: `Discovered statically in ${endpoint.sources[0] ?? 'the bundle'}`,
        description:
          'Path found in shipped client code. Method and schema are unknown until the endpoint is exercised and captured.',
        'x-harspec-source': endpoint.sources.join(', '),
        responses: {
          default: { description: 'Not observed. Capture traffic to this endpoint to infer the contract.' },
        },
      },
    };
  }

  return {
    openapi: '3.1.0',
    info: {
      title: `Public surface of ${analysis.finalUrl}`,
      version: '0.0.0-static',
      description:
        'Static skeleton generated by harspec web. Paths were extracted from client code; no request was executed, so no parameters or schemas are described.',
    },
    servers: [{ url: new URL(analysis.finalUrl).origin }],
    paths,
    'x-harspec-mode': 'static',
  };
}
