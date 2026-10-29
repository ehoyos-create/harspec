/**
 * HAR parsing and normalization.
 *
 * A HAR file is just JSON: `log.entries[]` with request/response pairs.
 * Everything downstream works on the normalized `Entry` shape below, so a HAR
 * recorded by Chrome, Firefox, Safari, mitmproxy or our own recorder all look
 * the same to the rest of the pipeline.
 */

import { readFileSync } from 'node:fs';
import { hostOf, isObject, tryJson, uniq } from './util.ts';

export interface Entry {
  index: number;
  method: string;
  url: string;
  host: string;
  origin: string;
  pathname: string;
  query: Record<string, string>;
  status: number;
  kind: string; // xhr | fetch | script | document | other
  mime: string;
  reqHeaders: Record<string, string>;
  resHeaders: Record<string, string>;
  reqBody: any;
  resBody: any;
  resText: string;
  timeMs: number;
  startedAt: string;
}

export interface Cluster {
  key: string;
  method: string;
  template: string;
  pathParams: string[];
  entries: Entry[];
  origin: string;
}

const ID_SEGMENT = [
  /^\d+$/, // 42
  /^\d{4,}$/, // 12345
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, // uuid
  /^[0-9a-f]{16,}$/i, // long hex
  /^[A-Za-z0-9_-]{24,}$/, // opaque token-ish
];

function isIdLike(segment: string): boolean {
  return ID_SEGMENT.some((rx) => rx.test(segment));
}

/**
 * Turn a concrete path into a template. Conservative on purpose: a slug like
 * `/products/blue-shoes` stays literal rather than being guessed as an id, which
 * keeps us from merging unrelated endpoints.
 */
export function templatize(pathname: string): { template: string; params: string[] } {
  const segments = pathname.split('/').filter(Boolean);
  const params: string[] = [];
  let counter = 0;
  const out = segments.map((segment) => {
    if (!isIdLike(segment)) return segment;
    counter += 1;
    const name = counter === 1 ? 'id' : `id${counter}`;
    params.push(name);
    return `{${name}}`;
  });
  return { template: `/${out.join('/')}` || '/', params };
}

function headersToObject(list: any[]): Record<string, string> {
  const out: Record<string, string> = {};
  if (!Array.isArray(list)) return out;
  for (const h of list) {
    if (!h || typeof h.name !== 'string') continue;
    out[h.name.toLowerCase()] = String(h.value ?? '');
  }
  return out;
}

function kindOf(entry: any, mime: string): string {
  const resourceType = String(entry?._resourceType ?? '').toLowerCase();
  if (resourceType) return resourceType;
  const url = String(entry?.request?.url ?? '');
  if (/\.(js|mjs)(\?|$)/.test(url) || mime.includes('javascript')) return 'script';
  if (mime.includes('text/html')) return 'document';
  if (mime.includes('json')) return 'xhr';
  return 'other';
}

export function parseHar(raw: any): Entry[] {
  const entries: any[] = raw?.log?.entries ?? raw?.entries ?? [];
  if (!Array.isArray(entries)) {
    throw new Error('Not a HAR file: missing log.entries[]');
  }

  const parsed: Entry[] = [];
  entries.forEach((entry, index) => {
    const request = entry?.request ?? {};
    const response = entry?.response ?? {};
    const url = String(request.url ?? '');
    if (!url) return;

    let parsedUrl: URL;
    try {
      parsedUrl = new URL(url);
    } catch {
      return;
    }

    const query: Record<string, string> = {};
    for (const [k, v] of parsedUrl.searchParams.entries()) query[k] = v;

    const resContent = response?.content ?? {};
    const resText = typeof resContent.text === 'string' ? resContent.text : '';
    const mime = String(resContent.mimeType ?? '');
    const reqText = String(request?.postData?.text ?? '');
    const reqMime = String(request?.postData?.mimeType ?? '');

    parsed.push({
      index,
      method: String(request.method ?? 'GET').toUpperCase(),
      url,
      host: hostOf(url),
      origin: `${parsedUrl.protocol}//${parsedUrl.host}`,
      pathname: parsedUrl.pathname || '/',
      query,
      status: Number(response?.status ?? 0),
      kind: kindOf(entry, mime),
      mime,
      reqHeaders: headersToObject(request?.headers ?? []),
      resHeaders: headersToObject(response?.headers ?? []),
      reqBody: tryJson(reqText) ?? (reqText && reqMime.includes('json') ? reqText : undefined),
      resBody: tryJson(resText) ?? (resText && mime.includes('json') ? resText : undefined),
      resText,
      timeMs: Number(entry?.time ?? 0),
      startedAt: String(entry?.startedDateTime ?? ''),
    });
  });

  return parsed;
}

export function readHar(file: string): Entry[] {
  const raw = JSON.parse(readFileSync(file, 'utf8'));
  return parseHar(raw);
}

const STATIC_ASSET = /\.(png|jpe?g|gif|svg|webp|avif|ico|woff2?|ttf|eot|css|mp4|webm|map)(\?|$)/i;

/** Entries that describe an API surface, not page furniture. */
export function apiEntries(entries: Entry[]): Entry[] {
  return entries.filter((e) => {
    const path = e.pathname + (Object.keys(e.query).length ? '?x' : '');
    if (STATIC_ASSET.test(path)) return false;
    if (e.kind === 'document' || e.kind === 'script' || e.kind === 'stylesheet') return false;
    return true;
  });
}

/**
 * Group API entries by (method, path template). Two calls to `/users/1` and
 * `/users/2` collapse into one operation with a path parameter.
 */
export function clusterEntries(entries: Entry[]): Cluster[] {
  const map = new Map<string, Cluster>();

  for (const entry of apiEntries(entries)) {
    const { template, params } = templatize(entry.pathname);
    const key = `${entry.method} ${template}`;
    let cluster = map.get(key);
    if (!cluster) {
      cluster = {
        key,
        method: entry.method,
        template,
        pathParams: params,
        entries: [],
        origin: entry.origin,
      };
      map.set(key, cluster);
    }
    cluster.entries.push(entry);
  }

  return [...map.values()].sort((a, b) => a.key.localeCompare(b.key));
}

export function queryParamNames(cluster: Cluster): string[] {
  return uniq(cluster.entries.flatMap((e) => Object.keys(e.query))).sort();
}

export function statusCodes(cluster: Cluster): number[] {
  return uniq(cluster.entries.map((e) => e.status)).sort((a, b) => a - b);
}

export function hasRequestBody(cluster: Cluster): boolean {
  return cluster.entries.some((e) => isObject(e.reqBody) || Array.isArray(e.reqBody));
}
