/**
 * Active checks. These send requests, so they only run when the host is in an
 * explicit allowlist. The default allowlist is empty; the CLI only populates it
 * for localhost unless the operator names a host on the command line.
 *
 * What it does: replay a captured request with one field tampered, and see
 * whether the server accepts it. That is how you prove "this validation only
 * exists in the browser".
 */

import type { Cluster, Entry } from './har.ts';
import type { Finding } from './report.ts';
import { isObject } from './util.ts';

export interface ReplayOptions {
  allowHosts: string[];
  timeoutMs?: number;
  onProgress?: (message: string) => void;
}

interface Candidate {
  path: string[];
  field: string;
  value: any;
  kind: 'money' | 'quantity' | 'email' | 'privilege' | 'identifier';
}

const MONEY_FIELD = /(price|total|amount|subtotal|cost|discount|balance|credit|fee|rate|value)/i;
const QUANTITY_FIELD = /(qty|quantity|count|units)/i;
const EMAIL_FIELD = /e?mail/i;
const PRIVILEGE_FIELD = /(role|is_?admin|admin|permission|scope|plan|tier)/i;
const IDENTIFIER_FIELD = /(user_?id|owner_?id|account_?id|tenant_?id|customer_?id)/i;

function collectCandidates(value: any, path: string[] = [], depth = 0): Candidate[] {
  if (!isObject(value) || depth > 2) return [];
  const out: Candidate[] = [];

  for (const [key, fieldValue] of Object.entries(value)) {
    const here = [...path, key];

    if (typeof fieldValue === 'number') {
      if (MONEY_FIELD.test(key) && !QUANTITY_FIELD.test(key)) {
        out.push({ path: here, field: key, value: 0, kind: 'money' });
      } else if (QUANTITY_FIELD.test(key)) {
        out.push({ path: here, field: key, value: -1, kind: 'quantity' });
      } else if (IDENTIFIER_FIELD.test(key)) {
        out.push({ path: here, field: key, value: fieldValue + 1, kind: 'identifier' });
      }
    }

    if (typeof fieldValue === 'boolean' && PRIVILEGE_FIELD.test(key)) {
      out.push({ path: here, field: key, value: !fieldValue, kind: 'privilege' });
    }

    if (typeof fieldValue === 'string') {
      if (EMAIL_FIELD.test(key)) out.push({ path: here, field: key, value: 'not-an-email', kind: 'email' });
      else if (PRIVILEGE_FIELD.test(key)) out.push({ path: here, field: key, value: 'admin', kind: 'privilege' });
    }

    if (isObject(fieldValue)) out.push(...collectCandidates(fieldValue, here, depth + 1));
  }

  return out;
}

function applyTamper(body: any, candidate: Candidate): any {
  const clone = JSON.parse(JSON.stringify(body));
  let cursor = clone;
  for (const key of candidate.path.slice(0, -1)) {
    cursor = cursor?.[key];
    if (!cursor) return clone;
  }
  cursor[candidate.path[candidate.path.length - 1]] = candidate.value;
  return clone;
}

function forwardableHeaders(entry: Entry): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(entry.reqHeaders)) {
    if (/^(content-length|host|connection|accept-encoding|content-type)$/.test(key)) continue;
    headers[key] = value;
  }
  headers['content-type'] = 'application/json';
  return headers;
}

function buildUrl(entry: Entry): string {
  const url = new URL(entry.url);
  return url.toString();
}

export async function activeFindings(clusters: Cluster[], options: ReplayOptions): Promise<Finding[]> {
  const findings: Finding[] = [];
  const timeoutMs = options.timeoutMs ?? 8000;
  const allow = new Set(
    options.allowHosts
      .map((h) => h.toLowerCase().trim())
      .filter(Boolean)
      .map((h) => {
        try {
          return new URL(h.includes('://') ? h : `http://${h}`).hostname.toLowerCase();
        } catch {
          return h;
        }
      }),
  );

  for (const cluster of clusters) {
    if (!['POST', 'PUT', 'PATCH'].includes(cluster.method)) continue;

    const entry = cluster.entries.find((e) => isObject(e.reqBody));
    if (!entry) continue;

    let hostname = '';
    try {
      hostname = new URL(entry.url).hostname.toLowerCase();
    } catch {
      continue;
    }
    if (!allow.has(hostname)) continue;
    if (entry.status < 200 || entry.status >= 300) continue;

    const candidates = collectCandidates(entry.reqBody);
    for (const candidate of candidates) {
      const tampered = applyTamper(entry.reqBody, candidate);

      let response: Response;
      try {
        response = await fetch(buildUrl(entry), {
          method: entry.method,
          headers: forwardableHeaders(entry),
          body: JSON.stringify(tampered),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (error: any) {
        options.onProgress?.(`replay failed for ${entry.method} ${entry.pathname}: ${error?.message ?? error}`);
        continue;
      }

      const text = await response.text();

      if (response.status >= 200 && response.status < 300) {
        findings.push(findingFor(cluster, entry, candidate, response.status, text));
      }
    }
  }

  return findings;
}

function findingFor(
  cluster: Cluster,
  entry: Entry,
  candidate: Candidate,
  status: number,
  body: string,
): Finding {
  const target = `${entry.method} ${cluster.template}`;
  const evidence = `${target} accepted \`${candidate.field}\` set to ${JSON.stringify(candidate.value)} (HTTP ${status}). Response: ${body.slice(0, 120)}`;

  if (candidate.kind === 'money') {
    return {
      id: `price-tampering/${target}`,
      severity: 'critical',
      title: `Server trusts client-supplied \`${candidate.field}\``,
      evidence,
      impact: 'Anyone can send their own price. This is direct monetary loss, not a theoretical risk.',
      remediation: `Ignore \`${candidate.field}\` from the client and recompute it server-side from the referenced objects.`,
      entries: [entry.index],
    };
  }

  if (candidate.kind === 'quantity') {
    return {
      id: `negative-quantity/${target}`,
      severity: 'high',
      title: `\`${candidate.field}\` accepts negative values`,
      evidence,
      impact: 'Negative quantities turn into credits and can invert the sign of a transaction.',
      remediation: `Validate \`${candidate.field}\` as a positive integer on the server.`,
      entries: [entry.index],
    };
  }

  if (candidate.kind === 'email') {
    return {
      id: `validation/email/${target}`,
      severity: 'medium',
      title: 'Email validation exists only in the browser',
      evidence,
      impact: 'Bypassing the form is trivial; bad data reaches the database and downstream mailers.',
      remediation: 'Reject malformed addresses on the server too, then normalise before storing.',
      entries: [entry.index],
    };
  }

  if (candidate.kind === 'identifier') {
    return {
      id: `ownership/${target}`,
      severity: 'high',
      title: `\`${candidate.field}\` is taken from the request body`,
      evidence,
      impact: 'If the server does not verify that the caller owns that object, this is a horizontal privilege escalation.',
      remediation: 'Derive the owner from the session, never from the payload.',
      entries: [entry.index],
    };
  }

  return {
    id: `privilege/${target}`,
    severity: 'critical',
    title: `\`${candidate.field}\` is accepted from the client`,
    evidence,
    impact: 'Possible privilege escalation if the value influences authorisation.',
    remediation: `Assign \`${candidate.field}\` server-side from the authenticated identity.`,
    entries: [entry.index],
  };
}
