/**
 * GET /api/live-lineage
 *
 * Which business flows are active in production right now, which applications
 * serve them, and which APIs they call — from live telemetry, not the catalog.
 *
 * Source: Prometheus (PROMETHEUS_URL, default http://localhost:9090), the
 * span metrics Grafana Tempo generates from the mock production traces:
 *   traces_spanmetrics_calls_total{span_kind="SPAN_KIND_SERVER",
 *     bpmn_process_name, service, api_id, api_provider_source, status_code}
 * Every API server span carries its flow (via baggage), the app that served it
 * (service) and the catalog API id, so one query gives flow → app → API.
 *
 * Enriched from BPMN IQ: flow domain/subdomain and whether a diagram exists,
 * application name/domain and whether it is in the Applications catalog, API
 * name/method/endpoint and whether it is in the API catalog.
 *
 * Query: ?minutes=15 (window, 1–1440), ?domain=, ?flow= (repeatable).
 * 503 { code: 'PROMETHEUS_UNREACHABLE' } when Prometheus can't be reached.
 */
const express = require('express');
const Diagram = require('../models/Diagram');
const CanonicalData = require('../models/CanonicalData');
const { getIntegrationMapCached } = require('./integrationMap');
const { liveOrSnapshot, registerView, isUnreachable } = require('../services/telemetrySnapshots');

const router = express.Router();
const PROMETHEUS_URL = (process.env.PROMETHEUS_URL || 'http://localhost:9090').replace(/\/+$/, '');
const ENGINE_SERVICE = 'bpmn-process-engine';
const decode = (v) => String(v ?? '').replace(/&amp;/g, '&').trim();

let referenceCache = null;
const REFERENCE_TTL_MS = 5 * 60 * 1000;

/** BPMN IQ reference data used to label (and flag) what the telemetry shows. */
async function loadReference() {
  if (referenceCache && Date.now() - referenceCache.at < REFERENCE_TTL_MS) return referenceCache;
  const [{ data }, diagrams, apiDocs] = await Promise.all([
    getIntegrationMapCached(false),
    Diagram.find({}, { name: 1, businessFlow: 1, domain: 1, subdomain: 1 }).lean(),
    CanonicalData.find({ neighborhoodName: 'System Components', componentType: 'APIs' }, { values: 1 }).lean(),
  ]);
  const flowsByName = new Map();
  for (const d of diagrams) {
    const entry = { id: String(d._id), name: d.name, domain: decode(d.domain), subdomain: decode(d.subdomain) };
    flowsByName.set(d.name, entry);
    if (d.businessFlow && !flowsByName.has(d.businessFlow)) flowsByName.set(d.businessFlow, entry);
  }
  const appsByAcronym = new Map();
  for (const app of data.apps) if (!appsByAcronym.has(app.acronym)) appsByAcronym.set(app.acronym, app);
  const apisById = new Map();
  for (const doc of apiDocs) {
    const v = doc.values || {};
    const id = String(v['API ID Qualifier'] || '').trim();
    if (!id || apisById.has(id)) continue;
    apisById.set(id, {
      id,
      name: decode(v['API Name Component']),
      method: String(v['HTTP Method Aggregate'] || '').trim(),
      endpoint: String(v['Endpoint Qualifier'] || '').trim(),
      type: String(v['API Type Aggregate'] || '').trim(),
    });
  }
  referenceCache = { at: Date.now(), flowsByName, appsByAcronym, apisById };
  return referenceCache;
}

