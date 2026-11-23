/**
 * GET /api/undefined-processes
 *
 * Processes found in traffic that carries NO business context: no
 * bpmn.process.name on the spans (an empty header, or users working outside
 * the modeled flows). Reads Grafana Tempo (TEMPO_URL):
 *   1. API server spans without bpmn.process.name that carry session.id —
 *      the case id linking one user's actions (each action is its own trace);
 *   2. cases = sessions, steps ordered by time; a case is analysed once it has
 *      been idle for ?idleMinutes (default 5);
 *   3. each step is mapped to the API catalog (method + route, or the api id
 *      the app reports) → the established flow/task it was built for;
 *   4. each case is compared with every established flow
 *      (services/processMining.js): conformant / deviating → accounted to that
 *      flow; otherwise clustered into undefined processes, rebuilt as BPMN.
 *
 * Query: ?hours=6, ?idleMinutes=5, ?fresh=1. 503 TEMPO_UNREACHABLE.
 */
const express = require('express');
const Diagram = require('../models/Diagram');
const { getIntegrationMapCached } = require('./integrationMap');
const { buildApiSequence } = require('../services/apiSequence');
const { classifyCase, clusterCases, DEVIATION_THRESHOLD } = require('../services/processMining');
const { toXml, median } = require('../services/traceToBpmn');

const { liveOrSnapshot, registerView, isUnreachable } = require('../services/telemetrySnapshots');

const router = express.Router();
const TEMPO_URL = (process.env.TEMPO_URL || 'http://localhost:3200').replace(/\/+$/, '');
const MAX_STEPS = Number(process.env.UNDEFINED_MAX_STEPS || 5000);
let cache = null;
let referenceCache = null;

