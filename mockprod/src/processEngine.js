/**
 * The workflow engine (service.name "bpmn-process-engine"). Runs process
 * instances of the catalog's business flows, task by task in BPMN order, and
 * strings flows together into customer journeys.
 *
 * Trace shape — one trace per process instance:
 *
 *   process <flow>                       engine, root; bpmn.process.* + journey
 *   └─ task <task>                       engine; bpmn.task.*, lane, sequence flows
 *      └─ POST /api/v1/...               engine → task application (HTTP client)
 *         └─ POST /api/v1/...            task application (HTTP server, api.*)
 *            ├─ <task> logic             business logic + SELECT/INSERT db spans
 *            └─ handoff <object> → APP   provider → consumer (HTTP client)
 *               └─ POST /inbound/...     consumer application (HTTP server)
 *
 * bpmn.* and business.* ride along as W3C baggage, so every span in every
 * service carries the flow, task and lane it belongs to. Flows in the same
 * journey share business.journey.id and the next flow's root links to the
 * previous one's.
 *
 * Pacing: human-lane tasks wait a compressed "think time" (WAIT_SCALE scales
 * it); the System lane runs straight through. See scheduler.js for arrivals.
 */
const { initTelemetry } = require('./otel');
initTelemetry({ serviceName: 'bpmn-process-engine', attributes: { 'app.id': 'BPMN-ENGINE', 'app.acronym': 'bpmn-process-engine' } });

const crypto = require('crypto');
const express = require('express');
const api = require('@opentelemetry/api');
const A = require('./attributes');
const { catalog, appUrl, flowByName, isSystemLane, ENGINE_PORT } = require('./catalog');
const { newJourneyContext, buildBody } = require('./payloads');
const { startScheduler, startFlowScheduler } = require('./scheduler');

const tracer = api.trace.getTracer('bpmn-iq-mockprod/engine', '1.0.0');
const meter = api.metrics.getMeter('bpmn-iq-mockprod/engine', '1.0.0');
const instancesCounter = meter.createCounter('bpmn.process.instances', { description: 'Process instances finished, by outcome', unit: '{instance}' });
// Vehicles sold: emitted once per sale, by the task that completes it (see SALE_EVENTS).
const vehiclesSold = meter.createCounter('business.vehicles.sold', { description: 'Vehicles sold (counted at delivery / wholesale completion)', unit: '{vehicle}' });
const salesRevenue = meter.createCounter('business.sales.revenue', { description: 'Vehicle sale revenue', unit: 'USD' });

/**
 * Which task completes a vehicle sale, per flow. A sale is counted when the
 * vehicle changes hands: delivery confirmation for new vehicles (online and
 * in-store retail), fleet delivery, or wholesale completion for used units.
 * Contracts, financing, warranty and upsell flows add to a sale but are not one.
 */
const SALE_EVENTS = {
  'New Vehicle Delivery Experience': { task: 'Sign Delivery Confirmation', condition: 'new' },
  'Fleet Order Fulfillment': { task: 'Complete Fleet Delivery', condition: 'new', channel: 'fleet', units: (ctx) => ctx.fleetUnits },
  'Wholesale Vehicle Disposition': { task: 'Complete Wholesale Sale', condition: 'used', channel: 'wholesale' },
};
// Create every series a sale will use, at 0, with exactly the labels add()
// uses below — otherwise Prometheus never sees a series' first sale (a whole
// fleet order can be that first sale).
for (const [flowName, channel, condition] of [
  ['New Vehicle Delivery Experience', 'online', 'new'],
  ['New Vehicle Delivery Experience', 'in-store', 'new'],
  ['Fleet Order Fulfillment', 'fleet', 'new'],
  ['Wholesale Vehicle Disposition', 'wholesale', 'used'],
]) {
  const labels = { [A.SALE_CHANNEL]: channel, [A.VEHICLE_CONDITION]: condition, [A.PROCESS_NAME]: flowName };
  vehiclesSold.add(0, labels);
  salesRevenue.add(0, labels);
}
/**
 * Business outcomes beyond vehicle sales: each is counted once, when the task
 * that completes it succeeds. `units` is how many the instance produces (a
 * shift's build lot, an OTA wave), `value` its USD amount where one applies,
 * and `dimension` the breakdown leaders slice it by. The server's
 * business-metrics route (server/routes/businessKpis.js) holds the labels.
 */
