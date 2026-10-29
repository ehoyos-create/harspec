/**
 * Capture: drive a local Chrome over the DevTools Protocol and record traffic.
 *
 * No dependencies. Node ships a global WebSocket, so the whole client is a few
 * hundred lines instead of a 300 MB Playwright install. It runs on the user's
 * machine, with the user's network, which is also why it does not need to defeat
 * any bot protection: it is a real browser doing normal browsing.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Entry } from './har.ts';
import { tryJson } from './util.ts';

/**
 * Any Chromium-family browser works, because they all speak the same protocol.
 * Keeping the list wide matters: most people do not have plain Chrome installed.
 */
const MAC_APPS = [
  'Google Chrome',
  'Google Chrome Beta',
  'Google Chrome Canary',
  'Chromium',
  'Microsoft Edge',
  'Brave Browser',
  'Vivaldi',
  'Opera',
  'Arc',
  'Dia',
  'Sidekick',
  'SigmaOS',
];

function macCandidates(): string[] {
  const roots = ['/Applications', join(homedir(), 'Applications')];
  const out: string[] = [];
  for (const root of roots) {
    for (const app of MAC_APPS) {
      const binary = app.replace(/\s+/g, '');
      out.push(join(root, `${app}.app`, 'Contents', 'MacOS', app));
      out.push(join(root, `${app}.app`, 'Contents', 'MacOS', binary));
    }
  }
  return out;
}

function linuxCandidates(): string[] {
  return [
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/snap/bin/chromium',
    '/usr/bin/microsoft-edge',
    '/usr/bin/brave-browser',
  ];
}

function windowsCandidates(): string[] {
  const roots = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe',
  ];
  return roots;
}

function scanCandidates(): string[] {
  const explicit = [process.env.HARSPEC_CHROME].filter(Boolean) as string[];
  const list = [...explicit, ...macCandidates(), ...linuxCandidates(), ...windowsCandidates()];

  // Last resort on macOS: look inside every installed app bundle for a
  // Chromium-style binary, which catches browsers we have never heard of.
  if (process.platform === 'darwin') {
    for (const root of ['/Applications', join(homedir(), 'Applications')]) {
      let entries: string[] = [];
      try {
        entries = readdirSync(root);
      } catch {
        continue;
      }
      for (const name of entries) {
        if (!name.endsWith('.app')) continue;
        const base = name.slice(0, -4);
        list.push(join(root, name, 'Contents', 'MacOS', base));
      }
    }
  }

  return [...new Set(list)];
}

export function findChrome(): string | undefined {
  return scanCandidates().find((path) => existsSync(path));
}

export function browserSearchHint(): string {
  const tried = scanCandidates().slice(0, 6).map((p) => `  ${p}`);
  return [
    'no Chromium-family browser found. harspec can drive Chrome, Chromium, Edge,',
    'Brave, Arc, Dia, Vivaldi or Opera over the DevTools protocol.',
    '',
    'looked in:',
    ...tried,
    '  … and every app bundle in /Applications',
    '',
    'fix one of these:',
    '  export HARSPEC_CHROME="/Applications/Your Browser.app/Contents/MacOS/Your Browser"',
    '  harspec reproduce capture.har        # export a HAR from DevTools → Network → Save all as HAR',
  ].join('\n');
}

interface Pending {
  resolve: (value: any) => void;
  reject: (error: Error) => void;
}

class Cdp {
  private socket: WebSocket;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private listeners = new Map<string, Array<(params: any) => void>>();

  private constructor(socket: WebSocket) {
    this.socket = socket;
    this.socket.addEventListener('message', (event: MessageEvent) => {
      let message: any;
      try {
        message = JSON.parse(String(event.data));
      } catch {
        return;
      }
      if (message.id && this.pending.has(message.id)) {
        const entry = this.pending.get(message.id)!;
        this.pending.delete(message.id);
        if (message.error) entry.reject(new Error(message.error.message ?? 'CDP error'));
        else entry.resolve(message.result);
        return;
      }
      if (message.method) {
        for (const listener of this.listeners.get(message.method) ?? []) listener(message.params);
      }
    });
  }

  static async connect(url: string, timeoutMs = 10_000): Promise<Cdp> {
    const socket = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('CDP connect timed out')), timeoutMs);
      socket.addEventListener('open', () => {
        clearTimeout(timer);
        resolve();
      });
      socket.addEventListener('error', () => {
        clearTimeout(timer);
        reject(new Error('CDP connect failed'));
      });
    });
    return new Cdp(socket);
  }

  send(method: string, params: Record<string, any> = {}): Promise<any> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`${method} timed out`));
        }
      }, 30_000);
    });
  }

  on(event: string, listener: (params: any) => void) {
    const list = this.listeners.get(event) ?? [];
    list.push(listener);
    this.listeners.set(event, list);
  }

  close() {
    try {
      this.socket.close();
    } catch {
      // ignore
    }
  }
}

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
  onProgress?: (message: string) => void;
}

export async function captureSession(url: string, options: CaptureOptions = {}): Promise<Entry[]> {
  const chrome = findChrome();
  if (!chrome) throw new Error(browserSearchHint());

  const timeoutMs = options.timeoutMs ?? 30_000;
  const idleMs = options.idleMs ?? 2_500;
  const headless = options.headless ?? !options.interactive;
  const onProgress = options.onProgress ?? (() => {});
  const profile = mkdtempSync(join(tmpdir(), 'harspec-chrome-'));
  const port = 9000 + Math.floor(Math.random() * 1000);

  const launch = (isHeadless: boolean): ChildProcess =>
    spawn(
      chrome,
      [
        ...(isHeadless ? ['--headless=new'] : []),
        `--remote-debugging-port=${port}`,
        `--user-data-dir=${profile}`,
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-gpu',
        '--disable-dev-shm-usage',
        '--hide-scrollbars',
        '--window-size=1440,900',
        'about:blank',
      ],
      { stdio: 'ignore', detached: false },
    );

  let child = launch(headless);

  const cleanup = () => {
    try {
      child.kill('SIGKILL');
    } catch {
      // ignore
    }
    try {
      rmSync(profile, { recursive: true, force: true });
    } catch {
      // ignore
    }
  };

  try {
    onProgress(`starting ${headless ? 'headless ' : ''}browser`);
    // Some builds (Arc, Dia, some Electron shells) refuse to start headless.
    // A windowed run still works and is quieter about it than failing.
    try {
      await waitForDevTools(port, 15_000);
    } catch (error) {
      if (!headless) throw error;
      onProgress('headless mode was refused, starting with a window');
      try {
        child.kill('SIGKILL');
      } catch {
        // ignore
      }
      child = launch(false);
      await waitForDevTools(port, 20_000);
    }
    const target = await createTarget(port);
    const cdp = await Cdp.connect(target.webSocketDebuggerUrl);

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
    await cdp.send('Network.enable', {
      maxTotalBufferSize: 50_000_000,
      maxResourceBufferSize: 10_000_000,
    });

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

    if (options.interactive) {
      // The person drives. harspec never sees or stores a password: if a login
      // is needed, they type it themselves into this window, and we only record
      // the traffic that follows, exactly like DevTools would.
      await waitForUser(options.seconds);
      await settle(3_000);
    } else if (options.scroll !== false) {
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
    await Promise.allSettled(bodyJobs);

    const entries = toEntries(tracked, url);
    cdp.close();
    return entries;
  } finally {
    cleanup();
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

async function waitForDevTools(port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1000) });
      if (response.ok) return;
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
