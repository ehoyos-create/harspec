/* Demo client bundle. Intentionally sloppy — this is a target, not an example. */

const API_BASE = "http://localhost:3000";
const STRIPE_SECRET = "__DEMO_LEAKED_KEY__";

// Client-side price formatting is the only place prices are "validated".
function formatPrice(cents) {
  return (cents / 100).toFixed(2);
}

// The browser checks this; the server does not.
function isValidEmail(value) {
  return /\S+@\S+\.\S+/.test(value);
}

async function login(email, password) {
  const response = await fetch(`${API_BASE}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  const data = await response.json();
  localStorage.setItem("token", data.token);
  return data;
}

async function listProducts(page = 1, limit = 2) {
  const response = await fetch(`${API_BASE}/api/products?page=${page}&limit=${limit}`);
  return response.json();
}

async function addToCart(productId, quantity, price) {
  const token = localStorage.getItem("token");
  const response = await fetch(`${API_BASE}/api/cart/items`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ productId, quantity, price }),
  });
  return response.json();
}

async function saveEmail(userId, email) {
  if (!isValidEmail(email)) return { error: "invalid_email" };
  const token = localStorage.getItem("token");
  const response = await fetch(`${API_BASE}/api/users/${userId}/email`, {
    method: "PUT",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ email }),
  });
  return response.json();
}

window.demoShop = { login, listProducts, addToCart, saveEmail, formatPrice, STRIPE_SECRET };

//# sourceMappingURL=app.js.map
