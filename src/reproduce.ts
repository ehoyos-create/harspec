/**
 * Reproduce: turn a capture into a standalone app.
 *
 * The output is original code. Nothing from the target is copied — no HTML, no
 * CSS, no bundle, no identifiers. The capture is used as a specification: which
 * resources exist, what they look like, and what a real response contains.
 *
 * The generated app is a Node server plus a small SPA, with an in-memory
 * database seeded from the capture, so it runs with no external backend.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Cluster } from './har.ts';
import { isObject, pascalCase, stableStringify, titleCase } from './util.ts';

export interface Field {
  name: string;
  type: 'string' | 'number' | 'boolean' | 'object' | 'array';
  example: any;
}

export interface Collection {
  key: string; // base path, e.g. /api/products
  name: string; // products
  label: string; // Products
  items: any[];
  fields: Field[];
  wrapper?: string; // when the list response nests items under a key ('data.items')
  single?: boolean; // the endpoint returns one record, not a list
  readPost?: boolean; // the list is fetched with POST, not GET
  page?: boolean; // records scraped out of the page HTML, not an API
  listTemplate: string;
  itemTemplate?: string;
}

export interface Action {
  method: string;
  template: string;
  status: number;
  body: any;
  mime: string;
}

export interface AppModel {
  name: string;
  slug: string;
  origin: string;
  collections: Collection[];
  actions: Action[];
  captured: Array<{ method: string; template: string; status: number; body: any }>;
  sourceHost: string;
}

const API_PREFIX = /^\/(?:api|v\d+|rest|rpc)\//i;
const CORE = /^\/(?:api|v\d+|rest|rpc)/i;

function stripApiPrefix(template: string): string {
  return template.replace(API_PREFIX, '/').replace(/^\//, '');
}

const VERB_SEGMENT =
  /^(get|list|search|query|filter|fetch|find|load|browse|all|count|lookup|by-.*|get-.*|list-.*)$/i;

function nameFromTemplate(template: string): string {
  const segments = template
    .split('/')
    .filter(Boolean)
    .filter((s) => !/^(api|v\d+|rest|rpc)$/i.test(s) && !s.startsWith('{'));

  // RPC-style paths end in a verb ("/products/get-by-slugs"): the noun is before it.
  while (segments.length > 1 && VERB_SEGMENT.test(segments[segments.length - 1])) segments.pop();

  const last = segments[segments.length - 1] ?? 'items';
  return last.replace(/\.[a-z]+$/i, '');
}

function singular(word: string): string {
  if (/ies$/i.test(word)) return word.replace(/ies$/i, 'y');
  if (/ses$/i.test(word)) return word.replace(/es$/i, '');
  if (/s$/i.test(word) && !/ss$/i.test(word)) return word.replace(/s$/i, '');
  return word;
}

function pluralize(word: string): string {
  if (/y$/i.test(word)) return word.replace(/y$/i, 'ies');
  if (/(s|x|z|ch|sh)$/i.test(word)) return `${word}es`;
  return `${word}s`;
}

function typeOfValue(value: any): Field['type'] {
  if (Array.isArray(value)) return 'array';
  if (value === null) return 'string';
  if (typeof value === 'number') return 'number';
  if (typeof value === 'boolean') return 'boolean';
  if (typeof value === 'object') return 'object';
  return 'string';
}

function deriveFields(items: any[]): Field[] {
  const seen = new Map<string, Field>();
  for (const item of items) {
    if (!isObject(item)) continue;
    for (const [name, value] of Object.entries(item)) {
      if (!seen.has(name)) seen.set(name, { name, type: typeOfValue(value), example: value });
    }
  }
  return [...seen.values()];
}

/** `{ slug: {...}, slug2: {...} }` — a map of records keyed by id. */
function asRecordMap(node: any): any[] | undefined {
  if (!isObject(node)) return undefined;
  const entries = Object.entries(node);
  if (entries.length < 3) return undefined;
  if (!entries.every(([, value]) => isObject(value) && Object.keys(value).length >= 2)) return undefined;
  return entries.map(([key, value]) => (isObject(value) && (value as any).id === undefined ? { id: key, ...value } : value));
}

function extractItems(body: any): { items: any[]; wrapper?: string } {
  if (Array.isArray(body)) return { items: body };
  if (!isObject(body)) return { items: [] };

  // Real APIs nest: { data: { collection: [...] } }, { resource: {...} },
  // { items: [...], meta: {...} }. Look for the largest array of records
  // anywhere in the first few levels instead of only at the top.
  let best: { items: any[]; wrapper: string; depth: number } | undefined;
  const consider = (items: any[], wrapper: string, depth: number) => {
    // Shallower wins: the resource at the top of the response is the resource.
    // Deeper arrays are usually nested detail (prices, tags, line items).
    if (!best || depth < best.depth || (depth === best.depth && items.length > best.items.length)) {
      best = { items, wrapper, depth };
    }
  };

  const walk = (node: any, path: string[], depth: number) => {
    if (depth > 3 || !isObject(node)) return;
    for (const [key, value] of Object.entries(node)) {
      if (Array.isArray(value) && value.length > 0 && value.some((v) => isObject(v))) {
        consider(value, [...path, key].join('.'), depth);
      } else if (isObject(value)) {
        const mapped = asRecordMap(value);
        if (mapped) consider(mapped, [...path, key].join('.'), depth);
        walk(value, [...path, key], depth + 1);
      }
    }
  };

  walk(body, [], 0);
  if (best) return { items: best.items, wrapper: best.wrapper };

  return { items: [] };
}

/** A record we can show as a one-row resource, rather than a bag of config. */
function asSingleRecord(body: any): any | undefined {
  if (!isObject(body) || Array.isArray(body)) return undefined;
  const entries = Object.entries(body);
  if (entries.length === 0) return undefined;
  const primitives = entries.filter(([, v]) => v === null || typeof v !== 'object').length;
  // Config blobs are big and mostly nested; a profile or a detail record is
  // small and mostly flat.
  if (primitives < 2) return undefined;
  if (JSON.stringify(body).length > 20_000) return undefined;
  return body;
}

/**
 * A collection is a resource with an item route (`/{id}`) or a GET list route.
 * Anything else is an action: replayed with its captured response so the app
 * still behaves, even when we cannot model the semantics.
 */