const pick = (list) => list[Math.floor(Math.random() * list.length)];
const between = (lo, hi) => lo + Math.random() * (hi - lo);
const BUSINESS_METRICS = [
  { id: 'designs_released', flow: 'New Model Development Program', task: 'Release for Production',
    dimensions: ['Sedan', 'SUV', 'Truck', 'EV'], units: () => 1 },
  { id: 'ota_updates_delivered', flow: 'Over-the-Air Software Update', task: 'Track Success & Failures',
    dimensions: ['Infotainment', 'Powertrain', 'ADAS', 'Battery Mgmt'], units: () => between(400, 4000) },
  { id: 'vehicles_built', flow: 'Vehicle Assembly Line Execution', task: 'Release for Final Test',
    dimensions: ['Detroit', 'Louisville', 'Chattanooga'], units: () => between(40, 120) },
  { id: 'safety_certifications_passed', flow: 'Vehicle Safety Compliance Certification', task: 'Receive Certification',
    dimensions: ['FMVSS', 'IIHS', 'Euro NCAP'], units: () => 1 },
  { id: 'quality_inspections_passed', flow: 'End-of-Line Quality Inspection', task: 'Release to Shipping',
    dimensions: ['Detroit', 'Louisville', 'Chattanooga'], units: () => between(35, 110) },
  { id: 'repair_orders_closed', flow: 'Repair Order Completion', task: 'Close Repair Order',
    dimensions: ['Customer Pay', 'Warranty', 'Internal'], units: () => 1, value: () => between(180, 1400) },
  { id: 'warranty_claims_paid', flow: 'Warranty Claim Submission', task: 'Receive Payment',
    dimensions: ['Powertrain', 'Electrical', 'Body', 'Emissions'], units: () => 1, value: () => between(250, 3200) },
  { id: 'recall_repairs_completed', flow: 'Recall Campaign Execution', task: 'Report Completion to OEM',
    dimensions: ['Airbag', 'Brakes', 'Software', 'Fuel System'], units: () => between(5, 40) },
  { id: 'finance_contracts_funded', flow: 'Finance Contract Funding', task: 'Reconcile Funding Amount',
    dimensions: ['Retail Loan', 'Lease', 'Special Finance'], units: () => 1, value: () => between(22000, 68000) },
  { id: 'subscriptions_renewed', flow: 'Connected Subscription Renewal', task: 'Activate Renewed Services',
    dimensions: ['Connected Basic', 'Connected Plus', 'Premium Bundle'], units: () => 1, value: () => between(99, 399) },
];
const METRIC_BY_TASK = new Map(BUSINESS_METRICS.map((m) => [`${m.flow}|${m.task}`, m]));
const outcomesCounter = meter.createCounter('business.outcomes', { description: 'Business outcomes completed (designs released, vehicles built, claims paid…)', unit: '{outcome}' });
const outcomeValue = meter.createCounter('business.outcome.value', { description: 'USD value of business outcomes', unit: 'USD' });
// Zero-init with exactly the labels add() uses (see the sales counters above).
for (const m of BUSINESS_METRICS) {
  for (const dimension of m.dimensions) {
    const labels = { 'business.metric': m.id, 'business.metric.dimension': dimension, [A.PROCESS_NAME]: m.flow };
    outcomesCounter.add(0, labels);
    if (m.value) outcomeValue.add(0, labels);
  }
}

