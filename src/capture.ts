/**
 * Capture: drive a local Chrome over the DevTools Protocol and record traffic.
 *
 * No dependencies. Node ships a global WebSocket, so the whole client is a few
 * hundred lines instead of a 300 MB Playwright install. It runs on the user's
 * machine, with the user's network, which is also why it does not need to defeat
 * any bot protection: it is a real browser doing normal browsing.
 */

import type { Entry } from './har.ts';
import { applyChromeIdentity, type Cdp, openBrowser, pinViewport, sleep, withDeadline } from './browser.ts';
import { tryJson } from './util.ts';

interface Tracked {
  requestId: string;
  method: string;
  url: string;
  startedAt: string;
  startedMs: number;
  requestHeaders: Record<string, string>;
  postData?: string;
  status: number;
  responseHeaders: Record<string, string>;
  mime: string;
  resourceType: string;
  body?: string;
  finishedMs?: number;
}

const SKIP_TYPES = new Set(['Image', 'Media', 'Font', 'Stylesheet', 'Manifest', 'Other']);
const MAX_BODY = 400_000;

function headersToObject(headers: Record<string, any> = {}): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) out[key.toLowerCase()] = String(value);
  return out;
}

export interface CaptureOptions {
  timeoutMs?: number;
  idleMs?: number;
  headless?: boolean;
  scroll?: boolean;
  /** Open a real window and record while the person uses the site. */
  interactive?: boolean;
  /** Hard stop for interactive capture, in seconds. */
  seconds?: number;
  /** Run while the page is loaded, before the browser closes. */
  observe?: (cdp: Cdp) => Promise<void>;
  /** Hard cap for the whole capture, in ms. A wedged renderer never recovers. */
  hardTimeoutMs?: number;
  onProgress?: (message: string) => void;
}

export async function captureSession(url: string, options: CaptureOptions = {}): Promise<Entry[]> {
  const headless = options.headless ?? !options.interactive;
  const onProgress = options.onProgress ?? (() => {});
  const session = await openBrowser({ headless, onProgress });
  const limit = options.hardTimeoutMs ?? 150_000;

  try {
    return await withDeadline(runCapture(session.cdp, session.version, url, options), limit, () => {
      // A wedged renderer will never answer again. Killing the browser is the
      // only way out, and the caller can retry with a fresh one.
      session.close();
    });
  } finally {
    session.close();
  }
}