export function deriveAppModel(
  clusters: Cluster[],
  options: {
    name?: string;
    origin?: string;
    documents?: Array<{ path: string; html: string; title?: string }>;
  } = {},
): AppModel {
  const collections = new Map<string, Collection>();
  const actions: Action[] = [];
  const captured: AppModel['captured'] = [];

  // The app we are rebuilding is one origin. Third-party calls (analytics,
  // consent banners, CDNs) are part of the page, not of the product.
  const primaryOrigin = pickPrimaryOrigin(clusters);

  for (const cluster of clusters) {
    if (primaryOrigin && cluster.origin && cluster.origin !== primaryOrigin) continue;

    const itemMatch = cluster.template.match(/^(.*)\/\{id\}$/);
    const base = itemMatch ? itemMatch[1] : cluster.template;
    const isItem = Boolean(itemMatch);

    // Remember the first successful sample of every operation.
    const sample =
      cluster.entries.find((e) => e.status >= 200 && e.status < 300) ?? cluster.entries[0];
    if (sample) {
      captured.push({
        method: cluster.method,
        template: cluster.template,
        status: sample.status,
        body: sample.resBody ?? null,
      });
    }

    const segments = base.split('/').filter(Boolean);
    const name = nameFromTemplate(base);
    const skip =
      STATIC_PATH.test(base) || segments.some((segment) => SKIP_NAMES.test(segment));

    // GET endpoints are resources. A POST that answers with a list of records is
    // a read too — sites use POST for search and filtered listings all the
    // time — so it becomes a collection instead of a dead replay.
    let collected = skip ? { items: [] as any[], single: false as boolean } : collectFromCluster(cluster);
    let isReadPost = false;

    if (!skip && cluster.method === 'POST' && collected.items.length >= 1) {
      isReadPost = true;
    }

    const isCollectionRoute =
      isItem ||
      (cluster.method === 'GET' && !isItem) ||
      (isReadPost && !isItem && collected.items.length >= 2);

    if (isCollectionRoute && (cluster.method === 'GET' || isReadPost) && collected.items.length) {
      let collection = collections.get(base);
      if (!collection) {
        // A single record names its parent ("profiles/rick" → Profile),
        // a list names itself ("event_types" → Event Types). Routes we
        // templatized ("/users/{id}") keep the plural resource name.
        const parent = segments.slice(-2)[0] ?? name;
        const noun = collected.single && !isItem ? singular(parent) : singular(name);
        collection = {
          key: base,
          name: noun,
          label: titleCase(collected.single ? noun : pluralize(noun)),
          items: [],
          fields: [],
          single: collected.single,
          listTemplate: base,
          itemTemplate: itemMatch ? cluster.template : undefined,
        };
        collections.set(base, collection);
      }
      collection.items.push(...collected.items);
      if (collected.wrapper) collection.wrapper = collected.wrapper;
      if (isItem && !collection.itemTemplate) collection.itemTemplate = cluster.template;
      if (isReadPost) collection.readPost = true;
    }

    const modeled = isCollectionRoute && (cluster.method === 'GET' || isReadPost);

    if (!modeled) {
      for (const entry of cluster.entries) {
        const isMutatingOrSpecial = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(cluster.method);
        if (!isMutatingOrSpecial) continue;
        actions.push({
          method: cluster.method,
          template: cluster.template,
          status: entry.status,
          body: entry.resBody ?? null,
          mime: entry.mime,
        });
      }
    }
  }

  // Server-rendered pages: the data was in the HTML, never fetched.
  // Done before field inference so these collections get schemas too.
  for (const document of options.documents ?? []) {
    if (!document.html) continue;
    const payloads = embeddedPayloads(document.html, document.path);
    if (!payloads.length) continue;

    // One page can embed several payloads; take the richest one only.
    const richest = payloads.sort((a, b) => b.items.length - a.items.length)[0];
    const base = document.path === '/' ? '/__page/home' : `/__page${document.path}`;
    if (collections.has(base)) continue;

    const slug = document.path === '/' ? 'home' : document.path.split('/').filter(Boolean).pop() ?? 'page';
    collections.set(base, {
      key: base,
      name: slug,
      label: cleanPageTitle(document.title) ?? titleCase(slug),
      items: richest.items,
      fields: [],
      wrapper: undefined,
      single: false,
      page: true,
      listTemplate: base,
    });
  }

  // Dedupe items by identity when possible, then infer fields.
  for (const collection of collections.values()) {
    const byId = new Map<any, any>();
    const byValue = new Map<string, any>();
    for (const item of collection.items) {
      if (isObject(item) && item.id !== undefined) byId.set(item.id, item);
      else if (isObject(item)) byValue.set(stableStringify(item), item);
      else byValue.set(String(item), item);
    }
    collection.items = [...byId.values(), ...byValue.values()].slice(0, 500);
    collection.fields = deriveFields(collection.items);
    // Only treat it as a single-record resource when it really is one.
    collection.single = Boolean(collection.single) && collection.items.length === 1 && !collection.itemTemplate;
    if (!collection.page) {
      collection.label = titleCase(collection.single ? collection.name : pluralize(collection.name));
    }
  }

  // Keep only collections that actually have data.
  const usable = [...collections.values()]
    .filter((c) => c.items.length > 0)
    .filter((c) => !looksLikeTelemetry(c.items));
  usable.sort((a, b) => a.label.localeCompare(b.label));

  const sourceHost = primaryOrigin ?? clusters[0]?.origin ?? '';
  const name = options.name ?? 'Rebuilt App';

  return {
    name,
    slug: name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') || 'app',
    origin: options.origin ?? sourceHost,
    collections: usable,
    actions: dedupeActions(actions),
    captured,
    sourceHost,
  };
}

const SKIP_NAMES =
  /^(auth|login|logout|me|health|debug|search|admin|stats|env|metrics|config|settings|features|experiments|flags|track|analytics|ping|events|consent)$/i;
const STATIC_PATH = /\.(js|mjs|json|css|map|png|jpe?g|gif|svg|ico|woff2?|ttf|txt|xml|webp|avif)$/i;

/**
 * Telemetry payloads look like records but carry no content: `{ service, params }`
 * from a logging endpoint, `{ key, value }` from a config fetch. Showing them as
 * a resource just makes the generated app look broken.
 */
