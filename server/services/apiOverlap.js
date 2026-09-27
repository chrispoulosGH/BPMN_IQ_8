'use strict';

// Deterministic "does another application already expose something like
// this?" query — the same domain+type grouping scripts/seed_efficiency_findings.js
// uses to seed duplicate_functionality findings, exposed as a live query
// instead of a one-off batch job. Kept intentionally dumb (no embeddings, no
// LLM call): this is the tool an agent CALLS to get candidates, not something
// an agent should be asked to reason out over 763 rows by itself.

const CanonicalData = require('../models/CanonicalData');

const NEIGHBORHOOD = 'System Components';
const FK_APPLICATION_ID_KEY_REGEX = /^FK_System Components?\[Applications\]\.APP_ID$/i;

function getFkApplicationId(values) {
  for (const key of Object.keys(values || {})) {
    if (FK_APPLICATION_ID_KEY_REGEX.test(key)) return String(values[key] || '').trim();
  }
  return '';
}

function domainSegment(endpoint) {
  const segs = String(endpoint || '').split('/').filter(Boolean);
  return segs[2] || '';
}

function tokenize(name) {
  return new Set(
    String(name || '')
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 2)
  );
}

function tokenOverlapScore(a, b) {
  const ta = tokenize(a);
  const tb = tokenize(b);
  if (!ta.size || !tb.size) return 0;
  let shared = 0;
  for (const w of ta) if (tb.has(w)) shared += 1;
  return shared / Math.min(ta.size, tb.size);
}

async function loadApiCatalog() {
  return CanonicalData.find(
    { neighborhoodName: NEIGHBORHOOD, componentType: 'APIs' },
    { values: 1, primaryKey: 1 }
  ).lean();
}

async function loadAppNamesById() {
  const apps = await CanonicalData.find(
    { neighborhoodName: NEIGHBORHOOD, componentType: 'Applications' },
    { values: 1, primaryKey: 1 }
  ).lean();
  const byId = new Map();
  for (const doc of apps) {
    const v = doc.values || {};
    const appId = String(v['APP_ID Qualifier'] || '').trim();
    if (!appId) continue;
    const acronym = String(v['APP_ACRONYM Component'] || doc.primaryKey || '').trim();
    const name = String(v['APP_NAME Qualifier'] || acronym || appId).trim();
    byId.set(appId, { acronym, name });
  }
  return byId;
}

/**
 * Given one API's catalog id (API ID Qualifier, e.g. "API-00766") or its Mongo
 * _id, return other APIs — in a DIFFERENT application — that share the same
 * business domain (from the endpoint path) and API type, ranked by simple
 * name-token overlap with the target. This is the candidate list; judging
 * whether a given candidate is a real duplicate is left to the caller.
 */
async function findOverlappingApis(apiIdentifier, { limit = 5 } = {}) {
  const [catalog, appNamesById] = await Promise.all([loadApiCatalog(), loadAppNamesById()]);

  const target = catalog.find(
    (doc) => doc.values?.['API ID Qualifier'] === apiIdentifier || String(doc._id) === String(apiIdentifier)
  );
  if (!target) return { target: null, candidates: [] };

  const targetDomain = domainSegment(target.values['Endpoint Qualifier']);
  const targetType = String(target.values['API Type Aggregate'] || '').trim();
  const targetAppId = getFkApplicationId(target.values);
  const targetName = target.values['API Name Component'];

  const candidates = catalog
    .filter((doc) => doc._id !== target._id)
    .filter((doc) => domainSegment(doc.values['Endpoint Qualifier']) === targetDomain)
    .filter((doc) => String(doc.values['API Type Aggregate'] || '').trim() === targetType)
    .filter((doc) => getFkApplicationId(doc.values) !== targetAppId)
    .map((doc) => {
      const appId = getFkApplicationId(doc.values);
      const app = appNamesById.get(appId) || { acronym: appId, name: appId };
      return {
        apiId: doc.values['API ID Qualifier'] || doc.primaryKey,
        apiName: doc.values['API Name Component'],
        endpoint: doc.values['Endpoint Qualifier'],
        applicationId: appId,
        applicationAcronym: app.acronym,
        applicationName: app.name,
        nameOverlapScore: Math.round(tokenOverlapScore(targetName, doc.values['API Name Component']) * 100) / 100,
      };
    })
    .sort((a, b) => b.nameOverlapScore - a.nameOverlapScore)
    .slice(0, limit);

  const targetAppInfo = appNamesById.get(targetAppId) || { acronym: targetAppId, name: targetAppId };

  return {
    target: {
      apiId: target.values['API ID Qualifier'] || target.primaryKey,
      apiName: targetName,
      endpoint: target.values['Endpoint Qualifier'],
      domain: targetDomain,
      apiType: targetType,
      applicationId: targetAppId,
      applicationAcronym: targetAppInfo.acronym,
      applicationName: targetAppInfo.name,
    },
    candidates,
  };
}

module.exports = { findOverlappingApis, getFkApplicationId, domainSegment };
