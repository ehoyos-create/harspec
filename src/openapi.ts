/**
 * OpenAPI 3.1 generation.
 *
 * Everything here is deterministic: same HAR in, same document out. No model
 * calls, no guessing beyond what the traffic proves.
 */

import type { Cluster, Entry } from './har.ts';
import { hasRequestBody, queryParamNames, statusCodes } from './har.ts';
import { inferFromSamples, type Schema } from './infer.ts';
import { camelCase, isObject, pascalCase, titleCase, uniq } from './util.ts';

export interface OpenApiOptions {
  title?: string;
  version?: string;
}

function operationIdFor(cluster: Cluster): string {
  const parts = cluster.template
    .split('/')
    .filter(Boolean)
    .filter((segment) => !/^api$/i.test(segment) && !/^v\d+$/i.test(segment))
    .map((segment) => {
      const param = segment.match(/^\{(.+)\}$/);
      if (param) return `By${pascalCase(param[1])}`;
      return pascalCase(segment);
    });
  return camelCase(`${cluster.method.toLowerCase()} ${parts.join(' ')}`);
}

function summaryFor(cluster: Cluster): string {
  const action = {
    GET: 'Read',
    POST: 'Create',
    PUT: 'Replace',
    PATCH: 'Update',
    DELETE: 'Delete',
    HEAD: 'Inspect',
    OPTIONS: 'Preflight',
  }[cluster.method] ?? cluster.method;

  const words = cluster.template
    .split('/')
    .filter(Boolean)
    .filter((s) => !/^api$/i.test(s) && !/^v\d+$/i.test(s))
    .map((s) => (s.startsWith('{') ? `#${s.replace(/[{}]/g, '')}` : s));

  return `${action} ${titleCase(words.join(' '))}`;
}

function tagFor(cluster: Cluster): string {
  const segments = cluster.template
    .split('/')
    .filter(Boolean)
    .filter((s) => !/^api$/i.test(s) && !/^v\d+$/i.test(s));
  return segments[0] ?? 'root';
}

/** Detect auth scheme from the headers actually seen on the wire. */
export function detectSecurity(entries: Entry[]): { schemes: Record<string, any>; required: string[] } {
  const schemes: Record<string, any> = {};
  const required: string[] = [];

  const bearer = entries.some((e) => /^bearer\s+/i.test(e.reqHeaders.authorization ?? ''));
  const basic = entries.some((e) => /^basic\s+/i.test(e.reqHeaders.authorization ?? ''));
  const apiKeyHeader = entries.find((e) => e.reqHeaders['x-api-key'] !== undefined);
  const tokenQuery = entries.find((e) => e.query.token || e.query.access_token || e.query.api_key);
  const cookie = entries.find((e) => (e.reqHeaders.cookie ?? '').length > 0);

  if (bearer) {
    schemes.bearerAuth = {
      type: 'http',
      scheme: 'bearer',
      description: 'Inferred from `Authorization: Bearer …` observed in the capture.',
    };
    required.push('bearerAuth');
  }
  if (basic) {
    schemes.basicAuth = {
      type: 'http',
      scheme: 'basic',
      description: 'Inferred from `Authorization: Basic …` observed in the capture.',
    };
    required.push('basicAuth');
  }
  if (apiKeyHeader) {
    schemes.apiKeyAuth = {
      type: 'apiKey',
      in: 'header',
      name: 'X-API-Key',
      description: 'Inferred from an `X-API-Key` header observed in the capture.',
    };
    required.push('apiKeyAuth');
  }
  if (tokenQuery && !bearer) {
    const name = ['token', 'access_token', 'api_key'].find((n) => tokenQuery.query[n]) as string;
    schemes.queryToken = {
      type: 'apiKey',
      in: 'query',
      name,
      description: `Inferred from a \`${name}\` query parameter. Tokens in URLs leak into logs and proxies.`,
    };
    required.push('queryToken');
  }
  if (cookie) {
    schemes.cookieAuth = {
      type: 'apiKey',
      in: 'cookie',
      name: 'session',
      description: 'Inferred from a `Cookie` header observed in the capture.',
    };
    required.push('cookieAuth');
  }

  return { schemes, required: uniq(required) };
}

function requestContent(cluster: Cluster): any | undefined {
  if (!hasRequestBody(cluster)) return undefined;
  const samples = cluster.entries.map((e) => e.reqBody).filter((v) => v !== undefined);

  const json = samples.filter((s) => isObject(s) || Array.isArray(s));
  if (json.length) {
    return {
      'application/json': {
        schema: inferFromSamples(json),
      },
    };
  }

  const text = samples.filter((s) => typeof s === 'string');
  if (text.length) {
    return {
      'text/plain': {
        schema: { type: 'string', example: text[0] },
      },
    };
  }

  return undefined;
}

