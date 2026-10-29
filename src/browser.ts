/**
 * Browser: a minimal Chrome DevTools Protocol client.
 *
 * No dependencies. Node ships a global WebSocket, so the whole thing is a few
 * hundred lines instead of a 300 MB Playwright install. It runs on the user's
 * machine, with the user's network, which is also why it does not need to defeat
 * any bot protection: it is a real browser doing normal browsing.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Any Chromium-family browser works, because they all speak the same protocol.
 * Keeping the list wide matters: most people do not have plain Chrome installed.
 */
/**
 * Browsers we would rather drive first. They are plain Chromium builds: no
 * daily-driver state, no window manager of their own, no "please update" flow.
 */
const PREFERRED_APPS = [
  'Google Chrome',
  'Google Chrome Beta',
  'Google Chrome Canary',
  'Chromium',
  'Microsoft Edge',
  'Brave Browser',
  'Vivaldi',
];

/**
 * Chromium-family browsers that work but are a bad default: Arc and Dia are
 * someone's actual browser, and launching a second copy of one while it is
 * already running is both rude and flaky (the running instance can answer for
 * the new one, and the debug port ends up attached to the wrong renderer).
 * Kept as a last resort, after the headless builds that ship with Playwright
 * and Puppeteer.
 */
const SHELL_APPS = ['Arc', 'Dia', 'Opera', 'Sidekick', 'SigmaOS'];

const MAC_APPS = [...PREFERRED_APPS, ...SHELL_APPS];

function macCandidates(apps: string[] = MAC_APPS): string[] {
  const roots = ['/Applications', join(homedir(), 'Applications')];
  const out: string[] = [];
  for (const root of roots) {
    for (const app of apps) {
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
  return [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe',
  ];
}

/**
 * Headless Chromium builds that Playwright and Puppeteer already downloaded.
 *
 * This is the common case on a developer machine, and it is the best case for
 * us too: a real Chromium with no profile of its own, no window, and no chance
 * of colliding with the browser the person is using. Using it turns "no
 * Chromium found" into "it just works" for anyone who has ever run a test.
 */
function cacheCandidates(): string[] {
  const out: string[] = [];
  const listDir = (dir: string): string[] => {
    try {
      return readdirSync(dir);
    } catch {
      return [];
    }
  };

  // Playwright: <cache>/chromium-<rev>/chrome-mac/Chromium.app/.../Chromium
  const playwrightRoots = [
    process.env.PLAYWRIGHT_BROWSERS_PATH,
    join(homedir(), 'Library/Caches/ms-playwright'),
    join(homedir(), '.cache/ms-playwright'),
  ].filter(Boolean) as string[];
  for (const root of playwrightRoots) {
    for (const entry of listDir(root)) {
      if (!/^(chromium|chromium_headless_shell)-/.test(entry)) continue;
      out.push(join(root, entry, 'chrome-mac/Chromium.app/Contents/MacOS/Chromium'));
      out.push(join(root, entry, 'chrome-mac-arm64/Chromium.app/Contents/MacOS/Chromium'));
      out.push(join(root, entry, 'chrome-linux/chrome'));
      out.push(join(root, entry, 'chrome-linux64/chrome'));
      out.push(join(root, entry, 'chrome-win/chrome.exe'));
    }
  }

  // Puppeteer: <cache>/chrome/<platform>-<version>/chrome-mac-arm64/Google Chrome for Testing.app/...
  const puppeteerRoots = [
    process.env.PUPPETEER_CACHE_DIR,
    join(homedir(), '.cache/puppeteer'),
    join(homedir(), 'Library/Caches/puppeteer'),
  ].filter(Boolean) as string[];
  for (const root of puppeteerRoots) {
    for (const product of ['chrome', 'chrome-headless-shell']) {
      for (const version of listDir(join(root, product))) {
        const base = join(root, product, version);
        out.push(join(base, 'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'));
        out.push(join(base, 'chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'));
        out.push(join(base, 'chrome-mac/Chromium.app/Contents/MacOS/Chromium'));
        out.push(join(base, 'chrome-linux64/chrome'));
        out.push(join(base, 'chrome-linux/chrome'));
        out.push(join(base, 'chrome-win64/chrome.exe'));
        out.push(join(base, 'chrome-headless-shell-mac-arm64/chrome-headless-shell'));
        out.push(join(base, 'chrome-headless-shell-linux64/chrome-headless-shell'));
      }
    }
  }

  return out;
}

function scanCandidates(): string[] {
  const explicit = [process.env.HARSPEC_CHROME].filter(Boolean) as string[];
  const list = [
    ...explicit,
    ...macCandidates(PREFERRED_APPS),
    ...linuxCandidates(),
    ...windowsCandidates(),
    // Cached headless builds come before the browsers people actually use:
    // driving someone's open Arc/Dia is the flakiest path we have.
    ...cacheCandidates(),
    ...macCandidates(SHELL_APPS),
  ];

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

export class Cdp {
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

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
  return (await response.json()) as { webSocketDebuggerUrl: string };
}

export interface BrowserSession {
  cdp: Cdp;
  /** The Chromium version string reported by the DevTools endpoint. */
  version: string;
  close: () => void;
}

export interface BrowserOptions {
  headless?: boolean;
  width?: number;
  height?: number;
  onProgress?: (message: string) => void;
}

/**
 * Start a browser, open a tab and connect to it. Any Chromium-family build
 * works, including ones that refuse `--headless` and need a window instead.
 */
export async function openBrowser(options: BrowserOptions = {}): Promise<BrowserSession> {
  const chrome = findChrome();
  if (!chrome) throw new Error(browserSearchHint());

  const headless = options.headless ?? true;
  const onProgress = options.onProgress ?? (() => {});
  const width = options.width ?? 1440;
  const height = options.height ?? 900;
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
        `--window-size=${width},${height}`,
        'about:blank',
      ],
      { stdio: 'ignore', detached: false },
    );

  let child = launch(headless);

  const close = () => {
    try {
      child.kill('SIGKILL');
    } catch {
      // ignore
    }
    try {
      // The browser can hold files open for a moment after the kill signal.
      rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 });
    } catch {
      // a leftover temp profile is not worth failing a run over
    }
  };

  try {
    onProgress(`starting ${headless ? 'headless ' : ''}browser`);
    // Some builds (Arc, Dia, some Electron shells) refuse to start headless.
    // A windowed run still works and is quieter about it than failing.
    let version = '';
    try {
      version = await waitForDevTools(port, 15_000);
    } catch (error) {
      if (!headless) throw error;
      onProgress('headless mode was refused, starting with a window');
      try {
        child.kill('SIGKILL');
      } catch {
        // ignore
      }
      child = launch(false);
      version = await waitForDevTools(port, 20_000);
    }

    const target = await createTarget(port);
    const cdp = await Cdp.connect(target.webSocketDebuggerUrl);
    void width;
    void height;
    return { cdp, version, close };
  } catch (error) {
    close();
    throw error;
  }
}

