/**
 * GET /api/discovered-processes
 *
 * Business processes observed in production telemetry that BPMN IQ has no
 * diagram for. Reads Grafana Tempo (TEMPO_URL, default http://localhost:3200):
 *   1. every bpmn.process.name value seen in the lookback window, with the
 *      bpmn.diagram.id / bpmn.process.id values its root spans carry;
 *   2. each flow is matched to a BPMN IQ diagram, strongest evidence first
 *      (classifyFlow): diagram id → BPMN <process id> → normalized name;
 *   3. flows with no match are "discovered": their recent process-instance
 *      traces are fetched and the BPMN 2.0 model is rebuilt from the spans
 *      (services/traceToBpmn.js).
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

/** Every <process id> in a diagram's XML. */
const processIdsFromXml = (xml) => [...String(xml || '').matchAll(/<(?:bpmn2?:)?process\b[^>]*\bid="([^"]+)"/gi)].map((m) => m[1]);

/**
 * Lookup tables over BPMN IQ's diagrams. A process id or name shared by
 * several diagrams is ambiguous and kept out of its table (reported instead),
 * so a generic id like "Process_1" can never produce a false match.
 */
function buildDiagramIndex(diagrams) {
  const byDiagramId = new Map();
  const processIdOwners = new Map();
  const nameOwners = new Map();
  const own = (map, key, diagram) => {
    if (!key) return;
    if (!map.has(key)) map.set(key, new Map());
    map.get(key).set(String(diagram._id), diagram);
  };
  for (const d of diagrams) {
    const summary = { _id: String(d._id), name: d.name, businessFlow: d.businessFlow || '' };
    byDiagramId.set(summary._id, summary);
    for (const pid of new Set(processIdsFromXml(d.xml))) own(processIdOwners, pid, summary);
    for (const n of new Set([normalize(d.name), normalize(d.businessFlow)].filter(Boolean))) own(nameOwners, n, summary);
  }
  const unique = (owners) => new Map([...owners].filter(([, m]) => m.size === 1).map(([k, m]) => [k, [...m.values()][0]]));
  const shared = (owners) => [...owners].filter(([, m]) => m.size > 1).map(([k]) => k);
  return {
    byDiagramId,
    byProcessId: unique(processIdOwners),
    byName: unique(nameOwners),
    ambiguousProcessIds: new Set(shared(processIdOwners)),
    ambiguousNames: new Set(shared(nameOwners)),
  };
}

/**
 * Is an observed flow already modeled in BPMN IQ? Strongest evidence first:
 *   1. diagramId  — a bpmn.diagram.id on its spans is a diagram that exists
 *                   (survives renames; a deleted diagram's id falls through)
 *   2. processId  — its bpmn.process.id is the <process id> of exactly one diagram
 *   3. name       — its normalized name matches exactly one diagram's name/businessFlow
 * @param {{name: string, diagramIds: string[], processIds: string[]}} flow
 */
function classifyFlow(flow, index) {
  for (const id of flow.diagramIds) {
    const diagram = index.byDiagramId.get(id);
    if (diagram) return { documented: true, matchedBy: 'diagramId', diagram };
  }
  for (const pid of flow.processIds) {
    const diagram = index.byProcessId.get(pid);
    if (diagram) return { documented: true, matchedBy: 'processId', diagram };
  }
  const diagram = index.byName.get(normalize(flow.name));
  if (diagram) return { documented: true, matchedBy: 'name', diagram };
  const notes = [];
  if (flow.diagramIds.length) notes.push(`diagram id ${flow.diagramIds.join(', ')} no longer exists in BPMN IQ`);
  const ambiguous = flow.processIds.filter((pid) => index.ambiguousProcessIds.has(pid));
  if (ambiguous.length) notes.push(`process id ${ambiguous.join(', ')} is used by several diagrams`);
  if (index.ambiguousNames.has(normalize(flow.name))) notes.push('name is shared by several diagrams');
  return { documented: false, matchedBy: null, diagram: null, notes };
}

/** The diagram / process ids a flow's root spans carry (a sample of recent instances). */
async function observedIdentity(flowName, window) {
  const q = `{ name =~ "process .*" && span.bpmn.process.name = "${traceQlString(flowName)}" } | select(span.bpmn.diagram.id, span.bpmn.process.id)`;
  const search = await tempoGet(`/api/search?q=${encodeURIComponent(q)}&limit=20&${window}`);
  const diagramIds = new Set();
  const processIds = new Set();
  for (const trace of search.traces || []) {
    for (const set of trace.spanSets || (trace.spanSet ? [trace.spanSet] : [])) {
      for (const span of set.spans || []) {
        for (const attr of span.attributes || []) {
          const value = attr.value?.stringValue;
          if (!value) continue;
          if (attr.key === 'bpmn.diagram.id') diagramIds.add(value);
          if (attr.key === 'bpmn.process.id') processIds.add(value);
        }
      }
    }
  }
  return { name: flowName, diagramIds: [...diagramIds], processIds: [...processIds] };
}

async function discover(hours) {
  const end = Math.floor(Date.now() / 1000);
  const start = end - hours * 3600;
  const window = `start=${start}&end=${end}`;

  const tagValues = await tempoGet(`/api/v2/search/tag/${encodeURIComponent('span.bpmn.process.name')}/values?${window}`);
  const observedNames = (tagValues.tagValues || []).map((t) => t.value).filter(Boolean);

  const diagrams = await Diagram.find({}, { name: 1, businessFlow: 1, xml: 1 }).lean();
  const index = buildDiagramIndex(diagrams);
  const identities = await mapLimit(observedNames, 4, (name) => observedIdentity(name, window));
  const matches = identities.map((flow) => {
    const result = classifyFlow(flow, index);
    return {
      name: flow.name,
      diagramIds: flow.diagramIds,
      processIds: flow.processIds,
      documented: result.documented,
      matchedBy: result.matchedBy,
      diagram: result.diagram ? { id: result.diagram._id, name: result.diagram.name } : null,
      notes: result.notes || [],
    };
  });
  const observed = observedNames;
  const known = new Set(matches.filter((m) => m.documented).map((m) => m.name));
  const undocumented = matches.filter((m) => !m.documented).map((m) => m.name);

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
    const match = matches.find((m) => m.name === flowName);
    discovered.push({
      name: flowName,
      // Why it counts as undocumented (e.g. its diagram id points at a deleted diagram).
      matchNotes: match?.notes || [],
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
    documentedFlowsObserved: observed.filter((name) => known.has(name)),
    // How each observed flow was matched (or not) to a BPMN IQ diagram.
    matches,
    discovered,
    note: 'A process is "discovered" when no BPMN IQ diagram matches it by diagram id, BPMN process id or name (in that order). Its model is rebuilt from the spans of up to '
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
module.exports.classifyFlow = classifyFlow;
module.exports.buildDiagramIndex = buildDiagramIndex;