function looksLikeTelemetry(items: any[]): boolean {
  const telemetryKeys = new Set([
    'service',
    'params',
    'key',
    'value',
    'trackingparams',
    'clicktrackingparams',
    'serializedcontextdata',
  ]);

  return items.every((item) => {
    if (!isObject(item)) return false;
    const keys = Object.keys(item);
    if (keys.length === 0) return true;
    if (!keys.every((key) => telemetryKeys.has(key.toLowerCase()))) return false;
    // `{ key: "client.version", value: "1.2" }` is config; require some prose.
    return !Object.values(item).some(
      (value) => typeof value === 'string' && value.length > 12 && /\s/.test(value),
    );
  });
}

/** \"Hostinger - Bring Your Idea Online With a Website\" → \"Hostinger\". */
function cleanPageTitle(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const parts = raw
    .split(/\s+[|·—–-]\s+/)
    .map((part) => part.trim())
    .filter((part) => part.length >= 2 && part.length <= 48);
  if (!parts.length) return undefined;
  return parts.sort((a, b) => a.length - b.length)[0];
}

/**
 * Server-rendered apps ship their data inside the HTML instead of fetching it:
 * `__NEXT_DATA__`, `window.__INITIAL_STATE__`, or (YouTube) a JS string full of
 * escaped JSON. If the page never called an API, this is the only data there is.
 */
export interface PagePayload {
  path: string;
  items: any[];
}

function decodeJsString(text: string): string {
  let out = '';
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (char !== '\\') {
      out += char;
      continue;
    }
    const next = text[i + 1];
    if (next === 'x') {
      out += String.fromCharCode(parseInt(text.slice(i + 2, i + 4), 16));
      i += 3;
    } else if (next === 'u') {
      out += String.fromCharCode(parseInt(text.slice(i + 2, i + 6), 16));
      i += 5;
    } else if (next === 'n') {
      out += '\n';
      i += 1;
    } else if (next === 't') {
      out += '\t';
      i += 1;
    } else if (next === '\n') {
      i += 1;
    } else {
      out += next;
      i += 1;
    }
  }
  return out;
}

