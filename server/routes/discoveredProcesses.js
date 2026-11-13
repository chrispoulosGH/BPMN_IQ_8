/**
 * GET /api/discovered-processes
 *
 * Business processes observed in production telemetry that BPMN IQ has no
 * diagram for. Reads Grafana Tempo (TEMPO_URL, default http://localhost:3200):
 *   1. every bpmn.process.name value seen in the lookback window;
 *   2. minus the flows that already have a Diagram (by name or businessFlow);
 *   3. for each remaining flow, fetch its recent process-instance traces and
 *      rebuild the BPMN 2.0 model from the spans (services/traceToBpmn.js).
 *
 * Query: ?hours=24 (lookback), ?fresh=1 (skip the 60 s cache).
 * 503 { code: 'TEMPO_UNREACHABLE' } when Tempo can't be reached.
 */
const express = require('express');
const Diagram = require('../models/Diagram');
const { spansFromOtlp, buildModels, toXml, median } = require('../services/traceToBpmn');

const router = express.Router();
const TEMPO_URL = (process.env.TEMPO_URL || 'http://localhost:3200').replace(/\/+$/, '');
const MAX_TRACES_PER_FLOW = Number(process.env.DISCOVERY_MAX_TRACES || 60);
const CACHE_TTL_MS = 60 * 1000;
let cache = null;

const normalize = (value) => String(value || '').replace(/&amp;/g, '&').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const traceQlString = (value) => String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');

async function tempoGet(pathAndQuery) {
  const res = await fetch(`${TEMPO_URL}${pathAndQuery}`, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`Tempo ${res.status} for ${pathAndQuery.split('?')[0]}`);
  return res.json();
}

/** Run promise-returning jobs with a small concurrency limit. */
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  }));
  return out;
}

async function discover(hours) {
  const end = Math.floor(Date.now() / 1000);
  const start = end - hours * 3600;
  const window = `start=${start}&end=${end}`;

  const tagValues = await tempoGet(`/api/v2/search/tag/${encodeURIComponent('span.bpmn.process.name')}/values?${window}`);
  const observed = (tagValues.tagValues || []).map((t) => t.value).filter(Boolean);

  const diagrams = await Diagram.find({}, { name: 1, businessFlow: 1 }).lean();
  const known = new Set(diagrams.flatMap((d) => [normalize(d.name), normalize(d.businessFlow)]).filter(Boolean));
  const undocumented = observed.filter((name) => !known.has(normalize(name)));

  const discovered = [];
  for (const flowName of undocumented) {
    const q = `{ name =~ "process .*" && span.bpmn.process.name = "${traceQlString(flowName)}" }`;
    const search = await tempoGet(`/api/search?q=${encodeURIComponent(q)}&limit=${MAX_TRACES_PER_FLOW}&${window}`);
    const hits = search.traces || [];
    if (!hits.length) continue;

    const traces = await mapLimit(hits, 6, (hit) => tempoGet(`/api/traces/${hit.traceID}`).catch(() => null));
    const spans = traces.filter(Boolean).flatMap((t) => [...spansFromOtlp({ resourceSpans: t.batches || t.resourceSpans || [] })]);
    const model = buildModels(spans).get(flowName);
    if (!model || !model.tasks.size) continue;

    const startTimes = hits.map((h) => Number(BigInt(h.startTimeUnixNano || 0) / 1000000n)).filter(Boolean);
    const tasks = [...model.tasks.values()].sort((a, b) => median(a.sequences) - median(b.sequences));
    discovered.push({
      name: flowName,
      processId: model.processId,
      domain: model.domain || '',
      subdomain: model.subdomain || '',
      instancesAnalyzed: model.instances,
      outcomes: model.outcomes,
      completionRate: model.instances ? model.completeInstances / model.instances : 0,
      firstSeen: startTimes.length ? new Date(Math.min(...startTimes)).toISOString() : null,
      lastSeen: startTimes.length ? new Date(Math.max(...startTimes)).toISOString() : null,
      lanes: [...model.lanes.values()].map((l) => ({ id: l.id, name: l.name })),
      tasks: tasks.map((t) => ({
        id: t.id,
        name: t.name,
        lane: t.laneName,
        applications: [...t.applications.keys()],
        apis: [...t.apis.values()],
        observedCount: t.count,
        medianDurationMs: Math.round(median(t.durationsMs)),
      })),
      applications: [...new Set(tasks.flatMap((t) => [...t.applications.keys()]))],
      sequenceFlowCount: model.flows.size,
      xml: toXml(model),
    });
  }

  return {
    generatedAt: new Date().toISOString(),
    source: 'tempo',
    tempoUrl: TEMPO_URL,
    lookbackHours: hours,
    observedFlows: observed,
    documentedFlowsObserved: observed.filter((name) => known.has(normalize(name))),
    discovered,
    note: 'A process is "discovered" when production traces carry a bpmn.process.name that has no diagram in BPMN IQ. Its model is rebuilt from the spans of up to '
      + `${MAX_TRACES_PER_FLOW} recent instances; only observed elements are drawn.`,
  };
}

router.get('/', async (req, res) => {
  const hours = Math.min(Math.max(Number(req.query.hours) || 24, 1), 24 * 7);
  const fresh = String(req.query.fresh || '') === '1';
  try {
    if (!fresh && cache && cache.hours === hours && Date.now() - cache.at < CACHE_TTL_MS) return res.json(cache.data);
    const data = await discover(hours);
    cache = { at: Date.now(), hours, data };
    res.json(data);
  } catch (error) {
    const unreachable = /fetch failed|ECONNREFUSED|Tempo \d+/.test(String(error?.message || error?.cause?.code || ''));
    console.error('[discovered-processes] failed:', error?.message || error);
    res.status(unreachable ? 503 : 500).json({
      error: unreachable ? `Could not reach Grafana Tempo at ${TEMPO_URL}. Is the mock production stack running (mockprod: docker compose up -d)?` : (error?.message || 'Discovery failed'),
      code: unreachable ? 'TEMPO_UNREACHABLE' : 'DISCOVERY_FAILED',
    });
  }
});

module.exports = router;
