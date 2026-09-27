'use strict';
const CanonicalData = require('../../models/CanonicalData');
const { getFkApplicationId, domainSegment } = require('../../services/apiOverlap');

const NEIGHBORHOOD = 'System Components';

let appNameCache = null;
async function loadAppNamesById() {
  if (appNameCache) return appNameCache;
  const apps = await CanonicalData.find(
    { neighborhoodName: NEIGHBORHOOD, componentType: 'Applications' },
    { values: 1, primaryKey: 1 }
  ).lean();
  appNameCache = new Map();
  for (const doc of apps) {
    const v = doc.values || {};
    const appId = String(v['APP_ID Qualifier'] || '').trim();
    if (!appId) continue;
    appNameCache.set(appId, {
      acronym: String(v['APP_ACRONYM Component'] || doc.primaryKey || '').trim(),
      name: String(v['APP_NAME Qualifier'] || '').trim(),
    });
  }
  return appNameCache;
}

async function searchApis({ domain, apiType, appIdOrAcronym, nameContains, limit = 25 } = {}) {
  const [apis, appsById] = await Promise.all([
    CanonicalData.find({ neighborhoodName: NEIGHBORHOOD, componentType: 'APIs' }, { values: 1, primaryKey: 1 }).lean(),
    loadAppNamesById(),
  ]);

  const domainQuery = domain ? String(domain).toLowerCase().replace(/[^a-z0-9]+/g, '-') : null;
  const typeQuery = apiType ? String(apiType).toLowerCase() : null;
  const appQuery = appIdOrAcronym ? String(appIdOrAcronym).toLowerCase() : null;
  const nameQuery = nameContains ? String(nameContains).toLowerCase() : null;

  const rows = apis
    .map((doc) => {
      const v = doc.values || {};
      const appId = getFkApplicationId(v);
      const app = appsById.get(appId) || { acronym: appId, name: appId };
      return {
        apiId: v['API ID Qualifier'] || doc.primaryKey,
        apiName: v['API Name Component'],
        endpoint: v['Endpoint Qualifier'],
        domain: domainSegment(v['Endpoint Qualifier']),
        apiType: v['API Type Aggregate'],
        applicationId: appId,
        applicationAcronym: app.acronym,
        applicationName: app.name,
      };
    })
    .filter((r) => !domainQuery || r.domain === domainQuery)
    .filter((r) => !typeQuery || String(r.apiType || '').toLowerCase() === typeQuery)
    .filter((r) => !appQuery || r.applicationId.toLowerCase() === appQuery || r.applicationAcronym.toLowerCase() === appQuery)
    .filter((r) => !nameQuery || String(r.apiName || '').toLowerCase().includes(nameQuery));

  return { total: rows.length, results: rows.slice(0, limit) };
}

module.exports = { searchApis };
