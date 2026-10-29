#!/usr/bin/env node
/**
 * End-to-end acceptance test.
 *
 * Starts the demo target, records a session, runs the whole pipeline, and then
 * asserts on the artifacts. This is the "it actually works" proof: if this
 * script passes on a clean checkout, the tool works.
 *
 *   node scripts/e2e.mjs
 */

import { spawn } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';

const PORT = Number(process.env.E2E_PORT ?? 3411);
const BASE = `http://localhost:${PORT}`;
const ROOT = resolve(import.meta.dirname, '..');
const OUT = join(ROOT, 'harspec-out', 'e2e');
const HAR = join(ROOT, 'harspec-out', 'e2e.har');

let failures = 0;
let passes = 0;

function check(label, condition, detail = '') {
  if (condition) {
    passes += 1;
    console.log(`  ok   ${label}`);
  } else {
    failures += 1;
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

function run(command, args, options = {}) {
  return new Promise((resolvePromise) => {
    const child = spawn(command, args, { cwd: ROOT, stdio: 'pipe', ...options });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => {
      stdout += d.toString();
      if (options.echo) process.stdout.write(d);
    });
    child.stderr.on('data', (d) => {
      stderr += d.toString();
      if (options.echo) process.stderr.write(d);
    });
    child.on('close', (code) => resolvePromise({ code, stdout, stderr }));
  });
}

async function waitForServer(timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${BASE}/api/products?page=1&limit=1`);
      if (response.ok) return true;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  return false;
}

async function main() {
  console.log('\nE2E: harspec against the demo target\n');

  rmSync(join(ROOT, 'harspec-out', 'e2e'), { recursive: true, force: true });
  rmSync(HAR, { force: true });

  console.log('  starting demo target…');
  const server = spawn('node', ['demo/server.mjs'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT) },
    stdio: 'ignore',
  });

  try {
    const ready = await waitForServer();
    if (!ready) {
      console.log('  FAIL demo target never became ready');
      process.exit(1);
    }

    console.log('  recording session…');
    const rec = await run('node', ['demo/record.mjs', '--base', BASE, '--out', HAR]);
    check('recorder produced a HAR', rec.code === 0 && existsSync(HAR), rec.stderr);

    console.log('  running pipeline…');
    const cli = await run(
      'node',
      ['src/cli.ts', HAR, '-o', OUT, '--scan-bundles', '--replay', '--json'],
    );
    check('cli exited 0', cli.code === 0, cli.stderr.slice(0, 400));

    const openapiPath = join(OUT, 'openapi.json');
    const yamlPath = join(OUT, 'openapi.yaml');
    const clientPath = join(OUT, 'client.ts');
    const reportPath = join(OUT, 'report.md');
    const findingsPath = join(OUT, 'findings.json');

    check('openapi.json written', existsSync(openapiPath));
    check('openapi.yaml written', existsSync(yamlPath));
    check('client.ts written', existsSync(clientPath));
    check('report.md written', existsSync(reportPath));

    const document = JSON.parse(readFileSync(openapiPath, 'utf8'));
    const paths = Object.keys(document.paths ?? {});
    check('openapi is 3.1', document.openapi === '3.1.0', document.openapi);
    check('at least 8 paths reconstructed', paths.length >= 8, `got ${paths.length}`);
    check('path templating works', paths.includes('/api/users/{id}'), paths.join(' '));
    check(
      'request schema inferred',
      document.paths['/api/cart/items']?.post?.requestBody?.content?.['application/json']?.schema?.properties
        ?.price !== undefined,
    );
    check(
      'response schema inferred',
      document.paths['/api/products']?.get?.responses?.['200']?.content?.['application/json']?.schema !==
        undefined,
    );

    const yaml = readFileSync(yamlPath, 'utf8');
    check('yaml starts with openapi version', yaml.includes('"openapi": "3.1.0"'));

    const client = readFileSync(clientPath, 'utf8');
    check('client exposes a class', client.includes('export class ApiClient'));
    check('client has a typed login method', /async postAuthLogin\(/.test(client), client.match(/async \w+\(/g)?.join(' '));
    check('client strips the /api prefix', /async getProducts\(/.test(client));
    check('client has path parameters', /async getUsersById\(id:/.test(client));
    check('client uses no imports', !/^import /m.test(client));

    const findings = JSON.parse(readFileSync(findingsPath, 'utf8')).findings;
    const ids = findings.map((f) => f.id).join('\n');
    check('finds the trusted price bug', ids.includes('price-tampering'), ids.slice(0, 400));
    check('finds client-only email validation', ids.includes('validation/email'));
    check('finds the leaked key in the bundle', ids.includes('secret/stripe'));
    check('finds the exposed source map', ids.includes('sourcemap'));
    check('finds the IDOR candidate', ids.includes('idor-candidate'));
    check('finds the debug endpoint', ids.includes('surface/debug-endpoints'));
    check('finds the verbose error', ids.includes('errors/verbose'));
    check('finds plaintext HTTP', ids.includes('transport/plaintext'));

    const report = readFileSync(reportPath, 'utf8');
    check('report contains a critical finding', report.includes('CRITICAL'));
    check('report cites HAR entries', /\*\*HAR entries:\*\*/.test(report));

    const json = JSON.parse(cli.stdout);
    check('summary reports operations', json.operations >= 8, String(json.operations));

    // The strongest proof: the generated client talks to the real API.
    const { pathToFileURL } = await import('node:url');
    const generated = await import(`${pathToFileURL(clientPath).href}?t=${Date.now()}`);
    const api = new generated.ApiClient({ baseUrl: BASE });

    const products = await api.getProducts({ page: 1, limit: 2 });
    check('generated client calls a list endpoint', products.items?.length === 2, JSON.stringify(products).slice(0, 120));

    const login = await api.postAuthLogin({ email: 'ana@example.com', password: 'demo-password' });
    check('generated client posts a JSON body', typeof login.token === 'string');

    const authed = new generated.ApiClient({ baseUrl: BASE, token: login.token });
    const me = await authed.getAuthMe();
    check('generated client sends the bearer token', me.email === 'ana@example.com', JSON.stringify(me));

    const product = await api.getProductsById(1);
    check('generated client substitutes path parameters', Number(product.id) === 1);
  } finally {
    server.kill('SIGTERM');
  }

  console.log(`\n  ${passes} passed, ${failures} failed\n`);
  process.exit(failures ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
