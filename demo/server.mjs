#!/usr/bin/env node
/**
 * DEMO TARGET — intentionally vulnerable. Localhost only.
 *
 * A tiny shop API with the failure modes harspec is built to surface:
 *   - client-supplied prices and totals are trusted
 *   - email validation happens only in the browser
 *   - /api/users/:id does not check ownership (IDOR)
 *   - a debug endpoint leaks environment values
 *   - a fake key and an exposed source map live in the bundle
 *   - permissive CORS, cookies without flags, no security headers
 *
 * Never expose this on a public interface. It exists so the tool has something
 * honest to point at.
 */

import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const publicDir = join(here, 'public');
const PORT = Number(process.env.PORT ?? 3000);

const PRODUCTS = [
  { id: 1, name: 'Mechanical Keyboard', price: 129.99, stock: 12, category: 'input' },
  { id: 2, name: 'USB-C Hub', price: 59.5, stock: 40, category: 'connectivity' },
  { id: 3, name: '27" Monitor', price: 349.0, stock: 7, category: 'display' },
  { id: 4, name: 'Webcam 4K', price: 189.95, stock: 0, category: 'video' },
];

const USERS = [
  { id: 1, email: 'ana@example.com', name: 'Ana Restrepo', role: 'customer', balance: 120.5 },
  { id: 2, email: 'bruno@example.com', name: 'Bruno Salas', role: 'customer', balance: 0 },
  { id: 3, email: 'admin@example.com', name: 'Root Admin', role: 'admin', balance: 9999 },
];

const CARTS = new Map();
let nextCartId = 1;

function json(res, status, body, extraHeaders = {}) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'access-control-allow-origin': '*',
    'access-control-allow-credentials': 'true',
    'access-control-allow-headers': '*',
    'access-control-allow-methods': '*',
    ...extraHeaders,
  });
  res.end(payload);
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        resolve({});
      }
    });
  });
}