function jsonCandidates(html: string): string[] {
  const found: string[] = [];

  // JSON-LD is SEO metadata about the page, not the app's data. Skip it.
  for (const match of html.matchAll(/<script[^>]+type="application\/json"[^>]*>([\s\S]*?)<\/script>/gi)) {
    found.push(match[1]);
  }

  for (const match of html.matchAll(/JSON\.parse\(\s*(['"])([\s\S]{200,}?)\1\s*\)/g)) {
    found.push(decodeJsString(match[2]));
  }

  // JS object literals whose values are giant escaped JSON strings, which is how
  // YouTube Music and several other Polymer apps ship their first payload.
  for (const match of html.matchAll(/(?:data|payload|initialData|__DATA__)\s*:\s*'((?:[^'\\]|\\.){500,}?)'/g)) {
    found.push(decodeJsString(match[1]));
  }

  return found;
}

const NOISE_PATH = /(responsecontext|trackingparams|chipcloud|continuations|thumbnails|\bruns\b|params|header|metadata|menu|badge|overlay|button)/i;

/** Deeply nested UI payloads (YouTube, Polymer apps) hide their text in renderers. */
function flattenRecord(item: any): any {
  if (!isObject(item)) return item;
  const primitives = Object.values(item).filter((value) => typeof value !== 'object');
  if (primitives.length >= 2) return item;

  const texts: Array<{ text: string; score: number; order: number }> = [];
  let image: string | undefined;
  let visited = 0;
  let order = 0;

  const pathScore = (path: string[]): number => {
    const joined = path.join('.').toLowerCase();
    let score = 0;
    if (/flexcolumns|primarytext|secondarytext|title|subtitle/.test(joined)) score += 5;
    if (/runs|simpletext|text/.test(joined)) score += 2;
    if (/accessibility|menu|overlay|button|tracking|tooltip|badge|header/.test(joined)) score -= 8;
    score += Math.max(0, 4 - path.length);
    return score;
  };

  const walk = (node: any, path: string[], depth: number) => {
    if (visited > 900 || depth > 12 || node === null || node === undefined) return;
    visited += 1;

    if (typeof node === 'string') {
      const where = path.join('.').toLowerCase();
      const isUrl = /^https?:\/\//.test(node);
      const looksLikeImage =
        isUrl &&
        (/\.(png|jpe?g|webp|avif|gif|svg)(\?|$)/i.test(node) ||
          /(thumbnail|image|img|avatar|photo|cover|poster|logo|picture)/.test(where) ||
          /(googleusercontent|cloudinary|imgix|imagekit|cloudfront)/.test(node));
      if (looksLikeImage) {
        if (!image) image = node;
        return;
      }
      const last = path[path.length - 1] ?? '';
      if (/^(text|simpleText)$/i.test(last) && node.length < 160) {
        texts.push({ text: node, score: pathScore(path), order: order++ });
      }
      return;
    }
    if (Array.isArray(node)) {
      node.slice(0, 12).forEach((child, index) => walk(child, [...path, String(index)], depth + 1));
      return;
    }
    if (!isObject(node)) return;

    for (const [key, value] of Object.entries(node)) walk(value, [...path, key], depth + 1);
  };

  walk(item, [], 0);

  const ranked = texts
    .filter((entry) => entry.text.trim().length > 0)
    .sort((a, b) => b.score - a.score || a.order - b.order);

  const unique: string[] = [];
  for (const entry of ranked) {
    if (!unique.includes(entry.text)) unique.push(entry.text);
    if (unique.length === 2) break;
  }

  const record: any = { title: unique[0] ?? '', subtitle: unique[1] ?? '' };
  if (image) record.image = image;
  return record;
}

function largestRecordList(root: any): any[] {
  const stack: Array<{ node: any; path: string[] }> = [{ node: root, path: [] }];
  let best: any[] = [];
  let bestScore = 0;
  let visited = 0;

  while (stack.length && visited < 40_000) {
    const { node, path } = stack.pop()!;
    visited += 1;
    if (path.length > 14) continue;

    if (Array.isArray(node)) {
      const records = node.filter((item) => isObject(item));
      if (records.length >= 3 && !NOISE_PATH.test(path.join('.'))) {
        // Single-key items are usually UI renderers wrapping one payload; give
        // them a bonus so a shelf of 20 songs beats a list of 3 telemetry pings.
        const value = records.reduce(
          (total, item) => total + Math.min(Object.keys(item).length, 10) + (Object.keys(item).length === 1 ? 3 : 0),
          0,
        );
        if (value > bestScore) {
          best = records;
          bestScore = value;
        }
      }
      node.slice(0, 40).forEach((child, index) => stack.push({ node: child, path: [...path, String(index)] }));
    } else if (isObject(node)) {
      for (const [key, value] of Object.entries(node)) stack.push({ node: value, path: [...path, key] });
    }
  }

  return best;
}

export function embeddedPayloads(html: string, path: string): PagePayload[] {
  const payloads: PagePayload[] = [];

  for (const candidate of jsonCandidates(html)) {
    let parsed: any;
    try {
      parsed = JSON.parse(candidate);
    } catch {
      continue;
    }
    const items = largestRecordList(parsed);
    if (items.length >= 3) {
      const flat = items
        .map(flattenRecord)
        .filter(
          (item) =>
            isObject(item) &&
            Object.values(item).some((value) => typeof value === 'string' && value.trim().length >= 2),
        );
      // Frameworks embed plenty of plumbing (locale tables, router state) that
      // flattens into empty shells. Only keep payloads that carry readable text.
      if (flat.length >= 3) payloads.push({ path, items: flat.slice(0, 200) });
    }
  }

  return payloads;
}

function pickPrimaryOrigin(clusters: Cluster[]): string | undefined {
  const counts = new Map<string, number>();
  for (const cluster of clusters) {
    if (!cluster.origin) continue;
    // Documents and XHRs carry the product's own origin; scripts/CDNs do not.
    const weight = cluster.entries.some((e) => e.kind === 'document' || e.kind === 'xhr' || e.kind === 'fetch')
      ? 3
      : 1;
    counts.set(cluster.origin, (counts.get(cluster.origin) ?? 0) + weight);
  }
  let best: string | undefined;
  let bestCount = 0;
  for (const [origin, count] of counts) {
    if (count > bestCount) {
      best = origin;
      bestCount = count;
    }
  }
  return best;
}

function collectFromCluster(cluster: Cluster): { items: any[]; wrapper?: string; single: boolean } {
  const out: { items: any[]; wrapper?: string; single: boolean } = { items: [], single: false };

  for (const entry of cluster.entries) {
    if (entry.resBody === undefined || entry.resBody === null) continue;

    const extracted = extractItems(entry.resBody);
    if (extracted.items.length) {
      if (extracted.wrapper) out.wrapper = extracted.wrapper;
      out.items.push(...extracted.items);
      continue;
    }

    // No list anywhere: it may still be a single record worth showing.
    const single = asSingleRecord(entry.resBody);
    if (single) {
      out.items.push(single);
      out.single = true;
    }
  }

  return out;
}

function dedupeActions(actions: Action[]): Action[] {
  const seen = new Map<string, Action>();
  for (const action of actions) {
    const key = `${action.method} ${action.template}`;
    if (!seen.has(key)) seen.set(key, action);
  }
  return [...seen.values()];
}

// ---------------------------------------------------------------------------
// Code generation
// ---------------------------------------------------------------------------

const stamp = () => new Date().toISOString();

function generateServer(model: AppModel): string {
  const seed = {
    collections: model.collections.map((c) => ({
      key: c.key,
      name: c.name,
      label: c.label,
      fields: c.fields.map((f) => ({ name: f.name, type: f.type })),
      items: c.items,
      wrapper: c.wrapper ?? null,
      single: Boolean(c.single),
      readPost: Boolean(c.readPost),
      page: Boolean(c.page),
    })),
    actions: model.actions.map((a) => ({
      method: a.method,
      template: a.template,
      status: a.status,
      body: a.body,
    })),
    name: model.name,
  };

  return `#!/usr/bin/env node
/**
 * ${model.name} — generated by harspec.
 *
 * This is original code. It does not contain any HTML, CSS or JavaScript from
 * ${model.sourceHost || 'the original site'}. The capture was used as a
 * specification: resource shapes, example records and endpoint behaviour.
 *
 * Data lives in memory and is seeded from the capture. Restart to reset.
 */

import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 4000);

const SEED = ${JSON.stringify(seed, null, 2)};

/** id counter per collection */
const counters = new Map();
const db = new Map();

for (const collection of SEED.collections) {
  let max = 0;
  for (const item of collection.items) {
    if (typeof item?.id === 'number') max = Math.max(max, item.id);
  }
  counters.set(collection.key, max);
  db.set(collection.key, collection.items.map((item) => ({ ...item })));
}

function nextId(key) {
  const id = (counters.get(key) ?? 0) + 1;
  counters.set(key, id);
  return id;
}

/** Build the nested shape the original API used, e.g. data.items → { data: { items } }. */
function nest(key, value) {
  const parts = String(key).split('.');
  const root = {};
  let node = root;
  for (let i = 0; i < parts.length - 1; i++) {
    node[parts[i]] = {};
    node = node[parts[i]];
  }
  node[parts[parts.length - 1]] = value;
  return root;
}

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
  });
  res.end(payload);
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      try { resolve(raw ? JSON.parse(raw) : {}); } catch { resolve({}); }
    });
  });
}

function serveFile(res, file, type) {
  const path = join(here, 'public', file);
  if (!existsSync(path)) { res.writeHead(404); return res.end('not found'); }
  const body = readFileSync(path);
  res.writeHead(200, { 'content-type': type, 'content-length': body.length });
  res.end(body);
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://' + (req.headers.host ?? 'localhost'));
  const path = url.pathname.replace(/\\/+$/, '') || '/';
  const method = req.method ?? 'GET';

  if (method === 'GET' && (path === '/' || path === '/index.html')) return serveFile(res, 'index.html', 'text/html; charset=utf-8');
  if (method === 'GET' && path === '/app.js') return serveFile(res, 'app.js', 'application/javascript; charset=utf-8');
  if (method === 'GET' && path === '/styles.css') return serveFile(res, 'styles.css', 'text/css; charset=utf-8');

  if (method === 'GET' && path === '/__meta') {
    return json(res, 200, {
      name: SEED.name,
      collections: SEED.collections.map((c) => ({
        key: c.key,
        name: c.name,
        label: c.label,
        fields: c.fields,
        wrapper: c.wrapper,
        single: c.single,
        readPost: c.readPost,
        page: c.page,
        records: (db.get(c.key) ?? []).length,
      })),
      actions: SEED.actions.map((a) => ({ method: a.method, template: a.template })),
    });
  }

  // ---- collections: generic CRUD -----------------------------------------
  for (const collection of SEED.collections) {
    const base = collection.key;

    if (path === base && method === 'POST' && collection.readPost) {
      // The original site fetched this list with POST; keep that contract.
      const items = db.get(base) ?? [];
      if (collection.wrapper) return json(res, 200, nest(collection.wrapper, items));
      return json(res, 200, items);
    }

    if (path === base && method === 'GET') {
      const items = db.get(base) ?? [];
      if (collection.single) return json(res, 200, items[0] ?? null);
      const page = Math.max(1, Number(url.searchParams.get('page') ?? 1));
      const limit = Math.max(1, Math.min(200, Number(url.searchParams.get('limit') ?? 50)));
      const search = (url.searchParams.get('q') ?? '').toLowerCase();
      let found = items;
      if (search) {
        found = found.filter((item) =>
          Object.values(item).some((v) => String(v).toLowerCase().includes(search)),
        );
      }
      const start = (page - 1) * limit;
      const slice = found.slice(start, start + limit);
      if (collection.wrapper) {
        return json(res, 200, {
          ...nest(collection.wrapper, slice),
          page,
          limit,
          total: found.length,
          hasMore: start + limit < found.length,
        });
      }
      return json(res, 200, slice);
    }

    if (path === base && method === 'POST') {
      const body = await readBody(req);
      const item = { id: nextId(base), ...body };
      const items = db.get(base) ?? [];
      items.push(item);
      db.set(base, items);
      return json(res, 201, item);
    }

    const itemMatch = path.match(new RegExp('^' + base.replace(/[.*+?^\${}()|[\\]\\\\]/g, '\\\\$&') + '/([^/]+)$'));
    if (itemMatch) {
      const id = itemMatch[1];
      const items = db.get(base) ?? [];
      const index = items.findIndex((i) => String(i.id) === id);

      if (method === 'GET') {
        if (index < 0) return json(res, 404, { error: 'not_found', id });
        return json(res, 200, items[index]);
      }
      if (method === 'PUT' || method === 'PATCH') {
        if (index < 0) return json(res, 404, { error: 'not_found', id });
        const body = await readBody(req);
        items[index] = method === 'PUT' ? { id: items[index].id, ...body } : { ...items[index], ...body };
        db.set(base, items);
        return json(res, 200, items[index]);
      }
      if (method === 'DELETE') {
        if (index < 0) return json(res, 404, { error: 'not_found', id });
        const [removed] = items.splice(index, 1);
        db.set(base, items);
        return json(res, 200, { deleted: true, item: removed });
      }
    }
  }

  // ---- everything else: replay the captured response ---------------------
  const action = SEED.actions.find((a) => a.method === method && matchTemplate(a.template, path));
  if (action) return json(res, action.status, action.body ?? { ok: true });

  return json(res, 404, { error: 'not_found', path, method, hint: 'generated app: only captured endpoints exist' });
});

function matchTemplate(template, path) {
  const pattern = '^' + template.replace(/[.*+?^\${}()|[\\]\\\\]/g, '\\\\$&').replace(/\\\\\\{id\\\\\\}/g, '[^/]+') + '$';
  return new RegExp(pattern).test(path);
}

server.listen(PORT, '127.0.0.1', () => {
  console.log('');
  console.log('  ${model.name}');
  console.log('  http://localhost:' + PORT);
  console.log('');
});
`;
}

function generateStyles(): string {
  return `:root {
  --bg: #f7f7f5;
  --panel: #ffffff;
  --ink: #16161a;
  --muted: #6d6d74;
  --line: #e5e4e0;
  --accent: #1f4d3f;
  --accent-soft: #e9f1ee;
  --radius: 12px;
  --sidebar: 248px;
}

* { box-sizing: border-box; }

html, body { height: 100%; }

body {
  margin: 0;
  font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
  background: var(--bg);
  color: var(--ink);
  font-size: 15px;
  line-height: 1.5;
  -webkit-font-smoothing: antialiased;
}

.topbar {
  position: sticky;
  top: 0;
  z-index: 5;
  height: 56px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 0 20px;
  background: rgba(255, 255, 255, 0.86);
  backdrop-filter: saturate(180%) blur(12px);
  border-bottom: 1px solid var(--line);
}

.brand { display: flex; align-items: center; gap: 10px; font-weight: 620; letter-spacing: -0.01em; }

.mark {
  width: 20px;
  height: 20px;
  border-radius: 6px;
  background: linear-gradient(135deg, var(--accent), #5c9a83);
  display: inline-block;
}

.pill {
  font-size: 11px;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--accent);
  background: var(--accent-soft);
  padding: 3px 9px;
  border-radius: 999px;
}

.layout { display: grid; grid-template-columns: var(--sidebar) 1fr; min-height: calc(100vh - 56px); }

.sidebar {
  border-right: 1px solid var(--line);
  padding: 18px 12px;
  background: var(--panel);
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.nav { display: flex; flex-direction: column; gap: 2px; }

.nav button {
  all: unset;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 8px 10px;
  border-radius: 9px;
  cursor: pointer;
  color: var(--muted);
  font-size: 14px;
}

.nav button:hover { background: #f4f4f1; color: var(--ink); }
.nav button.active { background: var(--accent-soft); color: var(--accent); font-weight: 560; }
.nav button em { font-style: normal; font-size: 12px; color: #a3a29c; }
.nav button.active em { color: var(--accent); opacity: 0.75; }

.nav-sep { height: 1px; background: var(--line); margin: 10px 4px; }

.sidebar-note { margin: 0; padding: 0 10px; font-size: 12px; color: #9b9a93; line-height: 1.5; }

.main { padding: 26px 28px 80px; max-width: 1180px; width: 100%; }

.head { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; margin-bottom: 18px; }
.head h1 { font-size: 22px; margin: 0 0 2px; font-weight: 640; letter-spacing: -0.02em; }
.head .sub { margin: 0; color: var(--muted); font-size: 13px; }
.head-actions { display: flex; align-items: center; gap: 12px; }
.muted { color: var(--muted); font-size: 13px; }

.toolbar { display: flex; gap: 10px; margin-bottom: 16px; }

input[type="search"], input[type="text"], input[type="number"], textarea, select {
  width: 100%;
  padding: 9px 12px;
  border: 1px solid var(--line);
  border-radius: 9px;
  background: var(--panel);
  font: inherit;
  color: var(--ink);
}
input:focus, textarea:focus, select:focus { outline: 2px solid var(--accent-soft); border-color: #7fa899; }

button.primary {
  all: unset;
  padding: 9px 15px;
  border-radius: 9px;
  background: var(--accent);
  color: #fff;
  font-size: 14px;
  font-weight: 520;
  cursor: pointer;
  white-space: nowrap;
}
button.primary:hover { filter: brightness(1.1); }

button.ghost {
  all: unset;
  padding: 8px 13px;
  border-radius: 9px;
  border: 1px solid var(--line);
  cursor: pointer;
  font-size: 13px;
  color: var(--muted);
  background: var(--panel);
}
button.ghost:hover { color: var(--ink); border-color: #cfcec9; }

.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 14px; }

.card {
  all: unset;
  cursor: pointer;
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: var(--radius);
  overflow: hidden;
  display: flex;
  flex-direction: column;
  transition: transform .12s ease, box-shadow .12s ease;
}
.card:hover { transform: translateY(-2px); box-shadow: 0 10px 24px rgba(20, 20, 18, 0.07); }
.card:focus-visible { outline: 2px solid var(--accent); }

.card-media { aspect-ratio: 16 / 10; background: #f0f0ec; overflow: hidden; }
.card-media img { width: 100%; height: 100%; object-fit: cover; display: block; }
.card-media.placeholder {
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 26px;
  font-weight: 620;
  color: var(--accent);
  background: var(--accent-soft);
}

.card-body { padding: 12px 14px 14px; display: flex; flex-direction: column; gap: 3px; }
.card-title { font-size: 14px; font-weight: 560; }
.card-sub {
  font-size: 12.5px;
  color: var(--muted);
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

table { width: 100%; border-collapse: collapse; background: var(--panel); border: 1px solid var(--line); border-radius: var(--radius); overflow: hidden; }
th, td { text-align: left; padding: 11px 13px; border-bottom: 1px solid var(--line); font-size: 14px; vertical-align: top; }
th { background: #faf9f6; font-weight: 560; color: var(--muted); font-size: 11.5px; text-transform: uppercase; letter-spacing: 0.05em; }
tr:last-child td { border-bottom: none; }
tbody tr { cursor: pointer; }
tbody tr:hover { background: #fbfbf8; }
.mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12.5px; }

.method {
  display: inline-block;
  min-width: 54px;
  text-align: center;
  font-size: 11px;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  padding: 2px 6px;
  border-radius: 6px;
  background: #f0f0ec;
  color: #57564f;
}
.method.get { background: #e9f1ee; color: #1f4d3f; }
.method.post { background: #eef0fb; color: #37418f; }
.method.put, .method.patch { background: #fdf3e3; color: #8a5a12; }
.method.delete { background: #fbeceb; color: #96342c; }

.empty {
  padding: 44px;
  text-align: center;
  color: var(--muted);
  background: var(--panel);
  border: 1px dashed var(--line);
  border-radius: var(--radius);
}

dialog { border: 1px solid var(--line); border-radius: 14px; padding: 0; width: min(560px, 94vw); max-height: 86vh; }
dialog::backdrop { background: rgba(22, 22, 26, 0.32); }
.dialog-body { padding: 22px; overflow: auto; max-height: 86vh; }
.dialog-body h2 { margin: 0 0 16px; font-size: 17px; font-weight: 620; letter-spacing: -0.01em; }
.detail-image { width: 100%; max-height: 220px; object-fit: cover; border-radius: 10px; margin-bottom: 16px; background: #f0f0ec; }

dl { display: grid; grid-template-columns: 170px 1fr; gap: 9px 16px; margin: 0; }
dt { color: var(--muted); font-size: 13px; word-break: break-word; }
dd { margin: 0; font-size: 14px; word-break: break-word; }

pre.raw {
  margin: 0;
  padding: 14px;
  background: #fbfbf8;
  border: 1px solid var(--line);
  border-radius: 10px;
  overflow: auto;
  max-height: 52vh;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12.5px;
}

.field { margin-bottom: 12px; }
.field label { display: block; font-size: 12px; color: var(--muted); margin-bottom: 4px; }
.dialog-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 20px; }

.toast {
  position: fixed;
  bottom: 22px;
  left: 50%;
  transform: translateX(-50%) translateY(8px);
  background: var(--ink);
  color: #fff;
  padding: 9px 15px;
  border-radius: 9px;
  font-size: 13px;
  opacity: 0;
  transition: opacity .18s ease, transform .18s ease;
  pointer-events: none;
}
.toast.show { opacity: 1; transform: translateX(-50%) translateY(0); }

@media (max-width: 760px) {
  .layout { grid-template-columns: 1fr; }
  .sidebar { border-right: none; border-bottom: 1px solid var(--line); }
  .nav { flex-direction: row; overflow-x: auto; }
  .sidebar-note { display: none; }
  .main { padding: 18px 16px 60px; }
}
`;
}

function generateIndex(model: AppModel): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${model.name}</title>
  <link rel="stylesheet" href="/styles.css" />
</head>
<body>
  <header class="topbar">
    <div class="brand">
      <span class="mark" aria-hidden="true"></span>
      <span>${model.name}</span>
    </div>
    <span class="pill">rebuilt with harspec</span>
  </header>
  <div class="layout">
    <aside class="sidebar">
      <nav class="nav" id="nav"></nav>
      <p class="sidebar-note">Data is seeded from a traffic capture and lives in memory. Restart to reset.</p>
    </aside>
    <main class="main" id="main"></main>
  </div>
  <dialog id="dialog"><div class="dialog-body" id="dialog-body"></div></dialog>
  <div class="toast" id="toast"></div>
  <script src="/app.js" type="module"></script>
</body>
</html>
`;
}

function generateClient(model: AppModel): string {
  return `/**
 * ${model.name} — generated by harspec.
 *
 * Original implementation. The capture defined the shape of the data, not this
 * code, and nothing here was copied from the source application.
 */

const state = { meta: null, collections: [], view: null };

const el = (tag, attrs = {}, ...children) => {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'html') node.innerHTML = value;
    else if (key.startsWith('on')) node.addEventListener(key.slice(2).toLowerCase(), value);
    else node.setAttribute(key, value === true ? '' : value);
  }
  for (const child of children.flat(4)) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
};

