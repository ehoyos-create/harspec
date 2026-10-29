/**
 * Passive findings: everything here is derived from the capture alone.
 *
 * No request is sent, nothing is probed. These are observations with evidence,
 * which is what makes the report defensible: each finding points at the exact
 * entry in the HAR that proves it.
 */

import type { Entry } from './har.ts';
import { templatize } from './har.ts';

export type Severity = 'critical' | 'high' | 'medium' | 'low' | 'info';

export interface Finding {
  id: string;
  severity: Severity;
  title: string;
  evidence: string;
  impact: string;
  remediation: string;
  entries: number[];
}

const SECURITY_HEADERS = [
  ['content-security-policy', 'CSP', 'medium'],
  ['strict-transport-security', 'HSTS', 'medium'],
  ['x-content-type-options', 'X-Content-Type-Options', 'low'],
  ['x-frame-options', 'X-Frame-Options', 'low'],
  ['referrer-policy', 'Referrer-Policy', 'low'],
] as const;

const ERROR_MARKERS = [
  /at\s+\w+\s+\(.*:\d+:\d+\)/, // stack frame
  /\b(SQLITE_ERROR|ER_PARSE_ERROR|SequelizeDatabaseError|PostgreSQL|SQLSTATE)\b/i,
  /\b(TypeError|ReferenceError|Cannot read propert)\b.*\n\s+at /,
  /Traceback \(most recent call last\)/,
  /\bat Object\.<anonymous> \(/,
];

const DEBUG_PATHS = /\/(debug|_debug|env|\.env|actuator|metrics|healthz?|swagger|api-docs|graphiql|__debug__|phpinfo)(\/|$)/i;

export function passiveFindings(entries: Entry[]): Finding[] {
  const findings: Finding[] = [];
  const push = (f: Finding) => findings.push(f);

  // 1. Plaintext transport
  const insecure = entries.filter((e) => e.url.startsWith('http://'));
  if (insecure.length) {
    push({
      id: 'transport/plaintext',
      severity: 'high',
      title: 'Traffic sent over plaintext HTTP',
      evidence: `${insecure.length} request(s) over http://, e.g. ${insecure[0].method} ${insecure[0].url}`,
      impact: 'Everything in transit — tokens, session cookies, personal data — is readable by anyone on the path.',
      remediation: 'Serve everything over HTTPS and redirect HTTP with HSTS.',
      entries: insecure.map((e) => e.index),
    });
  }

  // 2. Missing security headers on documents
  const documents = entries.filter((e) => e.kind === 'document' || e.mime.includes('text/html'));
  if (documents.length) {
    const missing = SECURITY_HEADERS.filter(([header]) => documents.every((d) => !d.resHeaders[header]));
    if (missing.length) {
      push({
        id: 'headers/missing',
        severity: 'medium',
        title: `${missing.length} security header(s) absent on HTML responses`,
        evidence: `Not present on ${documents[0].url}: ${missing.map(([, name]) => name).join(', ')}`,
        impact: 'Weaker default posture against clickjacking, MIME sniffing and injected scripts.',
        remediation: 'Add the missing headers at the edge or in the app server.',
        entries: documents.map((e) => e.index),
      });
    }
  }

  // 3. CORS wildcard with credentials
  const corsWildcard = entries.filter((e) => (e.resHeaders['access-control-allow-origin'] ?? '') === '*');
  const corsCreds = entries.filter(
    (e) => (e.resHeaders['access-control-allow-credentials'] ?? '').toLowerCase() === 'true',
  );
  if (corsWildcard.length && corsCreds.length) {
    push({
      id: 'cors/wildcard-credentials',
      severity: 'high',
      title: 'CORS allows any origin together with credentials',
      evidence: `Access-Control-Allow-Origin: * with Access-Control-Allow-Credentials: true on ${corsWildcard[0].url}`,
      impact: 'Any site the user visits can read authenticated responses from this API.',
      remediation: 'Reflect an explicit allowlist of origins when credentials are enabled.',
      entries: [...corsWildcard, ...corsCreds].map((e) => e.index),
    });
  } else if (corsWildcard.length) {
    push({
      id: 'cors/wildcard',
      severity: 'low',
      title: 'CORS allows any origin',
      evidence: `Access-Control-Allow-Origin: * on ${corsWildcard[0].url}`,
      impact: 'Fine for public read-only endpoints; risky if any of them return user data.',
      remediation: 'Restrict to known origins if the response contains anything user-specific.',
      entries: corsWildcard.map((e) => e.index),
    });
  }

  // 4. Cookie flags
  const setCookies = entries
    .map((e) => ({ entry: e, raw: e.resHeaders['set-cookie'] ?? '' }))
    .filter((c) => c.raw.length > 0);

  for (const { entry, raw } of setCookies) {
    const cookies = raw.split(/,(?=[^;]+?=)/).map((c) => c.trim());
    for (const cookie of cookies) {
      const name = cookie.split('=')[0]?.trim() ?? 'cookie';
      const lower = cookie.toLowerCase();
      const problems: string[] = [];
      if (!lower.includes('httponly')) problems.push('HttpOnly');
      if (!lower.includes('secure')) problems.push('Secure');
      if (!lower.includes('samesite')) problems.push('SameSite');
      if (!problems.length) continue;
      push({
        id: `cookies/flags/${name}`,
        severity: problems.includes('HttpOnly') ? 'medium' : 'low',
        title: `Cookie "${name}" is missing ${problems.join(', ')}`,
        evidence: `Set-Cookie on ${entry.url}: ${cookie.slice(0, 140)}`,
        impact:
          problems.includes('HttpOnly')
            ? 'Readable from JavaScript, so any XSS becomes full session theft.'
            : 'Can be sent over plaintext or cross-site.',
        remediation: `Add ${problems.join(', ')} to the Set-Cookie attributes.`,
        entries: [entry.index],
      });
    }
  }

  // 5. Tokens in the URL
  const tokenQuery = entries.filter((e) =>
    Object.keys(e.query).some((k) => /^(token|access_token|api_key|apikey|key|password|pwd|secret)$/i.test(k)),
  );
  if (tokenQuery.length) {
    const key = Object.keys(tokenQuery[0].query).find((k) =>
      /^(token|access_token|api_key|apikey|key|password|pwd|secret)$/i.test(k),
    );
    push({
      id: 'secrets/query-string',
      severity: 'high',
      title: 'Secret-looking parameter sent in the query string',
      evidence: `${tokenQuery[0].method} ${tokenQuery[0].pathname}?${key}=… (${tokenQuery.length} occurrence(s))`,
      impact: 'Query strings land in proxy logs, browser history, Referer headers and analytics.',
      remediation: 'Move the value to the Authorization header or a request body.',
      entries: tokenQuery.map((e) => e.index),
    });
  }

  // 6. Version disclosure
  const disclosure = entries.filter((e) => e.resHeaders['server'] || e.resHeaders['x-powered-by']);
  if (disclosure.length) {
    const sample = disclosure[0];
    const header = sample.resHeaders['x-powered-by'] ? 'X-Powered-By' : 'Server';
    push({
      id: 'fingerprint/version-disclosure',
      severity: 'info',
      title: 'Stack version disclosed in response headers',
      evidence: `${header}: ${sample.resHeaders[header.toLowerCase()]}`,
      impact: 'Makes it trivial to look up known CVEs for that exact version.',
      remediation: 'Remove or genericise the header at the reverse proxy.',
      entries: disclosure.map((e) => e.index),
    });
  }

  // 7. Verbose errors
  const verbose = entries.filter((e) => e.status >= 500 && ERROR_MARKERS.some((rx) => rx.test(e.resText)));
  if (verbose.length) {
    push({
      id: 'errors/verbose',
      severity: 'medium',
      title: 'Server errors expose internal details',
      evidence: `${verbose[0].method} ${verbose[0].pathname} returned ${verbose[0].status} with a stack trace or database error`,
      impact: 'Leaks file paths, framework versions and query structure to an attacker.',
      remediation: 'Return a generic error body and log details server-side only.',
      entries: verbose.map((e) => e.index),
    });
  }

  // 8. Debug / ops endpoints reachable
  const debug = entries.filter((e) => DEBUG_PATHS.test(e.pathname) && e.status >= 200 && e.status < 300);
  if (debug.length) {
    push({
      id: 'surface/debug-endpoints',
      severity: 'high',
      title: 'Debug or operational endpoints respond successfully',
      evidence: debug.map((e) => `${e.method} ${e.pathname} → ${e.status}`).join('; '),
      impact: 'Environment dumps, metrics and docs often expose credentials or internal topology.',
      remediation: 'Disable these routes in production or require admin auth.',
      entries: debug.map((e) => e.index),
    });
  }

  // 9. GraphQL introspection
  const graphql = entries.filter(
    (e) => /graphql/i.test(e.pathname) && /__schema|__type/i.test(e.resText ?? ''),
  );
  if (graphql.length) {
    push({
      id: 'graphql/introspection',
      severity: 'medium',
      title: 'GraphQL introspection is enabled',
      evidence: `${graphql[0].method} ${graphql[0].pathname} returned schema metadata`,
      impact: 'The full API schema — every type, field and mutation — is enumerable by anyone.',
      remediation: 'Disable introspection in production or gate it behind admin auth.',
      entries: graphql.map((e) => e.index),
    });
  }

  // 10. IDOR candidates: same route, different ids, both 2xx, authenticated
  const byTemplate = new Map<string, Entry[]>();
  for (const entry of entries) {
    if (!/\{id\}/.test(templatize(entry.pathname).template)) continue;
    if (entry.status < 200 || entry.status >= 300) continue;
    const key = `${entry.method} ${templatize(entry.pathname).template}`;
    const list = byTemplate.get(key) ?? [];
    list.push(entry);
    byTemplate.set(key, list);
  }

  for (const [key, list] of byTemplate) {
    const ids = new Set(
      list.map((e) => {
        const segments = e.pathname.split('/').filter(Boolean);
        const template = templatize(e.pathname).template.split('/').filter(Boolean);
        const idx = template.findIndex((s) => s === '{id}');
        return segments[idx];
      }),
    );
    if (ids.size < 2) continue;

    const authenticated = list.some((e) => (e.reqHeaders.authorization ?? '').length > 0);

    // Unauthenticated reads of a public catalogue are not an access-control
    // problem. Only flag them when the object itself looks user-scoped.
    if (!authenticated) {
      const userScoped = list.some(
        (e) =>
          e.resBody &&
          typeof e.resBody === 'object' &&
          Object.keys(e.resBody).some((k) =>
            /(email|password|role|balance|address|phone|ssn|token|account)/i.test(k),
          ),
      );
      if (!userScoped) continue;
    }

    push({
      id: `access-control/idor-candidate/${key.replace(/\s+/g, '-').toLowerCase()}`,
      severity: authenticated ? 'high' : 'medium',
      title: 'Object access by raw identifier looks unchecked',
      evidence: `${ids.size} distinct ids returned 2xx on ${key}: ${[...ids].slice(0, 3).join(', ')}`,
      impact:
        'If the server does not verify ownership, changing the id returns another user\'s object. This is a candidate, not a confirmed bug — confirm with an account that should not have access.',
      remediation: 'Authorise every object read against the caller, not just the id in the URL.',
      entries: list.map((e) => e.index),
    });
  }

  return findings;
}

export function severityRank(severity: Severity): number {
  return { critical: 0, high: 1, medium: 2, low: 3, info: 4 }[severity] ?? 5;
}

export function renderReportMarkdown(input: {
  target: string;
  capturedAt: string;
  entries: Entry[];
  operations: number;
  findings: Finding[];
}): string {
  const { target, capturedAt, entries, operations, findings } = input;
  const sorted = [...findings].sort((a, b) => severityRank(a.severity) - severityRank(b.severity));
  const counts = sorted.reduce<Record<string, number>>((acc, f) => {
    acc[f.severity] = (acc[f.severity] ?? 0) + 1;
    return acc;
  }, {});

  const lines: string[] = [];
  lines.push(`# Traffic analysis: ${target}`);
  lines.push('');
  lines.push(`Capture: ${capturedAt || 'unknown'} · ${entries.length} requests · ${operations} operations reconstructed`);
  lines.push('');
  lines.push('## Summary');
  lines.push('');
  lines.push('| Severity | Count |');
  lines.push('|---|---|');
  for (const severity of ['critical', 'high', 'medium', 'low', 'info'] as Severity[]) {
    if (counts[severity]) lines.push(`| ${severity} | ${counts[severity]} |`);
  }
  if (!sorted.length) {
    lines.push('| — | 0 |');
    lines.push('');
    lines.push('No findings from the passive checks.');
  }
  lines.push('');

  if (sorted.length) {
    lines.push('## Findings');
    lines.push('');
    for (const finding of sorted) {
      lines.push(`### ${finding.severity.toUpperCase()} · ${finding.title}`);
      lines.push('');
      lines.push(`- **Evidence:** ${finding.evidence}`);
      lines.push(`- **Impact:** ${finding.impact}`);
      lines.push(`- **Fix:** ${finding.remediation}`);
      lines.push(`- **HAR entries:** ${finding.entries.slice(0, 8).join(', ')}${finding.entries.length > 8 ? '…' : ''}`);
      lines.push('');
    }
  }

  lines.push('---');
  lines.push('');
  lines.push('Generated by harspec. Passive analysis only: no request was sent beyond the capture.');
  lines.push('');
  return lines.join('\n');
}
