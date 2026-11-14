/**
 * Trace → BPMN 2.0: rebuilds business-process models from OpenTelemetry spans
 * that carry the bpmn.* / business.* attributes (see mockprod/src/attributes.js),
 * and serializes them as BPMN 2.0 XML with an auto-layout.
 *
 * Used by:
 *   - GET /api/discovered-processes (routes/discoveredProcesses.js), on spans
 *     fetched from Grafana Tempo
 *   - mockprod/src/tools/reconstruct-bpmn.js (CLI), on the collector's file export
 *
 * Input spans are normalized to
 *   { traceId, spanId, parentSpanId, name, start, end, attributes, resource, events }
 * spansFromOtlp() converts an OTLP JSON { resourceSpans } document (Tempo's
 * /api/traces/:id `batches` have the same shape).
 */
// ── Reading spans ───────────────────────────────────────────────────────────
const anyValue = (v) => {
  if (!v || typeof v !== 'object') return v;
  if ('stringValue' in v) return v.stringValue;
  if ('intValue' in v) return Number(v.intValue);
  if ('doubleValue' in v) return v.doubleValue;
  if ('boolValue' in v) return v.boolValue;
  if ('arrayValue' in v) return (v.arrayValue.values || []).map(anyValue);
  return v;
};
const kvList = (list) => Object.fromEntries((list || []).map((kv) => [kv.key, anyValue(kv.value)]));

function* spansFromOtlp(doc) {
  for (const rs of doc.resourceSpans || []) {
    const resource = kvList(rs.resource?.attributes);
    for (const ss of rs.scopeSpans || []) {
      for (const s of ss.spans || []) {
        yield {
          traceId: s.traceId, spanId: s.spanId, parentSpanId: s.parentSpanId || '', name: s.name,
          start: Number(BigInt(s.startTimeUnixNano || 0) / 1000000n), end: Number(BigInt(s.endTimeUnixNano || 0) / 1000000n),
          attributes: kvList(s.attributes), resource,
          events: (s.events || []).map((e) => ({ name: e.name, attributes: kvList(e.attributes) })),
        };
      }
    }
  }
}

function normalizeFlat(s) {
  const attributes = s.attributes || s.span_attributes || {};
  return {
    traceId: s.traceId || s.trace_id, spanId: s.spanId || s.span_id, parentSpanId: s.parentSpanId || s.parent_span_id || '',
    name: s.name || s.span_name, start: Date.parse(s.startTime || s.start_time) || Number(s.start) || 0,
    end: Date.parse(s.endTime || s.end_time) || Number(s.end) || 0,
    attributes: typeof attributes === 'string' ? JSON.parse(attributes) : attributes,
    resource: s.resource || s.resource_attributes || {},
    events: s.events || [],
  };
}