const toast = (message) => {
  const node = document.getElementById('toast');
  node.textContent = message;
  node.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => node.classList.remove('show'), 2200);
};

const IMAGE_KEY = /(image|img|avatar|photo|picture|thumbnail|thumb|logo|cover|poster|art)/i;

const isImage = (key, value) =>
  typeof value === 'string' &&
  IMAGE_KEY.test(key) &&
  (/^https?:\\/\\//.test(value) || value.startsWith('/'));

const imageField = (collection) => collection.fields.find((field) => IMAGE_KEY.test(field.name));

const titleField = (collection) =>
  collection.fields.find((field) => /^(name|title|label|slug|username|email)$/i.test(field.name)) ??
  collection.fields.find((field) => field.type === 'string');

const subtitleField = (collection) =>
  collection.fields.find((field) => /(description|summary|subtitle|bio|about|role|category)/i.test(field.name));

const fmt = (value) => {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'number') return new Intl.NumberFormat().format(value);
  if (typeof value === 'boolean') return value ? 'yes' : 'no';
  if (typeof value === 'object') return JSON.stringify(value).slice(0, 90);
  return String(value);
};

const pretty = (value) => JSON.stringify(value, null, 2);

async function api(path, options) {
  const response = await fetch(path, options);
  const text = await response.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  if (!response.ok) throw new Error(body?.error ?? 'Request failed (' + response.status + ')');
  return body;
}