const processDuration = meter.createHistogram('bpmn.process.duration', { description: 'Process instance duration', unit: 's' });
const taskDuration = meter.createHistogram('bpmn.task.duration', { description: 'Task duration including human work', unit: 's' });
// Create every flow × outcome series at 0, so Prometheus sees each counter's
// first increment (increase()/rate() can't see a counter's first sample).
for (const flow of catalog.flows) {
  for (const outcome of ['completed', 'failed', 'abandoned']) instancesCounter.add(0, { [A.PROCESS_NAME]: flow.name, [A.PROCESS_OUTCOME]: outcome });
}
const activeInstances = new Map(); // instanceId -> { flow, task, startedAt }
meter.createObservableGauge('bpmn.process.active_instances', { description: 'Process instances in flight', unit: '{instance}' })
  .addCallback((result) => {
    const byFlow = {};
    for (const entry of activeInstances.values()) byFlow[entry.flow] = (byFlow[entry.flow] || 0) + 1;
    for (const flow of catalog.flows) result.observe(byFlow[flow.name] || 0, { [A.PROCESS_NAME]: flow.name });
  });

const APP_ID_BY_ACRONYM = new Map(Object.values(catalog.applications).map((app) => [app.acronym, app.id]));
const WAIT_SCALE = Number(process.env.WAIT_SCALE || 1);
const ABANDON_RATE = Number(process.env.ABANDON_RATE || 0.03);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const lognormal = (median, sigma = 0.5) => {
  const u = Math.max(Math.random(), 1e-9);
  return median * Math.exp(sigma * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * Math.random()));
};

/** Compressed human think time by lane (seconds, median). */
function thinkTimeMs(task) {
  if (isSystemLane(task.laneName)) return lognormal(300, 0.6);
  const lane = task.laneName.toLowerCase();
  const median = lane.includes('customer') ? 40 : lane.includes('manager') ? 55 : 25;
  return lognormal(median * 1000, 0.55) * WAIT_SCALE;
}

/** Baggage = what every downstream span should carry. */
function withBaggage(entries, ctx = api.context.active()) {
  let baggage = api.propagation.getBaggage(ctx) || api.propagation.createBaggage();
  for (const [key, value] of Object.entries(entries)) {
    if (value === undefined || value === null || value === '') continue;
    baggage = baggage.setEntry(key, { value: String(value) });
  }
  return api.propagation.setBaggage(ctx, baggage);
}

/** Call the task's API on its application, retrying 5xx twice with backoff. */
async function invokeApi(call, journeyCtx) {
  const objectBody = call.requestObject ? buildBody(catalog.dataObjects[call.requestObject], journeyCtx) : null;
  const headers = {
    'content-type': 'application/json',
    'x-sim-context': Buffer.from(JSON.stringify(journeyCtx)).toString('base64'),
    'x-request-id': crypto.randomUUID(),
    // Disambiguates APIs that share a route on the same application.
    'x-api-id': call.apiId,
  };
  let lastError = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (attempt) await sleep(1000 * 2 ** (attempt - 1) * (0.8 + Math.random() * 0.4));
    try {
      const res = await fetch(`${appUrl(call.provider)}${call.endpoint}`, {
        method: call.method,
        headers,
        body: call.method === 'GET' ? undefined : JSON.stringify(objectBody || {}),
      });
      if (res.ok) return { ok: true, status: res.status, attempts: attempt + 1 };
      lastError = new Error(`${call.method} ${call.endpoint} → ${res.status}`);
      lastError.status = res.status;
      if (res.status < 500) break; // 4xx: retrying won't help
    } catch (error) {
      lastError = error;
    }
  }
  return { ok: false, error: lastError, attempts: 3 };
}

