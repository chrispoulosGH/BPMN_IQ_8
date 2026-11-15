/**
 * One simulated business application (APP_ID env). It:
 *  - hosts every catalog API it is the provider of, at the API's real endpoint;
 *  - runs the task's business logic (an internal span + a database span);
 *  - hands the resulting data object to the consumer application
 *    (POST <consumer>/inbound/<objectId>), so data moves provider → consumer as
 *    each API records it;
 *  - accepts hand-offs from other apps on /inbound/:objectId.
 *
 * Faults: a small base error rate (higher for non-production lifecycles),
 * latency jitter, and occasional incident windows (degraded latency + 503s).
 */
const { catalog, appUrl, apisProvidedBy, portByApp } = require('./catalog');

const APP_ID = process.env.APP_ID;
const app = catalog.applications[APP_ID];
if (!app) throw new Error(`Unknown APP_ID ${APP_ID}`);

const { initTelemetry } = require('./otel');
initTelemetry({
  serviceName: app.acronym,
  attributes: {
    'app.id': app.id,
    'app.acronym': app.acronym,
    'app.name': app.name,
    'app.domain': app.domain,
    'app.criticality': app.criticality || '',
    // false = named in a BPMN IQ diagram but missing from the Applications catalog
    'app.catalogued': app.catalogued !== false,
  },
});

const express = require('express');
const api = require('@opentelemetry/api');
const { getRPCMetadata } = require('@opentelemetry/core');
const A = require('./attributes');
const { buildBody, redact, missingRequired } = require('./payloads');

const tracer = api.trace.getTracer('bpmn-iq-mockprod/app', '1.0.0');
const meter = api.metrics.getMeter('bpmn-iq-mockprod/app', '1.0.0');
const exchanged = meter.createCounter('business.data_object.exchanged', { description: 'Data objects handed between applications', unit: '{object}' });
const apiErrors = meter.createCounter('api.errors', { description: 'API calls that returned an error', unit: '{call}' });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const lognormal = (median, sigma = 0.45) => {
  const u = Math.max(Math.random(), 1e-9);
  const v = Math.random();
  return median * Math.exp(sigma * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v));
};
const MAX_BODY_EVENT_CHARS = 2000;
/**
 * The HTTP SERVER span of the current request (not Express's request-handler
 * span) — where api.* / app.* belong, so Observe's service views and the
 * BPMN reconstruction see them next to http.route.
 */
function serverSpan() {
  return getRPCMetadata(api.context.active())?.span || api.trace.getActiveSpan();
}
const objectName = (id) => catalog.dataObjects[id]?.name || '';
const tableName = (id) => (objectName(id) || 'record').toLowerCase().replace(/[^a-z0-9]+/g, '_');

// ── Incidents ──────────────────────────────────────────────────────────────
const INCIDENTS_PER_DAY = Number(process.env.INCIDENTS_PER_DAY_PER_APP || 0.5);
let incidentUntil = 0;
if (process.env.FORCE_INCIDENT_APP === app.acronym) incidentUntil = Date.now() + 15 * 60 * 1000;
setInterval(() => {
  if (Date.now() < incidentUntil) return;
  if (Math.random() < INCIDENTS_PER_DAY / 1440) {
    const minutes = 8 + Math.random() * 12;
    incidentUntil = Date.now() + minutes * 60 * 1000;
    console.log(`[${app.acronym}] incident started for ${minutes.toFixed(0)} min`);
  }
}, 60 * 1000).unref();
const incidentActive = () => Date.now() < incidentUntil;

const baseErrorRate = (lifecycle) => {
  const l = String(lifecycle || '').toLowerCase();
  if (l.includes('deprecat') || l.includes('retir')) return 0.02;
  if (l.includes('propos') || l.includes('pilot') || l.includes('develop')) return 0.012;
  return 0.004;
};

const decodeContext = (req) => {
  try {
    return JSON.parse(Buffer.from(String(req.headers['x-sim-context'] || ''), 'base64').toString('utf8')) || {};
  } catch {
    return {};
  }
};