async function runCapture(cdp: Cdp, browserVersion: string, url: string, options: CaptureOptions): Promise<Entry[]> {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const idleMs = options.idleMs ?? 2_500;
  const onProgress = options.onProgress ?? (() => {});

  {

    const tracked = new Map<string, Tracked>();
    const bodyJobs: Array<Promise<void>> = [];
    let inflight = 0;
    let lastActivity = Date.now();
    let pageLoaded = false;

    cdp.on('Network.requestWillBeSent', (params) => {
      inflight += 1;
      lastActivity = Date.now();
      const request = params.request ?? {};
      tracked.set(params.requestId, {
        requestId: params.requestId,
        method: String(request.method ?? 'GET').toUpperCase(),
        url: String(request.url ?? ''),
        startedAt: new Date(params.wallTime ? params.wallTime * 1000 : Date.now()).toISOString(),
        startedMs: Date.now(),
        requestHeaders: headersToObject(request.headers),
        postData: request.postData,
        status: 0,
        responseHeaders: {},
        mime: '',
        resourceType: String(params.type ?? 'Other'),
      });
    });

    cdp.on('Network.responseReceived', (params) => {
      const entry = tracked.get(params.requestId);
      if (!entry) return;
      const response = params.response ?? {};
      entry.status = Number(response.status ?? 0);
      entry.responseHeaders = headersToObject(response.headers);
      entry.mime = String(response.mimeType ?? '');
      if (params.type) entry.resourceType = String(params.type);
    });

    cdp.on('Network.loadingFinished', (params) => {
      inflight = Math.max(0, inflight - 1);
      lastActivity = Date.now();
      const entry = tracked.get(params.requestId);
      if (!entry || entry.finishedMs) return;
      entry.finishedMs = Date.now();

      if (SKIP_TYPES.has(entry.resourceType)) return;
      if (!/(json|javascript|html|text)/i.test(entry.mime) && entry.resourceType !== 'XHR' && entry.resourceType !== 'Fetch' && entry.resourceType !== 'Document') {
        return;
      }
      if (Number(params.encodedDataLength ?? 0) > MAX_BODY * 4) return;

      const job = cdp
        .send('Network.getResponseBody', { requestId: params.requestId })
        .then((result) => {
          entry.body = result?.body ?? '';
          if (process.env.HARSPEC_DEBUG) {
            console.error(`[body] ${entry.method} ${entry.url.slice(0, 80)} → ${entry.body.length} bytes b64:${result?.base64Encoded}`);
          }
        })
        .catch((error: Error) => {
          entry.body = '';
          if (process.env.HARSPEC_DEBUG) {
            console.error(`[body] ${entry.method} ${entry.url.slice(0, 80)} → FAILED: ${error.message}`);
          }
        });
      bodyJobs.push(job);
    });

    cdp.on('Network.loadingFailed', (params) => {
      inflight = Math.max(0, inflight - 1);
      lastActivity = Date.now();
      const entry = tracked.get(params.requestId);
      if (entry && !entry.finishedMs) entry.finishedMs = Date.now();
    });

    cdp.on('Page.loadEventFired', () => {
      pageLoaded = true;
      lastActivity = Date.now();
    });

    await cdp.send('Page.enable');
    await pinViewport(cdp);

    await cdp.send('Network.enable', {
      maxTotalBufferSize: 50_000_000,
      maxResourceBufferSize: 10_000_000,
    });

    // Headless browsers announce themselves ("HeadlessChrome/156"), and several
    // large sites answer with "your browser is deprecated" instead of the app.
    // We are a real Chromium; say so, and keep the version we actually run.
    await applyChromeIdentity(cdp, browserVersion);

    onProgress(`navigating to ${url}`);
    await cdp.send('Page.navigate', { url });

    const settle = async (maxMs = Math.min(timeoutMs, 15_000)) => {
      const deadline = Date.now() + maxMs;
      while (Date.now() < deadline) {
        await sleep(250);
        // Inflight is ignored on purpose: analytics beacons and long polls never
        // reach zero on real sites, but "nothing has happened for a while" is a
        // reliable signal that the app has finished loading what it loads.
        if (pageLoaded && Date.now() - lastActivity > idleMs) return;
      }
      if (process.env.HARSPEC_DEBUG) onProgress('still busy, using what we have');
    };

    await settle();

    // Consent walls (YouTube, most EU sites) hide the app behind a dialog.
    // Click the obvious affirmative button, once, exactly like a person would.
    const consent = await cdp
      .send('Runtime.evaluate', {
        returnByValue: true,
        expression: `(() => {
          const rx = /^(accept all|accept|i agree|agree|got it|aceptar todo|aceptar|accepter|tout accepter|alle akzeptieren|zustimmen|accetta tutto)$/i;
          const candidates = [...document.querySelectorAll('button, [role="button"], a, input[type="submit"]')];
          const target = candidates.find((node) => rx.test((node.innerText || node.value || '').trim()));
          if (!target) return '';
          target.click();
          return (target.innerText || target.value || '').trim();
        })()`,
      })
      .catch(() => null);

    const consentLabel = consent?.result?.value;
    if (consentLabel) {
      onProgress(`dismissed a consent wall ("${String(consentLabel).slice(0, 24)}")`);
      pageLoaded = false;
      await settle(10_000);
    }

    if (options.interactive) {
      // The person drives. harspec never sees or stores a password: if a login
      // is needed, they type it themselves into this window, and we only record
      // the traffic that follows, exactly like DevTools would.
      await waitForUser(options.seconds);
      await settle(3_000);
    } else if (options.scroll !== false && !options.observe) {
      // Many apps only fetch their data once the viewport reaches a section.
      onProgress('scrolling to trigger lazy requests');
      for (const fraction of [0.5, 1, 0.5, 0]) {
        await cdp
          .send('Runtime.evaluate', {
            expression: `window.scrollTo({ top: document.body.scrollHeight * ${fraction}, behavior: 'instant' })`,
          })
          .catch(() => {});
        await sleep(700);
      }
      pageLoaded = false;
      await settle();
    }

    // Response bodies arrive asynchronously; wait for every read to land
    // before serialising, otherwise fast exits produce empty payloads.
    if (options.observe) {
      try {
        await options.observe(cdp);
      } catch (error: any) {
        onProgress(`observation failed: ${error.message}`);
      }
    }

    await Promise.allSettled(bodyJobs);

    return toEntries(tracked, url);
  }
}

/**
 * Block until the person says they are done, or until the hard limit is hit.
 * Falls back to the limit when stdin is not a terminal (CI, piping).
 */
async function waitForUser(seconds?: number): Promise<void> {
  const limitMs = seconds && seconds > 0 ? seconds * 1000 : 5 * 60_000;

  if (!process.stdin.isTTY) {
    await sleep(limitMs);
    return;
  }

  console.log('');
  console.log('  A browser window is open. Use the site normally — click, search,');
  console.log('  open a few pages, log in if you want your own session recorded.');
  console.log(`  Press Enter when you are done (auto-stop in ${Math.round(limitMs / 1000)}s).`);
  console.log('');

  await new Promise<void>((resolve) => {
    const timer = setTimeout(finish, limitMs);
    const stdin = process.stdin;
    const onData = () => finish();

    function finish() {
      clearTimeout(timer);
      stdin.off('data', onData);
      try {
        stdin.setRawMode?.(false);
        stdin.pause();
      } catch {
        // ignore
      }
      resolve();
    }

    stdin.resume();
    stdin.once('data', onData);
  });
}

