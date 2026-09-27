'use strict';
const { apiGet } = require('../apiClient');

let cache = null;
let cacheAt = 0;
const CACHE_TTL_MS = 5 * 60 * 1000;

async function loadAll() {
  if (cache && Date.now() - cacheAt < CACHE_TTL_MS) return cache;
  const { applications } = await apiGet('/api/dashboard/application-risk');
  cache = applications;
  cacheAt = Date.now();
  return cache;
}

async function getApplicationProfile({ appIdOrAcronym }) {
  const apps = await loadAll();
  const q = String(appIdOrAcronym || '').trim().toLowerCase();
  const app = apps.find(
    (a) => a.appId.toLowerCase() === q || a.acronym.toLowerCase() === q || a.name.toLowerCase() === q
  );
  if (!app) return { found: false, appIdOrAcronym };
  return { found: true, ...app };
}

module.exports = { getApplicationProfile };