/**
 * Pin the layout viewport.
 *
 * A tab created over the DevTools endpoint is not always attached to a sized
 * window: it can report a 0x0 viewport, and apps that size themselves from the
 * window then render into nothing. Worse, some apps only lay out their real UI
 * after an explicit metrics change. Pinning is also what makes a capture
 * reproducible: the same 1440x900 every run, whatever the machine.
 */
export async function pinViewport(cdp: Cdp, width = 1440, height = 900): Promise<void> {
  await cdp
    .send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false })
    .catch(() => {});
}

/** Evaluate an expression in the page and return its value. */
export async function evaluateValue<T = any>(cdp: Cdp, expression: string, timeoutMs = 20_000): Promise<T> {
  const result = await Promise.race([
    cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }),
    new Promise((_, reject) => setTimeout(() => reject(new Error('evaluation timed out')), timeoutMs)),
  ]);
  const response = result as any;
  if (response?.exceptionDetails) throw new Error(response.exceptionDetails.text ?? 'page evaluation failed');
  return response?.result?.value as T;
}

/**
 * Every scroll container, not just the window.
 *
 * Modern app shells (YouTube Music, Gmail, Slack, anything with a fixed header
 * and a `main` that scrolls) keep their scroll position on an element, not on
 * the document. Scrolling only the window leaves those apps untouched, which
 * is how a "full page" screenshot ends up showing the middle of the page and
 * no header at all.
 */
const SCROLLABLE = `(() => {
  const allowed = /(auto|scroll|overlay)/;
  return [document.scrollingElement, ...document.querySelectorAll('*')].filter((el) => {
    if (!el || el === document.scrollingElement) return !!el;
    if (el.scrollHeight <= el.clientHeight + 2 && el.scrollWidth <= el.clientWidth + 2) return false;
    const cs = getComputedStyle(el);
    return allowed.test(cs.overflowY) || allowed.test(cs.overflowX);
  });
})()`;