const decode = (v) => String(v ?? '').replace(/&amp;/g, '&').trim();
const humanize = (route) => {
  const last = String(route || '').split('/').filter(Boolean).pop() || route || 'Unknown step';
  return last.replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
};
const mode = (values) => {
  const counts = new Map();
  for (const v of values.filter(Boolean)) counts.set(v, (counts.get(v) || 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || '';
};

/** Established flows as API sequences, plus the catalog lookups. Cached 5 min. */
async function loadReference() {
  if (referenceCache && Date.now() - referenceCache.at < 5 * 60 * 1000) return referenceCache;
  const { data, apiIndex } = await getIntegrationMapCached(false);
  const acronymById = new Map(data.apps.map((a) => [a.id, a.acronym]));
  // api id → { flow, task, method, endpoint, provider acronym }; method+route → api ids
  const apiInfo = new Map();
  const byRoute = new Map();
  for (const [, apis] of apiIndex) {
    for (const api of apis) {
      const [flow, ...taskParts] = decode(api.name).split(' — ');
      const info = { id: api.id, flow, task: taskParts.join(' — ').replace(/\s+API$/i, ''), method: api.method, endpoint: api.endpoint, provider: acronymById.get(api.provider) || api.provider };
      apiInfo.set(api.id, info);
      const key = `${String(api.method).toUpperCase()} ${api.endpoint}`;
      if (!byRoute.has(key)) byRoute.set(key, new Set());
      byRoute.get(key).add(api.id);
    }
  }
  const diagrams = await Diagram.find({}, { name: 1, businessFlow: 1, domain: 1, subdomain: 1, xml: 1, tasks: 1 }).lean();
  const flows = [];
  const flowsByApi = new Map();
  for (const d of diagrams) {
    const seq = buildApiSequence(d, { apiIndex, apps: data.apps, dataObjects: {}, hosts: {} });
    const steps = seq.items
      .flatMap((item) => (item.kind === 'step' ? [item.step] : item.fragment.branches.flatMap((b) => b.steps)))
      // Tasks with no API can't be observed in API traffic, so they're not part of the comparison.
      .filter((s) => s.calls.length)
      .map((s) => ({ taskId: s.taskId, taskName: s.taskName, apiIds: new Set(s.calls.map((c) => c.id)) }));
    if (!steps.length) continue;
    const index = flows.length;
    flows.push({ name: d.name, diagramId: String(d._id), domain: decode(d.domain), subdomain: decode(d.subdomain), steps });
    for (const step of steps) for (const id of step.apiIds) {
      if (!flowsByApi.has(id)) flowsByApi.set(id, new Set());
      flowsByApi.get(id).add(index);
    }
  }
  referenceCache = { at: Date.now(), apiInfo, byRoute, flows, flowsByApi };
  return referenceCache;
}

async function tempoSearch(q, start, end) {
  const params = new URLSearchParams({ q, limit: String(MAX_STEPS), spss: '5', start: String(start), end: String(end) });
  const res = await fetch(`${TEMPO_URL}/api/search?${params}`, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`Tempo ${res.status}`);
  return res.json();
}

async function discover(hours, idleMinutes) {
  const end = Math.floor(Date.now() / 1000);
  const start = end - hours * 3600;
  const reference = await loadReference();

  // 1. API server spans with a session id (the consumer's /inbound hand-off
  //    excluded). Tempo's TraceQL can't test for a *missing* attribute
  //    (`= nil` matches nothing), so bpmn.process.name is selected and spans
  //    that have it — traffic with business context — are dropped below.
  const q = '{ kind = server && span.session.id != nil && span.http.route !~ ".*/inbound/.*" }'
    + ' | select(span.session.id, span.http.route, span.http.request.method, span.api.id, resource.service.name, span.http.response.status_code, span.bpmn.process.name)';
  const search = await tempoSearch(q, start, end);
  const steps = [];
  for (const trace of search.traces || []) {
    for (const set of trace.spanSets || (trace.spanSet ? [trace.spanSet] : [])) {
      for (const span of set.spans || []) {
        const a = Object.fromEntries((span.attributes || []).map((x) => [x.key, x.value?.stringValue ?? x.value?.intValue]));
        if (!a['session.id'] || a['bpmn.process.name']) continue; // only traffic without business context
        steps.push({
          session: a['session.id'],
          t: Number(BigInt(span.startTimeUnixNano || 0) / 1000000n),
          route: a['http.route'] || '',
          method: String(a['http.request.method'] || '').toUpperCase(),
          reportedApi: a['api.id'] || '',
          service: a['service.name'] || '',
          status: Number(a['http.response.status_code'] || 0),
        });
      }
    }
  }

  // 2. Cases = sessions, ordered by time; only idle (finished) sessions are analysed.
  const sessions = new Map();
  for (const s of steps) {
    if (!sessions.has(s.session)) sessions.set(s.session, []);
    sessions.get(s.session).push(s);
  }
  const idleMs = idleMinutes * 60 * 1000;
  let inProgress = 0;
  let unmappedSteps = 0;
  const cases = [];
  for (const [session, list] of sessions) {
    list.sort((x, y) => x.t - y.t);
    if (Date.now() - list[list.length - 1].t < idleMs) { inProgress += 1; continue; }
    // 3. Map each call to the catalog: route candidates, narrowed by the reporting app.
    const caseSteps = list.map((s) => {
      const ids = new Set(reference.byRoute.get(`${s.method} ${s.route}`) || []);
      if (s.reportedApi && reference.apiInfo.has(s.reportedApi)) ids.add(s.reportedApi);
      const known = [...ids].map((id) => reference.apiInfo.get(id)).filter(Boolean);
      const preferred = known.find((k) => k.id === s.reportedApi) || known.find((k) => k.provider === s.service) || known[0];
      if (!known.length) unmappedSteps += 1;
      return {
        ...s,
        apiIds: ids,
        key: preferred?.id || `${s.method} ${s.route}`,
        label: preferred?.task || humanize(s.route),
        sourceFlow: preferred?.flow || '',
        apiLabel: preferred ? `${preferred.id} ${s.method} ${s.route}` : `${s.method} ${s.route} (not in API catalog)`,
      };
    });
    cases.push({ session, steps: caseSteps, firstSeen: list[0].t, lastSeen: list[list.length - 1].t });
  }

  // 4. Compare every case with the established flows.
  const matchedByFlow = new Map();
  const undefinedCases = [];
  for (const c of cases) {
    const result = classifyCase(c.steps, reference.flows, reference.flowsByApi);
    c.closest = result.flow ? { flow: result.flow.name, diagramId: result.flow.diagramId, score: Math.round(result.score * 100) / 100 } : null;
    if (result.kind === 'undefined') { undefinedCases.push(c); continue; }
    const entry = matchedByFlow.get(result.flow.name) || {
      flow: result.flow.name, diagramId: result.flow.diagramId, domain: result.flow.domain,
      conformant: 0, deviating: 0, scores: [], deviations: new Map(),
    };
    entry[result.kind] += 1;
    entry.scores.push(result.score);
    for (const d of result.deviations) {
      const key = `${d.type}|${d.task}`;
      entry.deviations.set(key, { ...d, count: (entry.deviations.get(key)?.count || 0) + 1 });
    }
    matchedByFlow.set(result.flow.name, entry);
  }

  // Undefined cases → processes (clusters) → BPMN.
  const undefinedProcesses = clusterCases(undefinedCases).map((cluster, n) => {
    const number = String(n + 1).padStart(3, '0');
    const processId = `Process_Undefined_${number}`;
    const medoid = cluster.medoid.steps;
    const sameSignature = cluster.variants[0];
    const lanes = new Map();
    const tasks = new Map();
    const flows = new Map();
    medoid.forEach((step, i) => {
      const laneId = `Lane_${step.service.replace(/[^A-Za-z0-9]+/g, '_')}`;
      if (!lanes.has(laneId)) lanes.set(laneId, { id: laneId, name: step.service, nodeIds: new Set() });
      const taskId = `Task_U${number}_${i + 1}`;
      lanes.get(laneId).nodeIds.add(taskId);
      const gaps = sameSignature.map((c) => (i ? c.steps[i].t - c.steps[i - 1].t : 0)).filter((g) => g >= 0);
      tasks.set(taskId, {
        id: taskId, name: step.label, type: 'task', laneId, laneName: step.service,
        applications: new Map([[step.service, cluster.cases.length]]),
        apis: new Map([[step.key, { id: step.apiLabel.split(' ')[0], method: step.method, route: step.route, provider: step.service, count: cluster.cases.length }]]),
        count: cluster.cases.filter((c) => c.steps.some((s) => s.key === step.key)).length,
        sequences: [i + 1],
        durationsMs: gaps,
      });
    });
    const nodeIds = ['StartEvent_1', ...tasks.keys(), 'EndEvent_1'];
    nodeIds.slice(1).forEach((target, i) => flows.set(`Flow_${i + 1}`, { id: `Flow_${i + 1}`, sourceId: nodeIds[i], targetId: target, count: cluster.cases.length }));
    const firstLane = [...lanes.values()][0];
    const lastLane = lanes.get(tasks.get(nodeIds[nodeIds.length - 2])?.laneId) || firstLane;
    firstLane?.nodeIds.add('StartEvent_1');
    lastLane?.nodeIds.add('EndEvent_1');
    const sourceFlows = [...new Set(medoid.map((s) => s.sourceFlow).filter(Boolean))];
    const domain = mode(medoid.map((s) => reference.flows.find((f) => f.name === s.sourceFlow)?.domain));
    const name = `Undefined ${number}: ${medoid[0].label} → ${medoid[medoid.length - 1].label}`;
    const model = {
      name, processId, domain, subdomain: 'Undefined (discovered from untagged traffic)',
      lanes, tasks, flows,
      events: new Map([
        ['StartEvent_1', { id: 'StartEvent_1', type: 'startEvent', name: 'Session starts', count: cluster.cases.length }],
        ['EndEvent_1', { id: 'EndEvent_1', type: 'endEvent', name: 'Session ends', count: cluster.cases.length }],
      ]),
      instances: cluster.cases.length, outcomes: { observed: cluster.cases.length }, completeInstances: cluster.cases.length,
    };
    const closest = cluster.cases.map((c) => c.closest).filter(Boolean).sort((a, b) => b.score - a.score)[0] || null;
    return {
      id: processId,
      name,
      processId,
      domain,
      subdomain: model.subdomain,
      instancesAnalyzed: cluster.cases.length,
      firstSeen: new Date(Math.min(...cluster.cases.map((c) => c.firstSeen))).toISOString(),
      lastSeen: new Date(Math.max(...cluster.cases.map((c) => c.lastSeen))).toISOString(),
      lanes: [...lanes.values()].map((l) => ({ id: l.id, name: l.name })),
      applications: [...new Set(medoid.map((s) => s.service))],
      sourceFlows,
      closest,
      variants: cluster.variants.map((group) => ({ count: group.length, steps: group[0].steps.map((s) => s.label) })),
      tasks: [...tasks.values()].map((t, i) => ({
        id: t.id, name: t.name, lane: t.laneName, applications: [...t.applications.keys()],
        apis: [{ label: medoid[i].apiLabel }], sourceFlow: medoid[i].sourceFlow,
        observedCount: t.count, medianGapMs: Math.round(median(t.durationsMs)),
      })),
      sampleSessions: cluster.cases.slice(0, 5).map((c) => c.session),
      xml: toXml(model),
    };
  });

  const matched = [...matchedByFlow.values()].map((m) => ({
    flow: m.flow, diagramId: m.diagramId, domain: m.domain,
    conformant: m.conformant, deviating: m.deviating,
    meanScore: Math.round((m.scores.reduce((a, b) => a + b, 0) / m.scores.length) * 100) / 100,
    deviations: [...m.deviations.values()].sort((a, b) => b.count - a.count),
  })).sort((a, b) => (b.conformant + b.deviating) - (a.conformant + a.deviating));

  return {
    generatedAt: new Date().toISOString(),
    windowHours: hours,
    idleMinutes,
    caseIdAttribute: 'session.id',
    stepsAnalysed: steps.length,
    unmappedSteps,
    sessions: {
      total: sessions.size,
      inProgress,
      analysed: cases.length,
      conformant: matched.reduce((n, m) => n + m.conformant, 0),
      deviating: matched.reduce((n, m) => n + m.deviating, 0),
      undefined: undefinedCases.length,
    },
    matched,
    undefinedProcesses,
    thresholds: { deviation: DEVIATION_THRESHOLD },
    note: `Untagged traffic (no bpmn.process.name) grouped into cases by session.id. Each case is compared with every established flow by API sequence: an exact match is that flow run without business context; ≥${Math.round(DEVIATION_THRESHOLD * 100)}% similarity is that flow with deviations; anything else is clustered into an undefined process.`,
  };
}

router.get('/', async (req, res) => {
  const hours = Math.min(Math.max(Number(req.query.hours) || 6, 1), 24 * 7);
  const idleMinutes = Math.min(Math.max(Number(req.query.idleMinutes ?? 5), 0), 120);
  const fresh = String(req.query.fresh || '') === '1';
  try {
    const key = `${hours}|${idleMinutes}`;
    if (!fresh && cache && cache.key === key && Date.now() - cache.at < 60 * 1000) return res.json(cache.data);
    const { data, snapshot } = await liveOrSnapshot('undefined-processes', { hours, idleMinutes }, () => discover(hours, idleMinutes));
    if (snapshot) return res.json({ ...data, snapshot });
    cache = { at: Date.now(), key, data };
    res.json(data);
  } catch (error) {
    const unreachable = isUnreachable(error);
    console.error('[undefined-processes] failed:', error?.message || error);
    res.status(unreachable ? 503 : 500).json({
      error: unreachable ? `Could not reach Grafana Tempo at ${TEMPO_URL}, and no saved snapshot of this view exists yet. Is the mock production stack running (mockprod/stack.sh start)?` : (error?.message || 'Discovery failed'),
      code: unreachable ? 'TEMPO_UNREACHABLE' : 'DISCOVERY_FAILED',
    });
  }
});

registerView('undefined-processes', {
  source: 'tempo',
  standardParams: [6, 24, 168].map((hours) => ({ hours, idleMinutes: 5 })),
  compute: ({ hours, idleMinutes }) => discover(hours, idleMinutes),
});

module.exports = router;
