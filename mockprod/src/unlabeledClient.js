/**
 * "dealer-workstation": user sessions that call the applications' APIs with
 * NO business context — no bpmn.* / business.* baggage, no process or task
 * spans. Every user action is its own trace (as from an uninstrumented UI);
 * the only thing linking a session's actions is the session id the client
 * sends (x-session-id), which the applications record as `session.id`.
 *
 * Scenarios (catalog/unlabeled-scenarios.json):
 *   vacant     an established flow, run exactly as modeled, empty header
 *   deviation  an established flow with one change: skip / swap / rework
 *   emergent   a sequence no diagram has (new process from user behaviour)
 *
 * BPMN IQ rebuilds these from the traces: GET /api/undefined-processes.
 */
const { initTelemetry } = require('./otel');
initTelemetry({ serviceName: 'dealer-workstation', attributes: { 'app.id': 'CLIENT-WORKSTATION', 'app.acronym': 'dealer-workstation' } });

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const api = require('@opentelemetry/api');
const { catalog, appUrl, flowByName, isSystemLane } = require('./catalog');
const { newJourneyContext, buildBody } = require('./payloads');
const { ratePerSecond } = require('./scheduler');

const scenarios = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'catalog', 'unlabeled-scenarios.json'), 'utf8'));
const WAIT_SCALE = Number(process.env.WAIT_SCALE || 1);
const PER_DAY = Number(process.env.UNLABELED_PER_DAY ?? scenarios.perDay ?? 160);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const lognormal = (median, sigma = 0.5) => {
  const u = Math.max(Math.random(), 1e-9);
  return median * Math.exp(sigma * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * Math.random()));
};

// Established flows (modeled in BPMN IQ) that can run with an empty header:
// every flow with a diagram whose tasks all have an API.
const ESTABLISHED = catalog.flows.filter((f) => !f.discovered && f.tasks.length >= 3 && f.tasks.every((t) => t.calls.length));

/** Steps for one session: [{ task, call }] in the order the user performs them. */
function planSession() {
  const r = Math.random();
  const w = scenarios.weights;
  if (r < w.vacant) {
    const flow = ESTABLISHED[Math.floor(Math.random() * ESTABLISHED.length)];
    return { scenario: 'vacant', label: flow.name, steps: flow.tasks.map((task) => ({ task, call: task.calls[0] })) };
  }
  if (r < w.vacant + w.deviation) {
    const flow = ESTABLISHED[Math.floor(Math.random() * ESTABLISHED.length)];
    const steps = flow.tasks.map((task) => ({ task, call: task.calls[0] }));
    const kind = ['skip', 'swap', 'rework'][Math.floor(Math.random() * 3)];
    const i = 1 + Math.floor(Math.random() * (steps.length - 2));
    if (kind === 'skip') steps.splice(i, 1);
    if (kind === 'swap') [steps[i], steps[i + 1]] = [steps[i + 1], steps[i]];
    if (kind === 'rework') steps.splice(i + 1, 0, steps[i]);
    return { scenario: 'deviation', label: `${flow.name} (${kind} at step ${i + 1})`, steps };
  }
  const def = scenarios.emergent[Math.floor(Math.random() * scenarios.emergent.length)];
  const steps = def.steps.map(({ flow: flowName, task: taskName }) => {
    const task = flowByName(flowName)?.tasks.find((t) => t.name === taskName);
    return task?.calls.length ? { task, call: task.calls[0] } : null;
  }).filter(Boolean);
  return { scenario: 'emergent', label: def.name, steps };
}

let active = 0;
let started = 0;
const counts = { vacant: 0, deviation: 0, emergent: 0 };

async function runSession(forced) {
  const plan = forced || planSession();
  counts[plan.scenario] = (counts[plan.scenario] || 0) + 1;
  const sessionId = `SES-${crypto.randomUUID()}`;
  const ctx = newJourneyContext();
  active += 1;
  try {
    for (const { task, call } of plan.steps) {
      // Human think time before each action (system steps are quick clicks).
      await sleep((isSystemLane(task.laneName) ? lognormal(1500, 0.5) : lognormal(20000, 0.6)) * WAIT_SCALE);
      // A fresh context: no parent span, no baggage — every action is its own trace.
      await api.context.with(api.ROOT_CONTEXT, async () => {
        try {
          await fetch(`${appUrl(call.provider)}${call.endpoint}`, {
            method: call.method,
            headers: {
              'content-type': 'application/json',
              'x-session-id': sessionId,
              'x-api-id': call.apiId,
              'x-sim-context': Buffer.from(JSON.stringify(ctx)).toString('base64'),
            },
            body: call.method === 'GET' ? undefined : JSON.stringify(buildBody(catalog.dataObjects[call.requestObject], ctx) || {}),
          });
        } catch { /* a failed call is still part of the session */ }
      });
    }
  } finally {
    active -= 1;
  }
}

// Arrivals follow the dealership curve (scheduler.ratePerSecond is per DAILY_JOURNEYS).
const DAILY_JOURNEYS = Number(process.env.DAILY_JOURNEYS || 300);
if (PER_DAY > 0) {
  setInterval(() => {
    if (active >= 200) return;
    const lambda = ratePerSecond() * (PER_DAY / DAILY_JOURNEYS);
    if (Math.random() < lambda) {
      started += 1;
      runSession().catch(() => {});
    }
  }, 1000);
}
setInterval(() => console.log(`[dealer-workstation] ${active} sessions active, ${started} started ${JSON.stringify(counts)}`), 5 * 60 * 1000).unref();

// Control: POST /sessions {"count": 10, "scenario": "emergent"} on UNLABELED_PORT (default 7099)
const express = require('express');
const server = express();
server.use(express.json());
server.get('/healthz', (_req, res) => res.json({ ok: true, active, started, counts }));
server.post('/sessions', (req, res) => {
  const count = Math.min(Math.max(Number(req.body?.count) || 1, 1), 300);
  const wanted = req.body?.scenario;
  for (let i = 0; i < count; i += 1) {
    let plan = planSession();
    for (let tries = 0; wanted && plan.scenario !== wanted && tries < 50; tries += 1) plan = planSession();
    started += 1;
    runSession(plan).catch(() => {});
  }
  res.status(202).json({ started: count, scenario: wanted || 'mixed' });
});
const port = Number(process.env.UNLABELED_PORT || 7099);
server.listen(port, () => console.log(`[dealer-workstation] ${PER_DAY}/day unlabeled sessions; ${ESTABLISHED.length} established flows, ${scenarios.emergent.length} emergent processes; control on :${port}`));
