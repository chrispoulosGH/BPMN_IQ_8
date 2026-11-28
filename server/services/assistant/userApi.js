/**
 * Calls BIQ's own API as the signed-in user (their session cookie is
 * forwarded), so the assistant can never see more than the user could in
 * the app. Diagram routes need the model scope header; LLM AMI is the
 * neighborhood that holds the business flows.
 */
const PORT = process.env.PORT || 3001;
const BASE = `http://127.0.0.1:${PORT}/api`;
const FLOW_NEIGHBORHOOD = process.env.ASSISTANT_NEIGHBORHOOD || 'LLM AMI';

function makeUserApi(req) {
  const cookie = req.headers.cookie || '';
  const memo = new Map(); // per question: the same lookup is fetched once

  async function get(path, params = {}, { neighborhood = FLOW_NEIGHBORHOOD, timeoutMs = 120000 } = {}) {
    const qs = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== '').map(([k, v]) => [k, String(v)]));
    const url = `${BASE}${path}${qs.toString() ? `?${qs}` : ''}`;
    if (memo.has(url)) return memo.get(url);
    const promise = (async () => {
      const res = await fetch(url, {
        headers: { cookie, accept: 'application/json', ...(neighborhood ? { 'x-neighborhood-name': neighborhood } : {}) },
        signal: AbortSignal.timeout(timeoutMs),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        const err = new Error(body?.error || `HTTP ${res.status} for ${path}`);
        err.status = res.status;
        throw err;
      }
      return body;
    })();
    memo.set(url, promise);
    promise.catch(() => memo.delete(url));
    return promise;
  }

  return { get };
}

module.exports = { makeUserApi };