/** Scroll every container to the bottom and back, so lazy content exists. */
export async function scrollThrough(cdp: Cdp, onProgress: (message: string) => void = () => {}): Promise<void> {
  const total = await evaluateValue<number>(cdp, 'document.documentElement.scrollHeight').catch(() => 0);
  if (typeof total !== 'number' || total <= 1200) return;
  onProgress('scrolling to render everything below the fold');
  for (const fraction of [0.4, 0.75, 1, 0.5, 0]) {
    await evaluateValue(
      cdp,
      `(() => {
        const targets = ${SCROLLABLE};
        for (const el of targets) {
          const distance = Math.max(0, (el.scrollHeight || 0) - (el.clientHeight || 0));
          if (el === document.scrollingElement) window.scrollTo({ top: distance * ${fraction}, behavior: 'instant' });
          else el.scrollTop = distance * ${fraction};
        }
        return true;
      })()`,
    ).catch(() => {});
    await sleep(450);
  }
  await sleep(500);
}

/** Put every scroller back at the top, where the screenshot will be taken. */
export async function resetScroll(cdp: Cdp): Promise<void> {
  await evaluateValue(
    cdp,
    `(() => {
      window.scrollTo(0, 0);
      for (const el of ${SCROLLABLE}) el.scrollTop = 0, el.scrollLeft = 0;
      // Shadow roots hold the real scroller in several app shells.
      const visit = (root) => {
        for (const el of root.querySelectorAll('*')) {
          if (el.scrollTop) el.scrollTop = 0;
          if (el.shadowRoot) visit(el.shadowRoot);
        }
      };
      visit(document);
      return true;
    })()`,
  ).catch(() => {});
  await sleep(250);
}

/**
 * Identify as plain Chrome, not as whatever shell we happen to be driving.
 *
 * This is not evasion: it is the truth about the engine. Dia, Arc, Brave and
 * headless Chromium are all Chromium, but a few large sites read
 * `navigator.userAgentData.brands` and answer with "your browser is not
 * supported" instead of rendering. Telling them the engine we actually run is
 * the difference between measuring the app and measuring a warning page.
 */
export async function applyChromeIdentity(cdp: Cdp, version: string): Promise<void> {
  const major = version.match(/(\d+)\./)?.[1] ?? '126';
  const fullVersion = `${major}.0.0.0`;
  const macOS = process.platform === 'darwin';
  const windows = process.platform === 'win32';
  const platform = macOS ? 'macOS' : windows ? 'Windows' : 'Linux';
  const platformName = macOS ? 'MacIntel' : windows ? 'Win32' : 'Linux x86_64';

  await cdp
    .send('Network.setUserAgentOverride', {
      userAgent: macOS
        ? `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${fullVersion} Safari/537.36`
        : windows
          ? `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${fullVersion} Safari/537.36`
          : `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${fullVersion} Safari/537.36`,
      acceptLanguage: 'en-US,en;q=0.9',
      platform: platformName,
      userAgentMetadata: {
        brands: [
          { brand: 'Chromium', version: major },
          { brand: 'Google Chrome', version: major },
          { brand: 'Not/A)Brand', version: '24' },
        ],
        fullVersionList: [
          { brand: 'Chromium', version: fullVersion },
          { brand: 'Google Chrome', version: fullVersion },
          { brand: 'Not/A)Brand', version: '24.0.0.0' },
        ],
        fullVersion,
        platform,
        platformVersion: macOS ? '14.0.0' : windows ? '10.0.0' : '6.5.0',
        architecture: macOS ? 'arm' : 'x86',
        model: '',
        mobile: false,
        bitness: '64',
        wow64: false,
      },
    })
    .catch(() => {});
}

/**
 * Bound a promise. Used on whole captures: a renderer that stops responding
 * will never fail on its own, and a tool that hangs is worse than one that
 * reports a bad run and tries again.
 */
export async function withDeadline<T>(work: Promise<T>, ms: number, onTimeout?: () => void): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          try {
            onTimeout?.();
          } catch {
            // ignore
          }
          reject(new Error(`timed out after ${Math.round(ms / 1000)}s`));
        }, ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