function pluck(data, path) {
  if (!path) return data;
  return path.split('.').reduce((node, key) => (node == null ? undefined : node[key]), data);
}

function itemsOf(collection, data) {
  if (Array.isArray(data)) return data;
  if (collection.single) return data ? [data] : [];
  const inner = pluck(data, collection.wrapper);
  return Array.isArray(inner) ? inner : [];
}

function renderNav() {
  const nav = document.getElementById('nav');
  nav.replaceChildren();

  for (const collection of state.collections) {
    nav.append(
      el('button', {
        class: state.view === collection.key ? 'active' : '',
        onclick: () => { state.view = collection.key; render(); },
      },
        el('span', {}, collection.label ?? collection.name),
        el('em', {}, collection.records ?? ''),
      ),
    );
  }

  nav.append(
    el('div', { class: 'nav-sep' }),
    el('button', {
      class: state.view === '__endpoints' ? 'active' : '',
      onclick: () => { state.view = '__endpoints'; render(); },
    }, el('span', {}, 'Captured endpoints'), el('em', {}, state.meta.actions.length)),
  );
}

function openDetail(collection, item) {
  const dialog = document.getElementById('dialog');
  const body = document.getElementById('dialog-body');

  const title = titleField(collection);
  const media = imageField(collection);
  const rows = el('dl');
  for (const [key, value] of Object.entries(item)) {
    if (media && key === media.name) continue;
    rows.append(el('dt', {}, key), el('dd', {}, fmt(value)));
  }

  const raw = el('pre', { class: 'raw' }, pretty(item));
  raw.hidden = true;

  const toggle = el('button', {
    class: 'ghost',
    onclick: () => {
      raw.hidden = !raw.hidden;
      rows.hidden = !raw.hidden;
      toggle.textContent = raw.hidden ? 'Raw JSON' : 'Fields';
    },
  }, 'Raw JSON');

  body.replaceChildren(
    el('h2', {}, String(item[title?.name] ?? collection.label ?? 'Record')),
    media && isImage(media.name, item[media.name]) ? el('img', { class: 'detail-image', src: item[media.name], alt: '' }) : '',
    rows,
    raw,
    el('div', { class: 'dialog-actions' }, toggle, el('button', { class: 'ghost', onclick: () => dialog.close() }, 'Close')),
  );

  dialog.showModal();
}

