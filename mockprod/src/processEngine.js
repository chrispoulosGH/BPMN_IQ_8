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
 * Journeys — which flows a customer goes through, in order. A step with
 * `optional` is skipped (not ended) when it doesn't happen:
 *   online-purchase:     Digital Retailing → (60%, optional) Feature & Package Upsell
 *                        → (55%) Credit Application → (45%) Warranty
 *   dealership-finance:  (50%, optional) Upsell → Credit Application → (45%) Warranty
 *   warranty-add-on:     Warranty only
 * "Vehicle Feature & Package Upsell" has no BPMN IQ diagram — BPMN IQ
 * discovers it from these traces (GET /api/discovered-processes).
 */
const UPSELL = 'Vehicle Feature & Package Upsell';
const JOURNEY_TYPES = [
  { type: 'online-purchase', weight: 0.65, steps: [['Digital Retailing Journey', 1], [UPSELL, 0.6, 'optional'], ['Customer Credit Application', 0.55], ['Warranty Contract Execution', 0.45]] },
  { type: 'dealership-finance', weight: 0.25, steps: [[UPSELL, 0.5, 'optional'], ['Customer Credit Application', 1], ['Warranty Contract Execution', 0.45]] },
  { type: 'warranty-add-on', weight: 0.1, steps: [['Warranty Contract Execution', 1]] },
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
  const journey = { id: `JRN-${crypto.randomUUID()}`, type: def.type, ctx: newJourneyContext(), step: 0 };
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