async function waitForDevTools(port: number, timeoutMs: number): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1000) });
      if (response.ok) {
        const info = (await response.json()) as { Browser?: string };
        return info.Browser ?? '';
      }
    } catch {
      // not up yet
    }
    await sleep(200);
  }
  throw new Error('browser did not open a debugging port');
}

async function createTarget(port: number): Promise<{ webSocketDebuggerUrl: string }> {
  const response = await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' });
  if (!response.ok) throw new Error(`could not create a browser tab (${response.status})`);
  return (await response.json()) as { webSocketDebuggerUrl: string };
}

export function harFromEntries(entries: Entry[], version: string): Record<string, any> {
  const textOf = (entry: Entry): string =>
    entry.resText && entry.resText.length > 0
      ? entry.resText
      : entry.resBody !== undefined
        ? JSON.stringify(entry.resBody)
        : '';

  return {
    log: {
      version: '1.2',
      creator: { name: 'harspec', version },
      entries: entries.map((entry) => {
        const text = textOf(entry);
        const requestMime =
          entry.reqHeaders['content-type']?.split(';')[0] ??
          (entry.reqBody !== undefined ? 'application/json' : '');
        return {
          startedDateTime: entry.startedAt,
          time: entry.timeMs,
          request: {
            method: entry.method,
            url: entry.url,
            httpVersion: 'HTTP/1.1',
            cookies: [],
            headers: Object.entries(entry.reqHeaders).map(([name, value]) => ({ name, value })),
            queryString: Object.entries(entry.query).map(([name, value]) => ({ name, value })),
            headersSize: -1,
            bodySize: text.length === 0 && entry.reqBody === undefined ? 0 : Buffer.byteLength(JSON.stringify(entry.reqBody ?? {})),
            ...(entry.reqBody !== undefined
              ? {
                  postData: {
                    mimeType: requestMime || 'application/json',
                    text: typeof entry.reqBody === 'string' ? entry.reqBody : JSON.stringify(entry.reqBody),
                    params: [],
                  },
                }
              : {}),
          },
          response: {
            status: entry.status,
            statusText: '',
            httpVersion: 'HTTP/1.1',
            cookies: [],
            headers: Object.entries(entry.resHeaders).map(([name, value]) => ({ name, value })),
            content: {
              size: Buffer.byteLength(text),
              mimeType: entry.mime,
              text,
            },
            redirectURL: entry.resHeaders['location'] ?? '',
            headersSize: -1,
            bodySize: Buffer.byteLength(text),
          },
          cache: {},
          timings: { send: 0, wait: entry.timeMs, receive: 0 },
          _resourceType: entry.kind,
        };
      }),
    },
  };
}

export function toEntries(tracked: Map<string, Tracked>, requestedUrl: string): Entry[] {
  const entries: Entry[] = [];
  let index = 0;

  for (const item of tracked.values()) {
    if (!item.url || item.url.startsWith('data:') || item.url.startsWith('blob:')) continue;
    if (item.status === 0) continue;

    let parsed: URL;
    try {
      parsed = new URL(item.url);
    } catch {
      continue;
    }

    const body = item.body ?? '';
    const isJson = /json/i.test(item.mime);
    const isText = /(text|javascript|html|xml)/i.test(item.mime);

    entries.push({
      index: index++,
      method: item.method,
      url: item.url,
      host: parsed.host,
      origin: `${parsed.protocol}//${parsed.host}`,
      pathname: parsed.pathname || '/',
      query: Object.fromEntries(parsed.searchParams.entries()),
      status: item.status,
      kind: item.resourceType.toLowerCase(),
      mime: item.mime.split(';')[0],
      reqHeaders: item.requestHeaders,
      resHeaders: item.responseHeaders,
      reqBody: tryJson(item.postData),
      resBody: isJson ? tryJson(body) : undefined,
      resText: isText ? body.slice(0, 2_000_000) : '',
      timeMs: (item.finishedMs ?? item.startedMs) - item.startedMs,
      startedAt: item.startedAt,
    });
  }

  // Make sure the requested document exists even if the browser reused a tab.
  if (!entries.some((e) => e.url.startsWith(requestedUrl) || requestedUrl.startsWith(e.url))) {
    // nothing to do; the capture is still valid
  }

  return entries;
}