function responsesFor(cluster: Cluster): Record<string, any> {
  const responses: Record<string, any> = {};

  for (const code of statusCodes(cluster)) {
    const forCode = cluster.entries.filter((e) => e.status === code);
    const bodies = forCode.map((e) => e.resBody).filter((v) => v !== undefined);
    const description = statusDescription(code);

    if (!bodies.length) {
      responses[String(code)] = { description };
      continue;
    }

    const json = bodies.filter((b) => isObject(b) || Array.isArray(b));
    if (json.length) {
      responses[String(code)] = {
        description,
        content: { 'application/json': { schema: inferFromSamples(json) } },
      };
    } else {
      responses[String(code)] = {
        description,
        content: { 'text/plain': { schema: { type: 'string', example: String(bodies[0]).slice(0, 200) } } },
      };
    }
  }

  if (!Object.keys(responses).length) {
    responses['200'] = { description: 'Observed in the capture' };
  }

  return responses;
}

function statusDescription(code: number): string {
  const known: Record<number, string> = {
    200: 'OK',
    201: 'Created',
    204: 'No Content',
    301: 'Moved Permanently',
    302: 'Found',
    304: 'Not Modified',
    400: 'Bad Request',
    401: 'Unauthorized',
    403: 'Forbidden',
    404: 'Not Found',
    409: 'Conflict',
    422: 'Unprocessable Entity',
    429: 'Too Many Requests',
    500: 'Internal Server Error',
  };
  return known[code] ?? (code ? `Observed status ${code}` : 'Observed in the capture');
}

function queryParameters(cluster: Cluster): any[] {
  return queryParamNames(cluster).map((name) => {
    const values = cluster.entries.map((e) => e.query[name]).filter((v) => v !== undefined);
    const schema: Schema = { type: 'string' };
    const allNumeric = values.length > 0 && values.every((v) => /^-?\d+$/.test(v));
    if (allNumeric) schema.type = 'integer';
    schema.example = values[0];
    return {
      name,
      in: 'query',
      required: false,
      schema,
    };
  });
}

function pathParameters(cluster: Cluster): any[] {
  return cluster.pathParams.map((name) => ({
    name,
    in: 'path',
    required: true,
    schema: { type: 'string', example: examplePathValue(cluster, name) },
  }));
}

function examplePathValue(cluster: Cluster, name: string): string {
  for (const entry of cluster.entries) {
    const segments = entry.pathname.split('/').filter(Boolean);
    const templateSegments = cluster.template.split('/').filter(Boolean);
    const idx = templateSegments.indexOf(`{${name}}`);
    if (idx >= 0 && segments[idx]) return segments[idx];
  }
  return '1';
}

export function buildOpenApi(clusters: Cluster[], allEntries: Entry[], options: OpenApiOptions = {}): any {
  const origins = uniq(clusters.map((c) => c.origin).filter(Boolean));
  const security = detectSecurity(allEntries);

  const paths: Record<string, any> = {};
  for (const cluster of clusters) {
    const path = cluster.template;
    const params = [...pathParameters(cluster), ...queryParameters(cluster)];
    const requestBody = requestContent(cluster);

    const operation: any = {
      operationId: operationIdFor(cluster),
      summary: summaryFor(cluster),
      tags: [tagFor(cluster)],
      responses: responsesFor(cluster),
    };

    if (params.length) operation.parameters = params;
    if (requestBody) {
      operation.requestBody = { required: true, content: requestBody };
    }
    if (security.required.length) operation.security = security.required.map((s) => ({ [s]: [] }));

    paths[path] = paths[path] ?? {};
    paths[path][cluster.method.toLowerCase()] = operation;
  }

  const document: any = {
    openapi: '3.1.0',
    info: {
      title: options.title ?? `API surface of ${origins[0] ?? 'captured app'}`,
      version: options.version ?? '1.0.0',
      description:
        'Generated by harspec from recorded HTTP traffic. Every operation below was observed in the capture; nothing was inferred from documentation.',
    },
    servers: origins.map((url) => ({ url })),
    paths,
  };

  if (security.required.length) {
    document.components = { securitySchemes: security.schemes };
  }

  return document;
}

export function summariseDocument(document: any): { paths: number; operations: number; methods: string[] } {
  const paths = Object.keys(document.paths ?? {});
  const methods: string[] = [];
  for (const path of paths) {
    for (const method of Object.keys(document.paths[path])) methods.push(method.toUpperCase());
  }
  return { paths: paths.length, operations: methods.length, methods: uniq(methods) };
}
