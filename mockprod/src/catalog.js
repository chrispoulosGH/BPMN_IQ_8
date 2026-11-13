/**
 * Loads catalog/catalog.json (exported from BPMN IQ by
 * server/scripts/export_mockprod_catalog.js) and derives the service layout.
 */
const fs = require('fs');
const path = require('path');

const CATALOG_PATH = process.env.CATALOG_PATH || path.join(__dirname, '..', 'catalog', 'catalog.json');
const catalog = JSON.parse(fs.readFileSync(CATALOG_PATH, 'utf8'));

const BASE_PORT = Number(process.env.APP_BASE_PORT || 7100);
const ENGINE_PORT = Number(process.env.ENGINE_PORT || 7000);
const SERVICE_HOST = process.env.SERVICE_HOST || '127.0.0.1';

const appIds = Object.keys(catalog.applications).sort();
const portByApp = new Map(appIds.map((id, i) => [id, BASE_PORT + i]));

/** Every API each application provides (it hosts the endpoint). */
function apisProvidedBy(appId) {
  const out = [];
  for (const flow of catalog.flows) {
    for (const task of flow.tasks) {
      for (const call of task.calls) if (call.provider === appId) out.push({ ...call, flow, task });
    }
  }
  return out;
}

const appUrl = (appId) => `http://${SERVICE_HOST}:${portByApp.get(appId)}`;
const flowByName = (name) => catalog.flows.find((f) => f.name === name);

/** Human lanes have think time; the "System" lane is automated. */
const isSystemLane = (laneName) => /^system$/i.test(String(laneName || '').trim());

module.exports = { catalog, appIds, portByApp, appUrl, apisProvidedBy, flowByName, isSystemLane, ENGINE_PORT, SERVICE_HOST };
