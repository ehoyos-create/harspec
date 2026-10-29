/**
 * Bundle scanning.
 *
 * Reads the JavaScript a browser would already download and looks for the things
 * that end up in real findings: leaked keys, exposed source maps, internal hosts.
 *
 * `inspectSource` is pure: give it text and it returns findings. `scanBundles`
 * is the HAR-driven wrapper that fetches first.
 */

import type { Entry } from './har.ts';
import type { Finding } from './report.ts';

const SECRETS: Array<{ id: string; label: string; rx: RegExp; severity: Finding['severity'] }> = [
  { id: 'aws', label: 'AWS access key', rx: /\bAKIA[0-9A-Z]{16}\b/g, severity: 'critical' },
  { id: 'stripe', label: 'Stripe secret key', rx: /\bsk_live_[0-9A-Za-z]{16,}\b/g, severity: 'critical' },
  { id: 'google', label: 'Google API key', rx: /\bAIza[0-9A-Za-z_-]{35}\b/g, severity: 'high' },
  { id: 'github', label: 'GitHub token', rx: /\bgh[pousr]_[0-9A-Za-z]{36,}\b/g, severity: 'critical' },
  { id: 'slack', label: 'Slack token', rx: /\bxox[baprs]-[0-9A-Za-z-]{10,}\b/g, severity: 'critical' },
  { id: 'private-key', label: 'Private key block', rx: /-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----/g, severity: 'critical' },
  { id: 'sendgrid', label: 'SendGrid key', rx: /\bSG\.[0-9A-Za-z_-]{22}\.[0-9A-Za-z_-]{43}\b/g, severity: 'critical' },
  {
    id: 'generic',
    label: 'Hardcoded credential',
    rx: /(?:api[_-]?key|secret|passwd|password|token)\s*[:=]\s*["']([A-Za-z0-9_\-.@]{16,})["']/gi,
    severity: 'high',
  },
];

const FALSE_POSITIVE = /(example|your[_-]?|xxxx|placeholder|changeme|test[_-]?key|process\.env|import\.meta\.env)/i;

const INTERNAL_HOST_RX =
  /https?:\/\/([a-z0-9.-]+\.(?:internal|local|svc|cluster\.local)|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(?:1[6-9]|2\d|3[01])\.\d+\.\d+)(?::\d+)?/gi;

/** Findings derivable from one JavaScript file, with no network access. */
export function inspectSource(source: string, url: string, entries: Entry[] = []): Finding[] {
  const findings: Finding[] = [];
  const fileName = url.split('/').pop() ?? url;
  const related = entries.filter((e) => e.url === url).map((e) => e.index);

  // Source maps
  const mapRef = source.match(/[#@]\s*sourceMappingURL=(\S+)/);
  if (mapRef) {
    findings.push({
      id: `sourcemap/${url}`,
      severity: 'high',
      title: 'Source maps are referenced and potentially public',
      evidence: `${fileName} declares ${mapRef[1]}`,
      impact:
        'The original, unminified source — comments included — can be reconstructed. Any logic hidden by minification is exposed.',
      remediation: 'Do not publish .map files in production, or restrict them to authenticated internal users.',
      entries: related,
    });
  }

  // Secrets
  let specificFound = false;
  for (const rule of SECRETS) {
    if (rule.id === 'generic' && specificFound) continue;
    rule.rx.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = rule.rx.exec(source))) {
      const raw = match[0];
      if (FALSE_POSITIVE.test(raw)) continue;
      findings.push({
        id: `secret/${rule.id}/${url}`,
        severity: rule.severity,
        title: `${rule.label} found in a client bundle`,
        evidence: `${fileName}: ${raw.slice(0, 24)}…`,
        impact: 'Anything shipped to the browser is public. This key is compromised the moment it is deployed.',
        remediation: 'Rotate the key immediately and move the call behind a server-side proxy.',
        entries: related,
      });
      if (rule.id !== 'generic') specificFound = true;
      break;
    }
  }

  // Internal hosts
  const hosts = new Set<string>();
  let hostMatch: RegExpExecArray | null;
  INTERNAL_HOST_RX.lastIndex = 0;
  while ((hostMatch = INTERNAL_HOST_RX.exec(source))) hosts.add(hostMatch[0]);
  if (hosts.size) {
    findings.push({
      id: `internal-host/${url}`,
      severity: 'medium',
      title: 'Internal hostnames leaked in the bundle',
      evidence: [...hosts].slice(0, 5).join(', '),
      impact: 'Maps the private network for anyone reading the JavaScript.',
      remediation: 'Build these values in at deploy time from server-side config.',
      entries: related,
    });
  }

  return findings;
}

export interface ScanOptions {
  maxScripts?: number;
  maxBytes?: number;
  timeoutMs?: number;
  onProgress?: (message: string) => void;
}

export function scriptUrls(entries: Entry[]): string[] {
  const urls = new Set<string>();
  for (const entry of entries) {
    const isScript = entry.kind === 'script' || /\.(js|mjs)(\?|$)/i.test(entry.pathname);
    if (isScript && entry.status >= 200 && entry.status < 400) urls.add(entry.url);
  }
  return [...urls];
}

export async function getText(url: string, timeoutMs = 12_000, maxBytes = 4_000_000): Promise<string | undefined> {
  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { 'user-agent': 'harspec/0.1 (+https://github.com/harspec)' },
    });
    if (!response.ok) return undefined;
    const reader = response.body?.getReader();
    if (!reader) return await response.text();

    const chunks: Uint8Array[] = [];
    let total = 0;
    while (total < maxBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        chunks.push(value);
        total += value.byteLength;
      }
    }
    reader.cancel().catch(() => {});
    return new TextDecoder().decode(Buffer.concat(chunks.map((c) => Buffer.from(c))));
  } catch {
    return undefined;
  }
}

export async function scanBundles(entries: Entry[], options: ScanOptions = {}): Promise<Finding[]> {
  const findings: Finding[] = [];
  const maxScripts = options.maxScripts ?? 15;
  const urls = scriptUrls(entries).slice(0, maxScripts);

  for (const url of urls) {
    options.onProgress?.(`scanning ${url.split('/').pop()}`);
    const source = await getText(url, options.timeoutMs ?? 12_000, options.maxBytes ?? 4_000_000);
    if (!source) continue;
    findings.push(...inspectSource(source, url, entries));
  }

  return findings;
}

/** Confirm whether a referenced source map actually resolves. */
export async function sourceMapResolves(mapUrl: string, timeoutMs = 8000): Promise<boolean> {
  try {
    const response = await fetch(mapUrl, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { 'user-agent': 'harspec/0.1' },
    });
    return response.ok;
  } catch {
    return false;
  }
}
