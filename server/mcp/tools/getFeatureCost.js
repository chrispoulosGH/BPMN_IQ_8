'use strict';
const { apiGet } = require('../apiClient');

let cache = null;
let cacheAt = 0;
const CACHE_TTL_MS = 5 * 60 * 1000;

async function loadPoints() {
  if (cache && Date.now() - cacheAt < CACHE_TTL_MS) return cache;
  const { points } = await apiGet('/api/dashboard/feature-cost-3d');
  cache = points;
  cacheAt = Date.now();
  return cache;
}

function norm(s) { return String(s || '').trim().toLowerCase(); }

async function getFeatureCost({ businessFlow, applicationName, year } = {}) {
  const points = await loadPoints();
  const flowKey = businessFlow ? norm(businessFlow) : null;
  const appKey = applicationName ? norm(applicationName) : null;

  const matched = points
    .filter((p) => !flowKey || norm(p.businessFlow) === flowKey)
    .filter((p) => !appKey || norm(p.application) === appKey)
    .filter((p) => !year || p.year === Number(year));

  const totalCost = matched.reduce((sum, p) => sum + (p.cost || 0), 0);
  return {
    matchedPoints: matched.length,
    totalCost,
    byApplication: Object.fromEntries(
      [...new Set(matched.map((p) => p.application))].map((app) => [
        app,
        matched.filter((p) => p.application === app).reduce((sum, p) => sum + (p.cost || 0), 0),
      ])
    ),
  };
}

module.exports = { getFeatureCost };