function recordBody(span, eventName, body, objectId) {
  if (!body) return;
  const text = JSON.stringify(redact(body, catalog.dataObjects[objectId]));
  span.addEvent(eventName, {
    'data_object.id': objectId,
    'data_object.name': objectName(objectId),
    body: text.length > MAX_BODY_EVENT_CHARS ? `${text.slice(0, MAX_BODY_EVENT_CHARS)}…` : text,
  });
}

/** A database round trip for the object this step reads or writes. */
async function dbCall(operation, objectId, medianMs) {
  return tracer.startActiveSpan(`${operation} ${tableName(objectId)}`, { kind: api.SpanKind.CLIENT }, async (span) => {
    span.setAttributes({
      'db.system.name': 'postgresql',
      'db.namespace': app.acronym.toLowerCase().replace(/-/g, '_'),
      'db.operation.name': operation,
      'db.collection.name': tableName(objectId),
      'server.address': `${app.acronym.toLowerCase()}-db.internal`,
      'server.port': 5432,
    });
    await sleep(lognormal(medianMs) * (incidentActive() ? 3 : 1));
    span.end();
  });
}

/** POST the data object to the consumer's inbound endpoint. */
async function handoff(call, objectId, body, ctxHeader) {
  return tracer.startActiveSpan(`handoff ${objectName(objectId) || objectId} → ${catalog.applications[call.consumer]?.acronym || call.consumer}`, async (span) => {
    span.setAttributes({ [A.HANDOFF_DATA_OBJECT]: objectName(objectId), [A.API_CONSUMER_APP_ID]: call.consumer, 'data_object.id': objectId });
    try {
      const res = await fetch(`${appUrl(call.consumer)}/inbound/${encodeURIComponent(objectId)}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-sim-context': ctxHeader, 'x-source-app': APP_ID, 'x-api-id': call.apiId },
        body: JSON.stringify(body || {}),
      });
      if (!res.ok) throw new Error(`consumer ${call.consumer} returned ${res.status}`);
      exchanged.add(1, { 'data_object.name': objectName(objectId), direction: 'sent', [A.API_CONSUMER_APP_ID]: call.consumer });
      return true;
    } catch (error) {
      span.recordException(error);
      span.setStatus({ code: api.SpanStatusCode.ERROR, message: error.message });
      return false;
    } finally {
      span.end();
    }
  });
}

const appServer = express();
appServer.use(express.json({ limit: '1mb' }));
appServer.get('/healthz', (_req, res) => res.json({ ok: true, app: app.acronym, incident: incidentActive() }));

const provided = apisProvidedBy(APP_ID);
// Several catalog APIs can share one method + path (flow variants). Register
// each route once; the caller's x-api-id header picks which API is meant.
const routes = new Map();
for (const call of provided) {
  const key = `${call.method.toUpperCase()} ${call.endpoint}`;
  if (!routes.has(key)) routes.set(key, []);
  routes.get(key).push(call);
}
for (const [key, callsOnRoute] of routes) {
  const method = callsOnRoute[0].method.toLowerCase();
  if (typeof appServer[method] !== 'function') continue;
  appServer[method](callsOnRoute[0].endpoint, async (req, res) => {
    const requestedApi = String(req.headers['x-api-id'] || '');
    const call = callsOnRoute.find((c) => c.apiId === requestedApi) || callsOnRoute[0];
    const span = serverSpan();
    const host = catalog.hosts[call.host];
    const incident = incidentActive();
    span?.setAttributes({
      [A.API_ID]: call.apiId,
      [A.API_NAME]: call.apiName,
      [A.API_TYPE]: call.apiType,
      [A.API_LIFECYCLE]: call.lifecycle,
      [A.API_PROVIDER_APP_ID]: call.provider,
      [A.API_CONSUMER_APP_ID]: call.consumer,
      // catalog | diagram (task's app hosts a provider-less API) | uncatalogued
      'api.provider.source': call.providerSource || 'catalog',
      [A.API_REQUEST_OBJECT]: objectName(call.requestObject),
      [A.API_RESPONSE_OBJECT]: objectName(call.responseObject),
      [A.APP_ID]: app.id,
      [A.APP_ACRONYM]: app.acronym,
      // The (derived) catalog server this API is deployed on.
      'app.host.id': call.host || '',
      'app.host.name': host?.name || '',
      'app.host.role': host?.role || '',
      'app.host.datacenter': host?.datacenter || '',
      [A.SIM_INCIDENT]: incident,
    });
    // The caller's session (OTel semconv session.id). For traffic without
    // business context it's the only link between one user's actions.
    if (req.headers['x-session-id']) span?.setAttribute('session.id', String(req.headers['x-session-id']));
    if (call.requestObject) recordBody(span, 'api.request.body', req.body, call.requestObject);

    const fail = (status, fault, message) => {
      span?.setAttributes({ [A.SIM_FAULT]: fault, 'error.type': String(status) });
      apiErrors.add(1, { [A.API_ID]: call.apiId, 'error.type': String(status), [A.SIM_FAULT]: fault });
      res.status(status).json({ error: message, apiId: call.apiId });
    };

    const ctx = decodeContext(req);
    await sleep(lognormal(method === 'get' ? 25 : 45) * (incident ? 4 : 1));

    if (incident && Math.random() < 0.3) return fail(503, 'incident', `${app.acronym} is degraded`);
    const missing = call.requestObject ? missingRequired(req.body, catalog.dataObjects[call.requestObject]) : [];
    if (missing.length) return fail(422, 'validation', `Missing required fields: ${missing.join(', ')}`);
    if (Math.random() < baseErrorRate(call.lifecycle)) return fail(500, 'random', 'Internal error');

    // Business logic for the task.
    let response;
    await tracer.startActiveSpan(`${call.task.name} logic`, async (logic) => {
      logic.setAttributes({ [A.API_ID]: call.apiId, 'code.function.name': `handle${call.task.id.replace(/^Task_/, '')}` });
      const readObject = call.requestObject || call.responseObject;
      await dbCall('SELECT', readObject, method === 'get' ? 6 : 8);
      if (method !== 'get') await dbCall(method === 'put' ? 'UPDATE' : 'INSERT', readObject, 12);
      await sleep(lognormal(method === 'get' ? 30 : 70));
      response = buildBody(catalog.dataObjects[call.responseObject], ctx);
      logic.end();
    });

    // Hand the data to the consumer application.
    if (!call.internal) {
      const objectId = call.responseObject || call.requestObject;
      const body = call.responseObject ? response : req.body;
      let ok = await handoff(call, objectId, body, req.headers['x-sim-context']);
      if (!ok) ok = await handoff(call, objectId, body, req.headers['x-sim-context']); // one retry
      if (!ok) return fail(502, 'handoff', `Could not deliver ${objectName(objectId)} to ${call.consumer}`);
    }

    if (call.responseObject) recordBody(span, 'api.response.body', response, call.responseObject);
    res.status(method === 'post' ? 201 : 200).json(response || { status: 'OK' });
  });
}

// Data handed off from another application.
appServer.post('/inbound/:objectId', async (req, res) => {
  const span = serverSpan();
  const objectId = req.params.objectId;
  span?.setAttributes({
    [A.HANDOFF_DATA_OBJECT]: objectName(objectId),
    'data_object.id': objectId,
    [A.API_ID]: String(req.headers['x-api-id'] || ''),
    [A.API_PROVIDER_APP_ID]: String(req.headers['x-source-app'] || ''),
    [A.API_CONSUMER_APP_ID]: APP_ID,
    [A.APP_ID]: app.id,
    [A.APP_ACRONYM]: app.acronym,
    [A.SIM_INCIDENT]: incidentActive(),
  });
  await tracer.startActiveSpan(`receive ${objectName(objectId) || objectId}`, async (inner) => {
    await dbCall('INSERT', objectId, 10);
    inner.end();
  });
  if (incidentActive() && Math.random() < 0.15) {
    span?.setAttribute(A.SIM_FAULT, 'incident');
    return res.status(503).json({ error: `${app.acronym} is degraded` });
  }
  exchanged.add(1, { 'data_object.name': objectName(objectId), direction: 'received' });
  res.status(202).json({ received: objectId, correlationId: span?.spanContext().traceId });
});

const port = portByApp.get(APP_ID);
appServer.listen(port, () => console.log(`[${app.acronym}] ${provided.length} APIs on ${routes.size} routes, :${port}`));
