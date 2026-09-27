'use strict';

// Thin HTTP client the MCP server uses to reach the already-running Express
// API (dashboard.js, diagrams.js, processChangeRadar.js) instead of
// re-implementing their business logic. The MCP process is a separate
// Node process from `yarn dev`'s server — it authenticates once as a
// dedicated service account and reuses the session cookie, exactly like a
// browser tab would (see routes/auth.js — userId-only, auto-registers).

const BASE_URL = process.env.MCP_API_BASE_URL || 'http://localhost:3001';
const SERVICE_USER_ID = process.env.MCP_SERVICE_USER_ID || 'process-optimizer-agent';
// Diagrams/tasks live under the 'LLM AMI' neighborhood (CanonicalData's
// System Components catalog is a separate neighborhood) — every diagram-
// scoped route requires this header or it silently sees zero rows, the same
// way client/src/api.ts sets it from the UI's selected model.
const NEIGHBORHOOD_NAME = process.env.MCP_NEIGHBORHOOD_NAME || 'LLM AMI';

let sessionCookie = null;

async function login() {
  const res = await fetch(`${BASE_URL}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userId: SERVICE_USER_ID }),
  });
  if (!res.ok) throw new Error(`MCP service login failed: ${res.status} ${await res.text()}`);
  const setCookie = res.headers.get('set-cookie');
  if (!setCookie) throw new Error('MCP service login did not return a session cookie.');
  sessionCookie = setCookie.split(';')[0];
}

async function apiGet(path, { retry = true } = {}) {
  if (!sessionCookie) await login();
  const res = await fetch(`${BASE_URL}${path}`, {
    headers: { Cookie: sessionCookie, 'x-neighborhood-name': NEIGHBORHOOD_NAME },
  });
  if (res.status === 401 && retry) {
    sessionCookie = null;
    return apiGet(path, { retry: false });
  }
  if (!res.ok) throw new Error(`GET ${path} -> ${res.status} ${await res.text()}`);
  return res.json();
}

module.exports = { apiGet, BASE_URL };