// ── Model from spans ────────────────────────────────────────────────────────
function buildModels(spans) {
  const byTrace = new Map();
  for (const s of spans) {
    if (!byTrace.has(s.traceId)) byTrace.set(s.traceId, []);
    byTrace.get(s.traceId).push(s);
  }
  const models = new Map(); // process name -> model
  for (const traceSpans of byTrace.values()) {
    const root = traceSpans.find((s) => s.attributes['bpmn.process.lanes'] && s.name.startsWith('process '));
    const anyProcessSpan = root || traceSpans.find((s) => s.attributes['bpmn.process.name']);
    if (!anyProcessSpan) continue;
    const a = anyProcessSpan.attributes;
    const name = a['bpmn.process.name'];
    if (!models.has(name)) {
      models.set(name, {
        name, processId: a['bpmn.process.id'], diagramId: a['bpmn.diagram.id'], domain: a['bpmn.domain'], subdomain: a['bpmn.subdomain'],
        lanes: new Map(), tasks: new Map(), flows: new Map(), events: new Map(), instances: 0, outcomes: {}, completeInstances: 0,
      });
    }
    const model = models.get(name);
    if (root) {
      model.instances += 1;
      const outcome = root.attributes['bpmn.process.outcome'] || 'unknown';
      model.outcomes[outcome] = (model.outcomes[outcome] || 0) + 1;
      if (outcome === 'completed') model.completeInstances += 1;
      for (const entry of root.attributes['bpmn.process.lanes'] || []) {
        const [id, ...rest] = String(entry).split('|');
        if (!model.lanes.has(id)) model.lanes.set(id, { id, name: rest.join('|'), nodeIds: new Set() });
      }
      for (const e of root.events) {
        if (e.name === 'bpmn.start_event' || e.name === 'bpmn.end_event') {
          const id = e.attributes['bpmn.event.id'];
          if (!id) continue;
          const type = e.name === 'bpmn.start_event' ? 'startEvent' : 'endEvent';
          const ev = model.events.get(id) || { id, type, name: e.attributes['bpmn.event.name'] || '', count: 0 };
          ev.count += 1;
          model.events.set(id, ev);
        }
      }
    }

    // Task spans, plus the APIs called beneath each.
    const taskSpans = traceSpans.filter((s) => s.name.startsWith('task ') && s.attributes['bpmn.task.id']);
    const childrenOf = new Map();
    for (const s of traceSpans) {
      if (!childrenOf.has(s.parentSpanId)) childrenOf.set(s.parentSpanId, []);
      childrenOf.get(s.parentSpanId).push(s);
    }
    for (const t of taskSpans) {
      const ta = t.attributes;
      const task = model.tasks.get(ta['bpmn.task.id']) || {
        id: ta['bpmn.task.id'], name: ta['bpmn.task.name'], type: ta['bpmn.task.type'] || 'task', laneId: ta['bpmn.lane.id'],
        laneName: ta['bpmn.lane.name'], applications: new Map(), apis: new Map(), count: 0, sequences: [], durationsMs: [],
      };
      task.count += 1;
      task.sequences.push(Number(ta['bpmn.task.sequence']) || 0);
      task.durationsMs.push(t.end - t.start);
      // A task can run in several applications (an array attribute); older spans carry one string.
      const taskApps = ta['bpmn.task.application.acronym'];
      for (const app of (Array.isArray(taskApps) ? taskApps : [taskApps]).filter(Boolean)) {
        task.applications.set(app, (task.applications.get(app) || 0) + 1);
      }
      // API server spans under this task (any depth), excluding /inbound hand-offs.
      const stack = [...(childrenOf.get(t.spanId) || [])];
      while (stack.length) {
        const s = stack.pop();
        if (s.attributes['api.id'] && s.attributes['api.provider.app_id'] && !String(s.name).includes('/inbound') && s.attributes['http.route']) {
          const key = s.attributes['api.id'];
          const entry = task.apis.get(key) || { id: key, method: s.attributes['http.request.method'], route: s.attributes['http.route'], provider: s.resource['service.name'], count: 0 };
          entry.count += 1;
          task.apis.set(key, entry);
        }
        stack.push(...(childrenOf.get(s.spanId) || []));
      }
      model.tasks.set(task.id, task);
      if (task.laneId) {
        if (!model.lanes.has(task.laneId)) model.lanes.set(task.laneId, { id: task.laneId, name: task.laneName, nodeIds: new Set() });
        model.lanes.get(task.laneId).nodeIds.add(task.id);
      }
      const addFlow = (id, sourceId, targetId) => {
        if (!id || !sourceId || !targetId) return;
        const f = model.flows.get(id) || { id, sourceId, targetId, count: 0 };
        f.count += 1;
        model.flows.set(id, f);
      };
      addFlow(ta['bpmn.sequence_flow.incoming.id'], ta['bpmn.sequence_flow.incoming.source_id'], task.id);
      // Outgoing flows are counted only when the next element was actually reached;
      // record them here and prune unreached targets below.
      if (ta['bpmn.sequence_flow.outgoing.id']) {
        const id = ta['bpmn.sequence_flow.outgoing.id'];
        if (!model.flows.has(id)) model.flows.set(id, { id, sourceId: task.id, targetId: ta['bpmn.sequence_flow.outgoing.target_id'], count: 0, outgoingOnly: true });
      }
    }
  }

  // Lanes hold their events too: start in the first task's lane, end in the last's.
  for (const model of models.values()) {
    for (const flow of model.flows.values()) {
      const target = model.tasks.get(flow.targetId) || model.events.get(flow.targetId);
      if (!target) {
        if (flow.outgoingOnly) model.flows.delete(flow.id);
        continue;
      }
      if (flow.outgoingOnly && model.events.has(flow.targetId)) flow.count = model.events.get(flow.targetId).count;
    }
    const tasksInOrder = [...model.tasks.values()].sort((x, y) => median(x.sequences) - median(y.sequences));
    const first = tasksInOrder[0];
    const last = tasksInOrder[tasksInOrder.length - 1];
    for (const ev of model.events.values()) {
      const anchor = ev.type === 'startEvent' ? first : last;
      if (anchor?.laneId && model.lanes.has(anchor.laneId)) model.lanes.get(anchor.laneId).nodeIds.add(ev.id);
    }
  }
  return models;
}

