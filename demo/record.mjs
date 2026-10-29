#!/usr/bin/env node
/**
 * Records a realistic session against the demo target and writes a HAR file.
 *
 * You do not need this for real use: in a real app you export the HAR from
 * DevTools. Here it exists so the end-to-end test is reproducible without a
 * browser.
 *
 *   node demo/record.mjs --base http://localhost:3000 --out demo/session.har
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const args = process.argv.slice(2);
const getArg = (name, fallback) => {
  const idx = args.indexOf(name);
  return idx >= 0 && args[idx + 1] ? args[idx + 1] : fallback;
};

const BASE = getArg('--base', 'http://localhost:3000').replace(/\/$/, '');
const OUT = getArg('--out', 'demo/session.har');

const entries = [];
let token = '';

function resourceType(path) {
  if (path === '/' || path.endsWith('.html')) return 'document';
  if (/\.(js|mjs)(\?|$)/.test(path)) return 'script';
  if (/\.(css)(\?|$)/.test(path)) return 'stylesheet';
  return 'xhr';
}

async function record(method, path, options = {}) {
  const url = `${BASE}${path}`;
  const headers = { ...(options.headers ?? {}) };
  let body;
  if (options.body !== undefined) {
    body = JSON.stringify(options.body);
    headers['content-type'] = 'application/json';
  }

  const startedAt = new Date();
  const t0 = performance.now();
  const response = await fetch(url, { method, headers, body });
  const text = await response.text();
  const timeMs = performance.now() - t0;

  const requestHeaders = Object.entries(headers).map(([name, value]) => ({ name, value: String(value) }));
  if (body) requestHeaders.push({ name: 'content-length', value: String(Buffer.byteLength(body)) });

  const responseHeaders = [];
  response.headers.forEach((value, name) => {
    if (name.toLowerCase() === 'set-cookie') return;
    responseHeaders.push({ name, value });
  });
  const setCookies = typeof response.headers.getSetCookie === 'function' ? response.headers.getSetCookie() : [];
  for (const cookie of setCookies) responseHeaders.push({ name: 'set-cookie', value: cookie });

  const parsed = new URL(url);
  const queryString = [...parsed.searchParams.entries()].map(([name, value]) => ({ name, value }));
  const mimeType = response.headers.get('content-type') ?? '';
  const isJson = mimeType.includes('json');

  const entry = {
    startedDateTime: startedAt.toISOString(),
    time: Math.round(timeMs),
    request: {
      method,
      url,
      httpVersion: 'HTTP/1.1',
      cookies: [],
      headers: requestHeaders,
      queryString,
      headersSize: -1,
      bodySize: body ? Buffer.byteLength(body) : 0,
      ...(body
        ? { postData: { mimeType: 'application/json', text: body, params: [] } }
        : {}),
    },
    response: {
      status: response.status,
      statusText: response.statusText,
      httpVersion: 'HTTP/1.1',
      cookies: [],
      headers: responseHeaders,
      content: {
        size: Buffer.byteLength(text),
        mimeType: mimeType.split(';')[0],
        ...(isJson ? { text } : {}),
        ...(isJson && text ? {} : { text }),
      },
      redirectURL: '',
      headersSize: -1,
      bodySize: Buffer.byteLength(text),
    },
    cache: {},
    timings: { send: 0, wait: Math.round(timeMs), receive: 0 },
    _resourceType: resourceType(parsed.pathname),
  };

  entries.push(entry);
  return { status: response.status, text, json: isJson ? safeJson(text) : undefined };
}

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

async function main() {
  // Page shell + bundle, so the passive header checks and bundle scan have targets.
  await record('GET', '/');
  await record('GET', '/app.js');

  // Login and authenticated session.
  const login = await record('POST', '/api/auth/login', {
    body: { email: 'ana@example.com', password: 'demo-password' },
  });
  token = login.json?.token ?? '';
  const auth = { authorization: `Bearer ${token}` };

  await record('GET', '/api/auth/me', { headers: auth });

  // Browsing: two pages of the same endpoint produce merged schemas.
  await record('GET', '/api/products?page=1&limit=2');
  await record('GET', '/api/products?page=2&limit=2');
  await record('GET', '/api/products/1');
  await record('GET', '/api/products/3');
  await record('GET', '/api/products?category=input&page=1&limit=2');

  // Cart and checkout: the two money bugs.
  await record('POST', '/api/cart/items', {
    headers: auth,
    body: { cartId: 1, productId: 1, quantity: 2, price: 129.99 },
  });
  await record('GET', '/api/carts/1', { headers: auth });
  await record('POST', '/api/checkout', {
    headers: auth,
    body: {
      cartId: 1,
      total: 259.98,
      coupon: 'WELCOME10',
      email: 'ana@example.com',
      cardLast4: '4242',
    },
  });

  // Profile: IDOR pair + client-only email validation.
  await record('GET', '/api/users/1', { headers: auth });
  await record('GET', '/api/users/2', { headers: auth });
  await record('PUT', '/api/users/2/email', { headers: auth, body: { email: 'bruno@example.com' } });

  // Admin surface.
  await record('GET', '/api/admin/stats', { headers: auth });

  // Debug endpoint.
  await record('GET', '/api/debug/env');

  // Deliberate 500 with a stack trace.
  await record('GET', '/api/search');
  await record('GET', '/api/search?q=keyboard');

  const har = {
    log: {
      version: '1.2',
      creator: { name: 'harspec-recorder', version: '0.1.0' },
      pages: [
        {
          startedDateTime: entries[0]?.startedDateTime ?? new Date().toISOString(),
          id: 'page_1',
          title: 'Demo Shop',
          pageTimings: { onContentLoad: 180, onLoad: 420 },
        },
      ],
      entries,
    },
  };

  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, `${JSON.stringify(har, null, 2)}\n`);
  console.log(`recorded ${entries.length} requests → ${OUT}`);
}

main().catch((error) => {
  console.error('record failed:', error.message);
  process.exit(1);
});