function fieldInput(field) {
  if (field.type === 'number') return el('input', { type: 'number', step: 'any' });
  if (field.type === 'boolean') return el('select', {}, el('option', { value: 'true' }, 'true'), el('option', { value: 'false' }, 'false'));
  return el('input', { type: 'text' });
}

function openCreate(collection) {
  const dialog = document.getElementById('dialog');
  const body = document.getElementById('dialog-body');
  const inputs = {};
  const form = el('form', {});

  const editable = collection.fields.filter((field) => field.name !== 'id').slice(0, 12);

  for (const field of editable) {
    const input = fieldInput(field);
    inputs[field.name] = { input, field };
    form.append(el('div', { class: 'field' }, el('label', {}, field.name), input));
  }

  form.append(
    el('div', { class: 'dialog-actions' },
      el('button', { class: 'ghost', type: 'button', onclick: () => dialog.close() }, 'Cancel'),
      el('button', { class: 'primary', type: 'submit' }, 'Create'),
    ),
  );

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const payload = {};
    for (const [name, entry] of Object.entries(inputs)) {
      const raw = entry.input.value;
      if (raw === '') continue;
      payload[name] = entry.field.type === 'number' ? Number(raw)
        : entry.field.type === 'boolean' ? raw === 'true'
        : raw;
    }
    try {
      await api(collection.key, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      dialog.close();
      toast('Created');
      await boot();
    } catch (error) {
      toast(error.message);
    }
  });

  body.replaceChildren(el('h2', {}, 'New ' + (collection.label ?? collection.name)), form);
  dialog.showModal();
}

function card(collection, item) {
  const media = imageField(collection);
  const title = titleField(collection);
  const subtitle = subtitleField(collection);
  const src = media ? item[media.name] : null;

  return el('button', { class: 'card', onclick: () => openDetail(collection, item) },
    isImage(media?.name ?? '', src)
      ? el('div', { class: 'card-media' }, el('img', { src, alt: '', loading: 'lazy' }))
      : el('div', { class: 'card-media placeholder' }, String(item[title?.name] ?? '·').slice(0, 2).toUpperCase()),
    el('div', { class: 'card-body' },
      el('div', { class: 'card-title' }, fmt(title ? item[title.name] : collection.label)),
      subtitle && item[subtitle.name] ? el('div', { class: 'card-sub' }, String(item[subtitle.name]).slice(0, 120)) : '',
    ),
  );
}

function table(collection, items) {
  const media = imageField(collection);
  const columns = collection.fields
    .filter((field) => field.type !== 'object' && field.type !== 'array')
    .filter((field) => !media || field.name !== media.name)
    .slice(0, 6);

  return el('table', {},
    el('thead', {}, el('tr', {}, ...columns.map((field) => el('th', {}, field.name)))),
    el('tbody', {}, ...items.map((item) =>
      el('tr', { onclick: () => openDetail(collection, item) },
        ...columns.map((field) => el('td', {}, fmt(item[field.name]))),
      ),
    )),
  );
}