async function runTask(flow, task, sequence, journeyCtx, instanceId) {
  // The task's application(s) come from its diagram; the API it calls may be
  // provided by a different app. Fall back to the API provider when the
  // diagram names none.
  const providerApp = catalog.applications[task.calls[0]?.provider] || {};
  const taskAppAcronyms = (task.diagramApplications || []).filter(Boolean);
  if (!taskAppAcronyms.length && providerApp.acronym) taskAppAcronyms.push(providerApp.acronym);
  const taskAppIds = taskAppAcronyms.map((acronym) => APP_ID_BY_ACRONYM.get(acronym)).filter(Boolean);
  const incoming = task.incoming[0] || {};
  const outgoing = task.outgoing[0] || {};
  const taskAttrs = {
    [A.TASK_ID]: task.id,
    [A.TASK_NAME]: task.name,
    [A.TASK_TYPE]: task.type,
    [A.TASK_SEQUENCE]: sequence,
    [A.LANE_ID]: task.laneId,
    [A.LANE_NAME]: task.laneName,
  };
  const ctx = withBaggage(taskAttrs);
  return api.context.with(ctx, () => tracer.startActiveSpan(`task ${task.name}`, {
    attributes: {
      ...taskAttrs,
      [A.TASK_PERFORMER]: isSystemLane(task.laneName) ? 'system' : 'human',
      [A.INCOMING_FLOW_ID]: incoming.id || '',
      [A.INCOMING_FLOW_SOURCE_ID]: incoming.sourceId || '',
      [A.OUTGOING_FLOW_ID]: outgoing.id || '',
      [A.OUTGOING_FLOW_TARGET_ID]: outgoing.targetId || '',
      [A.TASK_APP_ID]: taskAppIds,
      [A.TASK_APP_ACRONYM]: taskAppAcronyms,
    },
  }, async (span) => {
    const started = Date.now();
    activeInstances.set(instanceId, { flow: flow.name, task: task.name, startedAt: started });
    span.addEvent('bpmn.task.created');
    const human = !isSystemLane(task.laneName);
    const wait = thinkTimeMs(task);
    if (human) {
      // Queue time, then the person claims and works the task.
      await sleep(wait * 0.3);
      span.addEvent('bpmn.task.claimed', { [A.LANE_NAME]: task.laneName });
      await sleep(wait * 0.7);
    } else {
      await sleep(wait);
    }

    let outcome = 'completed';
    for (const call of task.calls) {
      const result = await invokeApi(call, journeyCtx);
      if (!result.ok) {
        outcome = 'failed';
        span.recordException(result.error || new Error('API call failed'));
        span.setStatus({ code: api.SpanStatusCode.ERROR, message: result.error?.message || 'API call failed' });
        span.setAttribute('error.type', String(result.error?.status || 'connection'));
        break;
      }
      if (result.attempts > 1) span.addEvent('bpmn.task.retried', { attempts: result.attempts, [A.API_ID]: call.apiId });
    }
    span.setAttribute(A.TASK_OUTCOME, outcome);
    const sale = SALE_EVENTS[flow.name];
    if (outcome === 'completed' && sale && sale.task === task.name) {
      const channel = sale.channel || journeyCtx.channel || 'in-store';
      const units = Math.max(1, Math.round(sale.units ? sale.units(journeyCtx) : 1));
      const unitPrice = sale.condition === 'used' ? Math.round(journeyCtx.salePrice * 0.55) : journeyCtx.salePrice;
      const saleAttrs = { [A.SALE_CHANNEL]: channel, [A.VEHICLE_CONDITION]: sale.condition };
      span.setAttributes({ ...saleAttrs, [A.SALE_UNITS]: units, 'business.sale.completed': true });
      span.addEvent('business.vehicle.sold', {
        ...saleAttrs,
        [A.SALE_UNITS]: units,
        [A.DEAL_ID]: journeyCtx.dealId,
        [A.VEHICLE_VIN]: journeyCtx.vin,
        'business.vehicle.model': journeyCtx.modelCode,
        'business.sale.unit_price': unitPrice,
        'business.sale.amount': unitPrice * units,
      });
      vehiclesSold.add(units, { ...saleAttrs, [A.PROCESS_NAME]: flow.name });
      salesRevenue.add(unitPrice * units, { ...saleAttrs, [A.PROCESS_NAME]: flow.name });
    }
    const metric = METRIC_BY_TASK.get(`${flow.name}|${task.name}`);
    if (outcome === 'completed' && metric) {
      const units = Math.max(1, Math.round(metric.units()));
      const value = metric.value ? Math.round(metric.value() * units) : 0;
      const labels = { 'business.metric': metric.id, 'business.metric.dimension': pick(metric.dimensions), [A.PROCESS_NAME]: flow.name };
      span.setAttributes({ ...labels, 'business.metric.units': units, ...(metric.value ? { 'business.metric.value': value } : {}) });
      span.addEvent('business.outcome', { ...labels, 'business.metric.units': units, ...(metric.value ? { 'business.metric.value': value } : {}) });
      outcomesCounter.add(units, labels);
      if (metric.value) outcomeValue.add(value, labels);
    }
    span.addEvent(outcome === 'completed' ? 'bpmn.task.completed' : 'bpmn.task.failed');
    taskDuration.record((Date.now() - started) / 1000, { [A.PROCESS_NAME]: flow.name, [A.TASK_NAME]: task.name, [A.LANE_NAME]: task.laneName, [A.TASK_OUTCOME]: outcome });
    span.end();
    return outcome;
  }));
}