function tokenOf(req) {
  const header = req.headers.authorization ?? '';
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (!match) return null;
  try {
    return JSON.parse(Buffer.from(match[1].split('.')[1] ?? '', 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

function issueToken(user) {
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(
    JSON.stringify({ sub: user.id, email: user.email, role: user.role, iat: Math.floor(Date.now() / 1000) }),
  ).toString('base64url');
  return `${header}.${payload}.`;
}

function serveStatic(res, file, type) {
  try {
    const body = readFileSync(join(publicDir, file));
    res.writeHead(200, {
      'content-type': type,
      'content-length': body.length,
      'cache-control': 'no-store',
    });
    res.end(body);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? `localhost:${PORT}`}`);
  const path = url.pathname.replace(/\/+$/, '') || '/';
  const method = req.method ?? 'GET';

  // ---- static shell ------------------------------------------------------
  if (method === 'GET' && (path === '/' || path === '/index.html')) {
    return serveStatic(res, 'index.html', 'text/html; charset=utf-8');
  }
  if (method === 'GET' && path === '/app.js') {
    return serveStatic(res, 'app.js', 'application/javascript; charset=utf-8');
  }
  if (method === 'GET' && path === '/app.js.map') {
    return serveStatic(res, 'app.js.map', 'application/json; charset=utf-8');
  }

  if (method === 'OPTIONS') {
    res.writeHead(204, {
      'access-control-allow-origin': '*',
      'access-control-allow-credentials': 'true',
      'access-control-allow-headers': '*',
      'access-control-allow-methods': '*',
      'access-control-max-age': '86400',
    });
    return res.end();
  }

  // ---- auth --------------------------------------------------------------
  if (method === 'POST' && path === '/api/auth/login') {
    const body = await readBody(req);
    const user = USERS.find((u) => u.email === body.email);
    if (!user || !body.password) {
      return json(res, 401, { error: 'invalid_credentials', message: 'Email or password is incorrect' });
    }
    res.setHeader('set-cookie', `session=${issueToken(user)}; Path=/; SameSite=Lax`);
    return json(res, 200, {
      token: issueToken(user),
      user: { id: user.id, email: user.email, name: user.name, role: user.role },
      expiresIn: 3600,
    });
  }

  if (method === 'GET' && path === '/api/auth/me') {
    const claims = tokenOf(req);
    if (!claims) return json(res, 401, { error: 'unauthorized' });
    const user = USERS.find((u) => u.id === claims.sub);
    if (!user) return json(res, 404, { error: 'not_found' });
    return json(res, 200, { id: user.id, email: user.email, name: user.name, role: user.role });
  }

  // ---- catalogue ---------------------------------------------------------
  if (method === 'GET' && path === '/api/products') {
    const page = Math.max(1, Number(url.searchParams.get('page') ?? 1));
    const limit = Math.min(50, Math.max(1, Number(url.searchParams.get('limit') ?? 10)));
    const category = url.searchParams.get('category');
    const filtered = category ? PRODUCTS.filter((p) => p.category === category) : PRODUCTS;
    const start = (page - 1) * limit;
    return json(res, 200, {
      items: filtered.slice(start, start + limit),
      page,
      limit,
      total: filtered.length,
      hasMore: start + limit < filtered.length,
    });
  }

  const productMatch = path.match(/^\/api\/products\/(\d+)$/);
  if (method === 'GET' && productMatch) {
    const product = PRODUCTS.find((p) => p.id === Number(productMatch[1]));
    if (!product) return json(res, 404, { error: 'product_not_found' });
    return json(res, 200, product);
  }

  // ---- cart: trusts the price the client sends ---------------------------
  if (method === 'POST' && path === '/api/cart/items') {
    const body = await readBody(req);
    const product = PRODUCTS.find((p) => p.id === Number(body.productId));
    if (!product) return json(res, 400, { error: 'unknown_product' });

    const quantity = Number(body.quantity ?? 1);
    const unitPrice = Number(body.price ?? product.price); // <-- the bug
    const cartId = body.cartId ?? nextCartId++;

    const cart = CARTS.get(cartId) ?? { id: cartId, items: [], total: 0 };
    cart.items.push({ productId: product.id, name: product.name, quantity, unitPrice });
    cart.total = cart.items.reduce((sum, item) => sum + item.unitPrice * item.quantity, 0);
    CARTS.set(cartId, cart);

    return json(res, 201, { cartId, itemCount: cart.items.length, total: cart.total });
  }

  const cartMatch = path.match(/^\/api\/carts\/(\d+)$/);
  if (method === 'GET' && cartMatch) {
    const cart = CARTS.get(Number(cartMatch[1]));
    if (!cart) return json(res, 404, { error: 'cart_not_found' });
    return json(res, 200, cart);
  }

  // ---- checkout: trusts the total the client sends -----------------------
  if (method === 'POST' && path === '/api/checkout') {
    const body = await readBody(req);
    const cart = CARTS.get(Number(body.cartId));
    const total = Number(body.total ?? cart?.total ?? 0); // <-- the bug
    return json(res, 201, {
      orderId: `ord_${Math.random().toString(36).slice(2, 10)}`,
      status: 'paid',
      charged: total,
      coupon: body.coupon ?? null,
      email: body.email ?? null,
    });
  }

  // ---- users: no ownership check, no server-side email validation --------
  const userMatch = path.match(/^\/api\/users\/(\d+)$/);
  if (method === 'GET' && userMatch) {
    const user = USERS.find((u) => u.id === Number(userMatch[1]));
    if (!user) return json(res, 404, { error: 'user_not_found' });
    return json(res, 200, user); // <-- the bug
  }

  const emailMatch = path.match(/^\/api\/users\/(\d+)\/email$/);
  if (method === 'PUT' && emailMatch) {
    const user = USERS.find((u) => u.id === Number(emailMatch[1]));
    if (!user) return json(res, 404, { error: 'user_not_found' });
    const body = await readBody(req);
    user.email = String(body.email ?? ''); // <-- the bug: no format check
    return json(res, 200, { id: user.id, email: user.email, updatedAt: new Date().toISOString() });
  }

  // ---- admin: weak check (any token passes) ------------------------------
  if (method === 'GET' && path === '/api/admin/stats') {
    if (!tokenOf(req)) return json(res, 401, { error: 'unauthorized' });
    return json(res, 200, {
      revenue: 48210.4,
      orders: 1284,
      users: USERS.length,
      topProducts: PRODUCTS.slice(0, 2).map((p) => ({ id: p.id, name: p.name })),
    });
  }

  // ---- debug: leaks the environment -------------------------------------
  if (method === 'GET' && path === '/api/debug/env') {
    return json(res, 200, {
      node: process.version,
      platform: process.platform,
      env: {
        NODE_ENV: process.env.NODE_ENV ?? 'development',
        DATABASE_URL: 'postgres://demo:demo@127.0.0.1:5432/shop',
        STRIPE_SECRET_KEY: '__DEMO_TEST_KEY__',
        JWT_SECRET: 'super-secret-demo-value',
      },
    });
  }

  // ---- search: deliberately verbose errors ------------------------------
  if (method === 'GET' && path === '/api/search') {
    const q = url.searchParams.get('q') ?? '';
    if (!q) {
      return json(res, 500, {
        error: 'internal_error',
        message: "select * from products where name like '%' || $1 || '%'",
        stack: `TypeError: Cannot read properties of undefined (reading 'trim')\n    at search (/app/src/routes/search.js:42:18)\n    at Layer.handle (/app/node_modules/express/lib/router/layer.js:95:5)`,
      });
    }
    return json(res, 200, {
      query: q,
      results: PRODUCTS.filter((p) => p.name.toLowerCase().includes(q.toLowerCase())),
    });
  }

  return json(res, 404, { error: 'not_found', path });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`demo target on http://localhost:${PORT}  (intentionally vulnerable, localhost only)`);
});