async function renderCollection(collection) {
  const main = document.getElementById('main');
  const search = el('input', { type: 'search', placeholder: 'Search ' + (collection.label ?? 'records').toLowerCase() + '…' });
  const content = el('div', { class: 'content' });
  const meta = el('span', { class: 'muted' });

  const draw = async () => {
    const data = collection.readPost
      ? await api(collection.key, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({}),
        })
      : await api(collection.key);
    const items = itemsOf(collection, data);
    const needle = search.value.trim().toLowerCase();
    const visible = needle
      ? items.filter((item) => JSON.stringify(item).toLowerCase().includes(needle))
      : items;

    meta.textContent = visible.length + (visible.length === 1 ? ' record' : ' records');

    if (!visible.length) {
      content.replaceChildren(el('div', { class: 'empty' }, needle ? 'Nothing matches that search.' : 'No records here.'));
      return;
    }

    const cards = Boolean(imageField(collection)) || collection.fields.length <= 3;
    content.replaceChildren(
      cards
        ? el('div', { class: 'grid' }, ...visible.map((item) => card(collection, item)))
        : table(collection, visible),
    );
  };

  main.replaceChildren(
    el('div', { class: 'head' },
      el('div', {},
        el('h1', {}, collection.label ?? collection.name),
        el('p', { class: 'sub' }, collection.page ? 'Embedded in the page, not fetched from an API' : collection.key),
      ),
      el('div', { class: 'head-actions' },
        meta,
        collection.page
          ? ''
          : el('button', { class: 'primary', onclick: () => openCreate(collection) }, 'New'),
      ),
    ),
    el('div', { class: 'toolbar' }, search),
    content,
  );

  search.addEventListener('input', () => draw().catch((error) => toast(error.message)));
  await draw();
}

function renderEndpoints() {
  const main = document.getElementById('main');
  const actions = [
    ...state.collections.map((collection) => ({
      method: collection.readPost ? 'POST' : 'GET',
      template: collection.key,
      collection,
    })),
    ...state.meta.actions.map((action) => ({
      ...action,
      collection: state.collections.find((c) => action.template.startsWith(c.key)),
    })),
  ];

  main.replaceChildren(
    el('div', { class: 'head' },
      el('div', {},
        el('h1', {}, 'Captured endpoints'),
        el('p', { class: 'sub' }, 'Every call observed in the capture. Anything not modelled as a resource is replayed with its recorded response.'),
      ),
    ),
    el('table', { class: 'endpoints' },
      el('thead', {}, el('tr', {}, el('th', {}, 'Method'), el('th', {}, 'Path'), el('th', {}, 'Records'))),
      el('tbody', {}, ...actions.map((action) => {
        const collection = action.collection ?? state.collections.find((c) => action.template.startsWith(c.key));
        const local = action.method === 'GET' && collection;
        return el('tr', {},
          el('td', {}, el('span', { class: 'method ' + action.method.toLowerCase() }, action.method)),
          el('td', { class: 'mono' }, action.template),
          el('td', { class: 'muted' }, local ? collection.records + ' local' : 'replayed'),
        );
      })),
    ),
  );
}

async function render() {
  renderNav();
  if (state.view === '__endpoints') return renderEndpoints();
  const collection = state.collections.find((item) => item.key === state.view);
  if (collection) await renderCollection(collection);
}

async function boot() {
  let meta;
  try {
    meta = await api('/__meta');
  } catch {
    document.getElementById('main').replaceChildren(el('div', { class: 'empty' }, 'Could not reach the generated API.'));
    return;
  }

  state.meta = meta;
  state.collections = meta.collections;
  if (!state.view || !meta.collections.some((c) => c.key === state.view)) {
    state.view = meta.collections[0]?.key ?? '__endpoints';
  }
  await render();
}

boot();
`;
}

function generatePackageJson(model: AppModel): string {
  return `${JSON.stringify(
    {
      name: model.slug,
      version: '1.0.0',
      private: true,
      type: 'module',
      description: `${model.name} — generated from a traffic capture by harspec`,
      scripts: { start: 'node server.mjs' },
      engines: { node: '>=20' },
    },
    null,
    2,
  )}\n`;
}

function generateReadme(model: AppModel): string {
  return `# ${model.name}

Generated by \`harspec reproduce\` from a traffic capture of \`${model.sourceHost || 'a web app'}\`.

**This is an original implementation.** No HTML, CSS or JavaScript from the source
application was copied. The capture was used as a specification: which resources
exist, what fields they have, and what a real response looked like.

## Run it

\`\`\`bash
npm start
# → http://localhost:4000
\`\`\`

No dependencies. Node 20+.

## What is inside

| Resource | Records | Endpoint |
|---|---|---|
${model.collections.map((c) => `| ${c.label} | ${c.items.length} | \`${c.key}\` |`).join('\n')}

Data lives in memory, seeded from the capture. Restart to reset.

## What it does and does not do

- It **does** serve the captured resources with working list, detail, create, update and delete.
- It **does** replay every other captured endpoint with the response observed at capture time.
- It **does not** contain the original business logic, which was never visible in the traffic.
- It **does not** call the original service. It runs entirely on its own.

## Before you show this to anyone

The visual design, name and copy here are generic on purpose. If you are
reproducing a product you do not own, replace anything that identifies it:
name, logo, colours, wording, and any data that is not yours.
`;

}

export function generateApp(model: AppModel): Record<string, string> {
  return {
    'server.mjs': generateServer(model),
    'public/index.html': generateIndex(model),
    'public/app.js': generateClient(model),
    'public/styles.css': generateStyles(),
    'package.json': generatePackageJson(model),
    'README.md': generateReadme(model),
    'harspec.json': `${JSON.stringify(
      {
        generatedBy: 'harspec',
        generatedAt: stamp(),
        source: model.sourceHost,
        collections: model.collections.map((c) => ({ key: c.key, records: c.items.length })),
        note: 'Original implementation generated from a traffic capture. Contains no source assets from the target.',
      },
      null,
      2,
    )}\n`,
  };
}

export function writeApp(model: AppModel, outDir: string): string[] {
  const files = generateApp(model);
  for (const [relative, content] of Object.entries(files)) {
    const target = join(outDir, relative);
    mkdirSync(join(target, '..'), { recursive: true });
    writeFileSync(target, content);
  }
  return Object.keys(files);
}

export function appSummary(model: AppModel): string {
  const rows = model.collections
    .map((c) => `  ${pascalCase(c.label).padEnd(18)} ${String(c.items.length).padStart(3)} records   ${c.key}`)
    .join('\n');
  return rows || '  (no resources with data were found)';
}