/** One process instance. Resolves to { outcome, spanContext }. */
async function runProcessInstance(flow, journey, previousRoot) {
  const instanceId = `PI-${crypto.randomUUID()}`;
  const processAttrs = {
    [A.PROCESS_ID]: flow.processId,
    [A.PROCESS_NAME]: flow.name,
    [A.PROCESS_INSTANCE_ID]: instanceId,
    [A.PROCESS_DIAGRAM_ID]: flow.diagramId,
    [A.PROCESS_DOMAIN]: flow.domain,
    [A.PROCESS_SUBDOMAIN]: flow.subdomain,
    [A.JOURNEY_ID]: journey.id,
    [A.JOURNEY_TYPE]: journey.type,
    [A.JOURNEY_STEP]: journey.step,
    [A.CUSTOMER_ID]: journey.ctx.customerId,
    [A.DEALER_CODE]: journey.ctx.dealerCode,
    [A.DEAL_ID]: journey.ctx.dealId,
    [A.VEHICLE_VIN]: journey.ctx.vin,
    [A.SALE_CHANNEL]: journey.ctx.channel,
  };
  const startEvent = flow.events.find((e) => e.type === 'startEvent') || {};
  const endEvent = flow.events.find((e) => e.type === 'endEvent') || {};

  // A fresh root context (a new trace), carrying the process baggage.
  const rootCtx = withBaggage(processAttrs, api.ROOT_CONTEXT);
  return api.context.with(rootCtx, () => tracer.startActiveSpan(`process ${flow.name}`, {
    kind: api.SpanKind.INTERNAL,
    attributes: {
      ...processAttrs,
      [A.PROCESS_PARTICIPANT_ID]: flow.participantId,
      [A.PROCESS_PARTICIPANT_NAME]: flow.participantName,
      [A.PROCESS_COLLABORATION_ID]: flow.collaborationId,
      [A.PROCESS_LANES]: flow.lanes.map((l) => `${l.id}|${l.name}`),
      'bpmn.start_event.id': startEvent.id || '',
      'bpmn.end_event.id': endEvent.id || '',
    },
    links: previousRoot ? [{ context: previousRoot, attributes: { 'link.type': 'previous_process_in_journey' } }] : [],
  }, async (root) => {
    const started = Date.now();
    root.addEvent('bpmn.start_event', { 'bpmn.event.id': startEvent.id || '', 'bpmn.event.name': startEvent.name || '', 'bpmn.sequence_flow.outgoing.id': startEvent.outgoing?.[0]?.id || '' });
    let outcome = 'completed';
    try {
      for (let i = 0; i < flow.tasks.length; i += 1) {
        const task = flow.tasks[i];
        if (!isSystemLane(task.laneName) && /customer/i.test(task.laneName) && Math.random() < (flow.abandonRate ?? ABANDON_RATE)) {
          outcome = 'abandoned';
          root.addEvent('bpmn.process.abandoned', { [A.TASK_ID]: task.id, [A.TASK_NAME]: task.name });
          break;
        }
        const taskOutcome = await runTask(flow, task, i + 1, journey.ctx, instanceId);
        if (taskOutcome !== 'completed') {
          outcome = 'failed';
          root.setStatus({ code: api.SpanStatusCode.ERROR, message: `Task "${task.name}" failed` });
          root.addEvent('bpmn.process.failed', { [A.TASK_ID]: task.id, [A.TASK_NAME]: task.name });
          break;
        }
      }
      if (outcome === 'completed') {
        root.addEvent('bpmn.end_event', { 'bpmn.event.id': endEvent.id || '', 'bpmn.event.name': endEvent.name || '', 'bpmn.sequence_flow.incoming.id': endEvent.incoming?.[0]?.id || '' });
      }
    } finally {
      activeInstances.delete(instanceId);
      root.setAttribute(A.PROCESS_OUTCOME, outcome);
      instancesCounter.add(1, { [A.PROCESS_NAME]: flow.name, [A.PROCESS_OUTCOME]: outcome });
      processDuration.record((Date.now() - started) / 1000, { [A.PROCESS_NAME]: flow.name, [A.PROCESS_OUTCOME]: outcome });
      root.end();
    }
    return { outcome, spanContext: root.spanContext() };
  }));
}