async function promQuery(query) {
  const res = await fetch(`${PROMETHEUS_URL}/api/v1/query?query=${encodeURIComponent(query)}`, { signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`Prometheus ${res.status}`);
  const body = await res.json();
  if (body.status !== 'success') throw new Error(`Prometheus: ${body.error || 'query failed'}`);
  return body.data.result;
}

/**
 * The raw telemetry for a window: calls and errors per flow × app × API.
 * This (not the built view) is what gets snapshotted, so the domain and flow
 * filters still work on a snapshot.
 */
async function fetchCalls({ minutes }) {
  // API server spans only: not the engine, and not the consumer's /inbound
  // hand-off (which carries the api id too, but the consumer didn't serve it).
  const selector = `span_kind="SPAN_KIND_SERVER", service!="${ENGINE_SERVICE}", api_id!="", span_name!~".*/inbound/.*"`;
  // span_name ("POST /api/v1/...") labels APIs the BPMN IQ catalog doesn't have.
  const by = 'bpmn_process_name, service, api_id, api_provider_source, span_name';
  // Calls in the window: value now minus value at the window start; a series
  // that appeared inside the window counts from zero (increase() would miss
  // its first sample, which drops flows that ran only once or twice).
  const windowed = (sel) => `sum by (${by}) (clamp_min((traces_spanmetrics_calls_total{${sel}} - traces_spanmetrics_calls_total{${sel}} offset ${minutes}m) or traces_spanmetrics_calls_total{${sel}}, 0))`;
  const [calls, errors] = await Promise.all([
    promQuery(windowed(selector)),
    promQuery(windowed(`${selector}, status_code="STATUS_CODE_ERROR"`)),
  ]);
  return { generatedAt: new Date().toISOString(), calls, errors };
}

function buildLineage({ minutes, raw, reference, domainFilter, flowFilter }) {
  const { calls, errors } = raw;

  const errorKey = (m) => `${m.bpmn_process_name}|${m.service}|${m.api_id}|${m.span_name}`;
  const errorsByKey = new Map(errors.map((r) => [errorKey(r.metric), Number(r.value[1]) || 0]));

  const flows = new Map();
  const apps = new Map();
  const apis = new Map();
  const linkMap = new Map();
  for (const row of calls) {
    const m = row.metric;
    const count = Number(row.value[1]) || 0;
    if (!m.bpmn_process_name || !m.service || count < 0.5) continue;
    const flowRef = reference.flowsByName.get(m.bpmn_process_name);
    const flowDomain = flowRef?.domain || '';
    if (domainFilter && flowDomain !== domainFilter) continue;
    if (flowFilter.size && !flowFilter.has(m.bpmn_process_name)) continue;

    const errorCount = errorsByKey.get(errorKey(m)) || 0;
    const flow = flows.get(m.bpmn_process_name) || {
      id: `flow:${m.bpmn_process_name}`,
      name: m.bpmn_process_name,
      domain: flowDomain,
      subdomain: flowRef?.subdomain || '',
      diagramId: flowRef?.id || null,
      modeled: Boolean(flowRef),
      calls: 0,
      errors: 0,
    };
    flow.calls += count;
    flow.errors += errorCount;
    flows.set(flow.name, flow);

    const catalogApp = reference.appsByAcronym.get(m.service);
    const app = apps.get(m.service) || {
      id: `app:${m.service}`,
      acronym: m.service,
      appId: catalogApp?.id || null,
      name: catalogApp?.name || '',
      domain: catalogApp?.domain || '',
      catalogued: Boolean(catalogApp),
      calls: 0,
      errors: 0,
    };
    app.calls += count;
    app.errors += errorCount;
    apps.set(m.service, app);

    const apiKey = `${m.service}|${m.api_id}`;
    const catalogApi = reference.apisById.get(m.api_id);
    const [observedMethod, ...observedRoute] = String(m.span_name || '').split(' ');
    const api = apis.get(apiKey) || {
      id: `api:${apiKey}`,
      apiId: m.api_id,
      name: catalogApi?.name || '',
      method: catalogApi?.method || observedMethod || '',
      endpoint: catalogApi?.endpoint || observedRoute.join(' '),
      provider: m.service,
      providerSource: m.api_provider_source || 'catalog',
      inCatalog: Boolean(catalogApi),
      calls: 0,
      errors: 0,
    };
    api.calls += count;
    api.errors += errorCount;
    apis.set(apiKey, api);

    const linkKey = `${flow.id}|${app.id}|${api.id}`;
    const link = linkMap.get(linkKey) || { flow: flow.id, app: app.id, api: api.id, calls: 0, errors: 0 };
    link.calls += count;
    link.errors += errorCount;
    linkMap.set(linkKey, link);
  }

  const round = (o) => ({ ...o, calls: Math.round(o.calls), errors: Math.round(o.errors) });
  const byCalls = (a, b) => b.calls - a.calls;
  return {
    generatedAt: raw.generatedAt,
    windowMinutes: minutes,
    source: 'prometheus (Tempo span metrics)',
    flows: [...flows.values()].map(round).sort(byCalls),
    apps: [...apps.values()].map(round).sort(byCalls),
    apis: [...apis.values()].map(round).sort(byCalls),
    links: [...linkMap.values()].map((l) => ({ ...l, calls: Math.round(l.calls), errors: Math.round(l.errors) })).filter((l) => l.calls > 0),
    domains: [...new Set([...reference.flowsByName.values()].map((f) => f.domain).filter(Boolean))].sort(),
    note: 'Counts are API server calls observed in the window (from Tempo span metrics, so approximate). "Apps" are the applications that served each API.',
  };
}

router.get('/', async (req, res) => {
  const minutes = Math.min(Math.max(Number(req.query.minutes) || 15, 1), 1440);
  const domainFilter = decode(req.query.domain);
  const flowFilter = new Set([].concat(req.query.flow || []).map(decode).filter(Boolean));
  try {
    const [{ data: raw, snapshot }, reference] = await Promise.all([
      liveOrSnapshot('live-lineage', { minutes }, () => fetchCalls({ minutes })),
      loadReference(),
    ]);
    const view = buildLineage({ minutes, raw, reference, domainFilter, flowFilter });
    res.json(snapshot ? { ...view, snapshot } : view);
  } catch (error) {
    const unreachable = isUnreachable(error);
    console.error('[live-lineage] failed:', error?.message || error);
    res.status(unreachable ? 503 : 500).json({
      error: unreachable ? `Could not reach Prometheus at ${PROMETHEUS_URL}, and no saved snapshot of this window exists yet. Is the mock production stack running (mockprod/stack.sh start)?` : (error?.message || 'Live lineage failed'),
      code: unreachable ? 'PROMETHEUS_UNREACHABLE' : 'LIVE_LINEAGE_FAILED',
    });
  }
});

registerView('live-lineage', {
  source: 'prometheus',
  standardParams: [5, 15, 60, 360, 1440].map((minutes) => ({ minutes })),
  compute: fetchCalls,
});

module.exports = router;