const median = (list) => {
  if (!list.length) return 0;
  const sorted = [...list].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
};

// ── XML ─────────────────────────────────────────────────────────────────────
const esc = (v) => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function toXml(model) {
  const tasks = [...model.tasks.values()].sort((x, y) => median(x.sequences) - median(y.sequences));
  const lanes = [...model.lanes.values()];
  const start = [...model.events.values()].find((e) => e.type === 'startEvent');
  const end = [...model.events.values()].find((e) => e.type === 'endEvent');
  const pid = model.processId || `Process_${model.name.replace(/\W+/g, '_')}`;

  // Layout: one column per task in order; events at the ends; lanes as bands.
  const LANE_H = 140; const LANE_X = 60; const LANE_Y = 60; const COL_W = 200; const TASK_W = 120; const TASK_H = 80;
  const laneIndex = new Map(lanes.map((l, i) => [l.id, i]));
  const columns = [start, ...tasks, end].filter(Boolean);
  const laneOf = (node) => lanes.find((l) => l.nodeIds.has(node.id))?.id || node.laneId;
  const pos = new Map(columns.map((node, i) => {
    const li = laneIndex.get(laneOf(node)) ?? 0;
    const isEvent = node.type === 'startEvent' || node.type === 'endEvent';
    const cx = LANE_X + 120 + i * COL_W;
    const cy = LANE_Y + li * LANE_H + LANE_H / 2;
    return [node.id, isEvent ? { x: cx - 18, y: cy - 18, w: 36, h: 36 } : { x: cx - TASK_W / 2, y: cy - TASK_H / 2, w: TASK_W, h: TASK_H }];
  }));
  const laneWidth = 240 + columns.length * COL_W;

  const out = [];
  out.push('<?xml version="1.0" encoding="UTF-8"?>');
  out.push(`<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:bpmndi="http://www.omg.org/spec/BPMN/20100524/DI" xmlns:dc="http://www.omg.org/spec/DD/20100524/DC" xmlns:di="http://www.omg.org/spec/DD/20100524/DI" id="Definitions_${esc(pid)}_observed" targetNamespace="http://bpmn.io/schema/bpmn" exporter="bpmn-iq-mockprod reconstruct-bpmn" exporterVersion="1.0">`);
  out.push(`  <bpmn:process id="${esc(pid)}" isExecutable="false">`);
  out.push(`    <bpmn:documentation>Reconstructed from OpenTelemetry traces: ${model.instances} process instances (${Object.entries(model.outcomes).map(([k, v]) => `${v} ${k}`).join(', ')}).</bpmn:documentation>`);
  out.push('    <bpmn:laneSet>');
  for (const lane of lanes) {
    out.push(`      <bpmn:lane id="${esc(lane.id)}" name="${esc(lane.name)}">`);
    for (const id of columns.map((n) => n.id).filter((id) => lane.nodeIds.has(id))) out.push(`        <bpmn:flowNodeRef>${esc(id)}</bpmn:flowNodeRef>`);
    out.push('      </bpmn:lane>');
  }
  out.push('    </bpmn:laneSet>');
  const flowsFor = (id, dir) => [...model.flows.values()].filter((f) => (dir === 'in' ? f.targetId : f.sourceId) === id);
  const refs = (id) => [...flowsFor(id, 'in').map((f) => `      <bpmn:incoming>${esc(f.id)}</bpmn:incoming>`), ...flowsFor(id, 'out').map((f) => `      <bpmn:outgoing>${esc(f.id)}</bpmn:outgoing>`)].join('\n');
  if (start) out.push(`    <bpmn:startEvent id="${esc(start.id)}" name="${esc(start.name)}">\n${refs(start.id)}\n    </bpmn:startEvent>`);
  for (const t of tasks) {
    const apis = [...t.apis.values()].map((a) => `${a.method} ${a.route} (${a.id}, ${a.provider})`).join('; ');
    const doc = `Observed in ${t.count} instance(s); median duration ${Math.round(median(t.durationsMs) / 1000)}s${apis ? `. APIs: ${apis}` : ''}`;
    out.push(`    <bpmn:${t.type === 'task' ? 'task' : esc(t.type)} id="${esc(t.id)}" name="${esc(t.name)}">\n      <bpmn:documentation>${esc(doc)}</bpmn:documentation>\n${refs(t.id)}\n    </bpmn:${t.type === 'task' ? 'task' : esc(t.type)}>`);
  }
  if (end) out.push(`    <bpmn:endEvent id="${esc(end.id)}" name="${esc(end.name)}">\n${refs(end.id)}\n    </bpmn:endEvent>`);
  for (const f of model.flows.values()) out.push(`    <bpmn:sequenceFlow id="${esc(f.id)}" sourceRef="${esc(f.sourceId)}" targetRef="${esc(f.targetId)}"/>`);
  // Task applications, in the same text-annotation form BPMN IQ uses.
  for (const t of tasks) {
    const apps = [...t.applications.keys()];
    if (!apps.length) continue;
    out.push(`    <bpmn:textAnnotation id="TextAnnotation_${esc(t.id)}"><bpmn:text>${esc(apps.join(', '))}</bpmn:text></bpmn:textAnnotation>`);
    out.push(`    <bpmn:association id="Association_${esc(t.id)}" sourceRef="TextAnnotation_${esc(t.id)}" targetRef="${esc(t.id)}"/>`);
  }
  out.push('  </bpmn:process>');

  const meta = `Domain: ${model.domain || ''} | Subdomain: ${model.subdomain || ''} | Business Flow: ${model.name}`;
  out.push(`  <bpmndi:BPMNDiagram id="BPMNDiagram_${esc(pid)}" name="${esc(meta)}">`);
  out.push(`    <bpmndi:BPMNPlane id="BPMNPlane_${esc(pid)}" bpmnElement="${esc(pid)}">`);
  lanes.forEach((lane, i) => out.push(`      <bpmndi:BPMNShape id="${esc(lane.id)}_di" bpmnElement="${esc(lane.id)}" isHorizontal="true"><dc:Bounds x="${LANE_X}" y="${LANE_Y + i * LANE_H}" width="${laneWidth}" height="${LANE_H}"/></bpmndi:BPMNShape>`));
  for (const node of columns) {
    const p = pos.get(node.id);
    out.push(`      <bpmndi:BPMNShape id="${esc(node.id)}_di" bpmnElement="${esc(node.id)}"><dc:Bounds x="${p.x}" y="${p.y}" width="${p.w}" height="${p.h}"/></bpmndi:BPMNShape>`);
  }
  for (const t of tasks) {
    if (!t.applications.size) continue;
    const p = pos.get(t.id);
    out.push(`      <bpmndi:BPMNShape id="TextAnnotation_${esc(t.id)}_di" bpmnElement="TextAnnotation_${esc(t.id)}"><dc:Bounds x="${p.x}" y="${p.y + p.h + 8}" width="${p.w}" height="24"/></bpmndi:BPMNShape>`);
    out.push(`      <bpmndi:BPMNEdge id="Association_${esc(t.id)}_di" bpmnElement="Association_${esc(t.id)}"><di:waypoint x="${p.x + p.w / 2}" y="${p.y + p.h + 8}"/><di:waypoint x="${p.x + p.w / 2}" y="${p.y + p.h}"/></bpmndi:BPMNEdge>`);
  }
  for (const f of model.flows.values()) {
    const a = pos.get(f.sourceId); const b = pos.get(f.targetId);
    if (!a || !b) continue;
    const x1 = a.x + a.w; const y1 = a.y + a.h / 2; const x2 = b.x; const y2 = b.y + b.h / 2;
    const mid = Math.round((x1 + x2) / 2);
    const points = y1 === y2 ? [[x1, y1], [x2, y2]] : [[x1, y1], [mid, y1], [mid, y2], [x2, y2]];
    out.push(`      <bpmndi:BPMNEdge id="${esc(f.id)}_di" bpmnElement="${esc(f.id)}">${points.map(([x, y]) => `<di:waypoint x="${x}" y="${y}"/>`).join('')}</bpmndi:BPMNEdge>`);
  }
  out.push('    </bpmndi:BPMNPlane>');
  out.push('  </bpmndi:BPMNDiagram>');
  out.push('</bpmn:definitions>');
  return `${out.join('\n')}\n`;
}

module.exports = { anyValue, kvList, spansFromOtlp, normalizeFlat, buildModels, toXml, median };