/**
 * Journeys — the flows one deal goes through, in order. Every flow of a
 * journey carries the same business.deal.id and business.vehicle.vin. A step
 * marked `optional` is skipped (not ended) when it doesn't happen, and a
 * declined/abandoned optional step doesn't end the deal.
 *   online-purchase:      Digital Retailing → [upsell 60%] → [credit 55%] → [warranty 45%] → New Vehicle Delivery
 *   dealership-purchase:  Sales Contract Finalization → [upsell 50%] → [credit 65%] → [warranty 45%] → New Vehicle Delivery
 *   fleet-purchase:       Fleet Customer Sales Process → Fleet Order Fulfillment
 *   warranty-add-on:      Warranty only (a service-contract sale, not a vehicle sale)
 * The vehicle is counted as sold at delivery (SALE_EVENTS).
 * "Vehicle Feature & Package Upsell" has no BPMN IQ diagram — BPMN IQ
 * discovers it from these traces (GET /api/discovered-processes).
 */
const UPSELL = 'Vehicle Feature & Package Upsell';
const DELIVERY = 'New Vehicle Delivery Experience';
const JOURNEY_TYPES = [
  {
    type: 'online-purchase', channel: 'online', weight: 0.45,
    steps: [['Digital Retailing Journey', 1], [UPSELL, 0.6, 'optional'], ['Customer Credit Application', 0.55, 'optional'], ['Warranty Contract Execution', 0.45, 'optional'], [DELIVERY, 1]],
  },
  {
    type: 'dealership-purchase', channel: 'in-store', weight: 0.4,
    steps: [['Sales Contract Finalization', 1], [UPSELL, 0.5, 'optional'], ['Customer Credit Application', 0.65, 'optional'], ['Warranty Contract Execution', 0.45, 'optional'], [DELIVERY, 1]],
  },
  { type: 'fleet-purchase', channel: 'fleet', weight: 0.05, steps: [['Fleet Customer Sales Process', 1], ['Fleet Order Fulfillment', 1]] },
  { type: 'warranty-add-on', channel: '', weight: 0.1, steps: [['Warranty Contract Execution', 1]] },
];
let activeJourneys = 0;
// Flows that only run inside customer journeys; every other flow runs standalone.
const JOURNEY_FLOWS = new Set(JOURNEY_TYPES.flatMap((j) => j.steps.map(([name]) => name)));
const STANDALONE_FLOWS = catalog.flows.filter((f) => !JOURNEY_FLOWS.has(f.name));
let activeStandalone = 0;

/** One instance of a flow outside any customer journey (its own business transaction). */
async function runStandalone(flow) {
  const journey = { id: `TXN-${crypto.randomUUID()}`, type: 'standalone', ctx: newJourneyContext(), step: 1 };
  activeStandalone += 1;
  try {
    await runProcessInstance(flow, journey, null);
  } finally {
    activeStandalone -= 1;
  }
}

function pickJourneyType(requested) {
  const named = JOURNEY_TYPES.find((j) => j.type === requested);
  if (named) return named;
  let r = Math.random();
  for (const j of JOURNEY_TYPES) {
    r -= j.weight;
    if (r <= 0) return j;
  }
  return JOURNEY_TYPES[0];
}

async function runJourney(requestedType) {
  const def = pickJourneyType(requestedType);
  const journey = { id: `JRN-${crypto.randomUUID()}`, type: def.type, ctx: { ...newJourneyContext(), channel: def.channel }, step: 0 };
  activeJourneys += 1;
  let previousRoot = null;
  try {
    for (const [flowName, probability, mode] of def.steps) {
      if (Math.random() > probability) {
        if (mode === 'optional') continue;
        break;
      }
      const flow = flowByName(flowName);
      if (!flow) continue;
      journey.step += 1;
      const { outcome, spanContext } = await runProcessInstance(flow, journey, previousRoot);
      previousRoot = spanContext;
      // Declining an optional step (e.g. the upgrade offer) doesn't end the purchase.
      if (outcome !== 'completed' && mode !== 'optional') break;
      await sleep(lognormal(60000, 0.6) * WAIT_SCALE); // walk to the F&I office, etc.
    }
  } finally {
    activeJourneys -= 1;
  }
}

// ── Control API ─────────────────────────────────────────────────────────────
const server = express();
server.use(express.json());
server.get('/healthz', (_req, res) => res.json({ ok: true }));
server.get('/status', (_req, res) => {
  res.json({
    activeJourneys,
    activeStandalone,
    standaloneFlows: STANDALONE_FLOWS.length,
    activeInstances: [...activeInstances.entries()].map(([id, v]) => ({ id, ...v, runningSeconds: Math.round((Date.now() - v.startedAt) / 1000) })),
    flows: catalog.flows.map((f) => f.name),
    journeyTypes: JOURNEY_TYPES.map((j) => j.type),
  });
});
// Start standalone instances now: POST /flows {"count": 3, "name": "Battery Replacement Service"}
// (no name = random standalone flows)
server.post('/flows', (req, res) => {
  if (req.body?.all) {
    // One instance of every standalone flow (smoke test across the whole catalog).
    for (const flow of STANDALONE_FLOWS) runStandalone(flow).catch((err) => console.error('[engine] instance failed', err));
    return res.status(202).json({ started: STANDALONE_FLOWS.length, flow: 'all' });
  }
  const count = Math.min(Math.max(Number(req.body?.count) || 1, 1), 500);
  const named = req.body?.name ? flowByName(req.body.name) : null;
  if (req.body?.name && !named) return res.status(404).json({ error: `No flow named "${req.body.name}"` });
  for (let i = 0; i < count; i += 1) {
    const flow = named || STANDALONE_FLOWS[Math.floor(Math.random() * STANDALONE_FLOWS.length)];
    runStandalone(flow).catch((err) => console.error('[engine] instance failed', err));
  }
  res.status(202).json({ started: count, flow: named?.name || 'random' });
});

// Start journeys now: POST /journeys {"count": 5, "type": "online-purchase"}
server.post('/journeys', (req, res) => {
  const count = Math.min(Math.max(Number(req.body?.count) || 1, 1), 200);
  for (let i = 0; i < count; i += 1) runJourney(req.body?.type).catch((err) => console.error('[engine] journey failed', err));
  res.status(202).json({ started: count });
});

server.listen(ENGINE_PORT, () => {
  console.log(`[engine] ${catalog.flows.length} flows on :${ENGINE_PORT}`);
  if (process.env.SCHEDULER !== 'off') {
    startScheduler({ startJourney: () => runJourney(), activeJourneys: () => activeJourneys });
    startFlowScheduler({ flows: STANDALONE_FLOWS, startInstance: runStandalone, activeInstances: () => activeStandalone });
  }
});
