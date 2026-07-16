// Builds a complete BPMN 2.0 XML document (process + diagram interchange) for a single
// Business Process Flow, from an ordered list of tasks (each with an actor and a list of
// application names). Structure mirrors data/TechFast_BPMN2.0_di.xml: one bpmn:lane per
// actor, tasks in a straight sequence, and a bpmn:textAnnotation + bpmn:association per
// task listing its applications (BpmnEditor.tsx auto-migrates this into bpmniq:TaskApplications
// extension elements on load).

const LANE_X = 60;
const LANE_HEIGHT = 140;
const LANE_LABEL_MARGIN = 30;
const TASK_WIDTH = 100;
const TASK_HEIGHT = 80;
const EVENT_SIZE = 36;
const START_X = 220;
const STEP_X = 180;
const TOP_Y = 60;
const TITLE_WIDTH_MIN = 360;
const TITLE_WIDTH_MAX = 560;
const TITLE_HEIGHT = 42;
const APP_COLUMN_WIDTH = 160;
const APP_COLUMN_GAP = 24;
const APP_ROW_HEIGHT = 18;
const APP_BOX_PADDING_Y = 10;
const APP_GAP_FROM_TASK = 20;

function escapeXml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function toId(prefix, name, usedIds) {
  const base = String(name || '')
    .trim()
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '') || 'Item';
  let candidate = `${prefix}_${base}`;
  let counter = 2;
  while (usedIds.has(candidate)) {
    candidate = `${prefix}_${base}_${counter}`;
    counter += 1;
  }
  usedIds.add(candidate);
  return candidate;
}

const KNOWN_TASK_TYPES = new Set(['task', 'userTask', 'serviceTask', 'manualTask', 'scriptTask', 'businessRuleTask', 'sendTask', 'receiveTask']);

function normalizeTaskType(bpmnType) {
  const trimmed = String(bpmnType || '').trim();
  return KNOWN_TASK_TYPES.has(trimmed) ? trimmed : 'task';
}

function splitIntoColumns(items) {
  const midpoint = Math.ceil(items.length / 2);
  return [items.slice(0, midpoint), items.slice(midpoint)];
}

/**
 * @param {Object} params
 * @param {string} params.flowName - Business Process Flow name.
 * @param {string} [params.breadcrumb] - e.g. "Domain: X | Subdomain: Y | Business Capability: Z | Business Flow: FlowName"
 * @param {Array<{ name: string, bpmnType?: string, actor?: string, applications?: string[] }>} params.tasks - ordered tasks.
 * @returns {{ xml: string, definitionsId: string, processId: string }}
 */
function buildBpmnXmlForFlow({ flowName, breadcrumb, tasks }) {
  const usedIds = new Set();
  const definitionsId = toId('Definitions', flowName, usedIds);
  const processId = toId('Process', flowName, usedIds);

  const safeTasks = (tasks || []).filter((t) => t && String(t.name || '').trim());
  const laneOrder = [];
  const laneIdByActor = new Map();
  for (const task of safeTasks) {
    const actor = String(task.actor || '').trim() || 'Unassigned';
    if (!laneIdByActor.has(actor)) {
      const laneId = toId('Lane', actor, usedIds);
      laneIdByActor.set(actor, laneId);
      laneOrder.push({ actor, laneId });
    }
  }
  if (!laneOrder.length) {
    laneOrder.push({ actor: 'Unassigned', laneId: toId('Lane', 'Unassigned', usedIds) });
    laneIdByActor.set('Unassigned', laneOrder[0].laneId);
  }
  const laneIndexById = new Map(laneOrder.map((l, i) => [l.laneId, i]));

  const startEventId = toId('StartEvent', '1', usedIds);
  const endEventId = toId('EndEvent', '1', usedIds);

  const taskNodes = safeTasks.map((task) => {
    const actor = String(task.actor || '').trim() || 'Unassigned';
    const laneId = laneIdByActor.get(actor);
    const applications = Array.isArray(task.applications)
      ? task.applications.map((a) => String(a || '').trim()).filter(Boolean)
      : [];
    return {
      id: toId('Task', task.name, usedIds),
      name: String(task.name).trim(),
      bpmnType: normalizeTaskType(task.bpmnType),
      laneId,
      applications,
    };
  });

  const firstLaneId = taskNodes.length ? taskNodes[0].laneId : laneOrder[0].laneId;
  const lastLaneId = taskNodes.length ? taskNodes[taskNodes.length - 1].laneId : laneOrder[0].laneId;

  // ── laneSet flowNodeRefs ──────────────────────────────────────────────
  const flowNodeRefsByLane = new Map(laneOrder.map((l) => [l.laneId, []]));
  flowNodeRefsByLane.get(firstLaneId).push(startEventId);
  taskNodes.forEach((t) => flowNodeRefsByLane.get(t.laneId).push(t.id));
  flowNodeRefsByLane.get(lastLaneId).push(endEventId);

  const laneSetXml = laneOrder.map(({ actor, laneId }) => {
    const refs = (flowNodeRefsByLane.get(laneId) || []).map((ref) => `        <bpmn:flowNodeRef>${escapeXml(ref)}</bpmn:flowNodeRef>`).join('\n');
    return `      <bpmn:lane id="${laneId}" name="${escapeXml(actor)}">\n${refs}\n      </bpmn:lane>`;
  }).join('\n');

  // ── flow node + sequence flow declarations ────────────────────────────
  const flowIds = [];
  const sequenceFlows = [];
  let prevId = startEventId;
  taskNodes.forEach((t) => {
    const flowId = toId('Flow', String(flowIds.length + 1), usedIds);
    flowIds.push(flowId);
    sequenceFlows.push({ id: flowId, sourceRef: prevId, targetRef: t.id });
    prevId = t.id;
  });
  const finalFlowId = toId('Flow', String(flowIds.length + 1), usedIds);
  sequenceFlows.push({ id: finalFlowId, sourceRef: prevId, targetRef: endEventId });

  const flowNodesXml = [
    `    <bpmn:startEvent id="${startEventId}" name="Start"/>`,
    ...taskNodes.map((t) => `    <bpmn:${t.bpmnType} id="${t.id}" name="${escapeXml(t.name)}"/>`),
    `    <bpmn:endEvent id="${endEventId}" name="End"/>`,
  ].join('\n');

  const sequenceFlowsXml = sequenceFlows
    .map((f) => `    <bpmn:sequenceFlow id="${f.id}" sourceRef="${f.sourceRef}" targetRef="${f.targetRef}"/>`)
    .join('\n');

  // ── layout / DI ─────────────────────────────────────────────────────
  const diagramWidth = START_X + Math.max(taskNodes.length, 1) * STEP_X + 300;
  const laneY = (laneId) => TOP_Y + laneIndexById.get(laneId) * LANE_HEIGHT;
  const laneCenterY = (laneId) => laneY(laneId) + LANE_HEIGHT / 2;

  const positions = new Map(); // id -> { x, y, width, height }
  positions.set(startEventId, {
    x: START_X - STEP_X + (TASK_WIDTH - EVENT_SIZE) / 2,
    y: laneCenterY(firstLaneId) - EVENT_SIZE / 2,
    width: EVENT_SIZE,
    height: EVENT_SIZE,
  });
  taskNodes.forEach((t, i) => {
    positions.set(t.id, {
      x: START_X + i * STEP_X,
      y: laneCenterY(t.laneId) - TASK_HEIGHT / 2,
      width: TASK_WIDTH,
      height: TASK_HEIGHT,
    });
  });
  positions.set(endEventId, {
    x: START_X + taskNodes.length * STEP_X + (TASK_WIDTH - EVENT_SIZE) / 2,
    y: laneCenterY(lastLaneId) - EVENT_SIZE / 2,
    width: EVENT_SIZE,
    height: EVENT_SIZE,
  });

  // ── text annotations (application lists per task) ─────────────────────
  const annotations = [];
  taskNodes.forEach((t) => {
    if (!t.applications.length) return;
    const [leftColumn, rightColumn] = splitIntoColumns(t.applications);
    const columns = rightColumn.length ? [leftColumn, rightColumn] : [leftColumn];
    const taskPos = positions.get(t.id);
    const combinedWidth = columns.length === 2 ? (APP_COLUMN_WIDTH * 2) + APP_COLUMN_GAP : APP_COLUMN_WIDTH;
    const startX = Math.round(taskPos.x + (taskPos.width / 2) - (combinedWidth / 2));
    const annotationY = taskPos.y + TASK_HEIGHT + APP_GAP_FROM_TASK;

    columns.forEach((column, index) => {
      if (!column.length) return;
      const annotationId = toId('TextAnnotation', `${t.name}_column_${index + 1}`, usedIds);
      const associationId = toId('Association', `${t.name}_column_${index + 1}`, usedIds);
      annotations.push({
        id: annotationId,
        associationId,
        text: column.join('\n'),
        targetId: t.id,
        x: startX + index * (APP_COLUMN_WIDTH + APP_COLUMN_GAP),
        y: annotationY,
        width: APP_COLUMN_WIDTH,
        height: (Math.max(column.length, 1) * APP_ROW_HEIGHT) + (APP_BOX_PADDING_Y * 2),
      });
    });
  });

  const annotationsXml = [
    ...annotations.map((a) => (
      `    <bpmn:textAnnotation id="${a.id}">\n      <bpmn:text>${escapeXml(a.text)}</bpmn:text>\n    </bpmn:textAnnotation>\n` +
      `    <bpmn:association id="${a.associationId}" sourceRef="${a.id}" targetRef="${a.targetId}"/>`
    )),
  ].join('\n');

  const laneShapesXml = laneOrder.map(({ laneId }) => (
    `      <bpmndi:BPMNShape id="${laneId}_di" bpmnElement="${laneId}" isHorizontal="true" stroke="gray">\n` +
    `        <dc:Bounds x="${LANE_X}" y="${laneY(laneId)}" width="${diagramWidth}" height="${LANE_HEIGHT}"/>\n` +
    `      </bpmndi:BPMNShape>`
  )).join('\n');

  const flowNodeShapesXml = [startEventId, ...taskNodes.map((t) => t.id), endEventId].map((id) => {
    const p = positions.get(id);
    return (
      `      <bpmndi:BPMNShape id="${id}_di" bpmnElement="${id}" stroke="blue">\n` +
      `        <dc:Bounds x="${p.x}" y="${p.y}" width="${p.width}" height="${p.height}"/>\n` +
      `      </bpmndi:BPMNShape>`
    );
  }).join('\n');

  const centerOf = (p) => ({ x: p.x + p.width / 2, y: p.y + p.height / 2 });
  const rightOf = (p) => ({ x: p.x + p.width, y: p.y + p.height / 2 });
  const leftOf = (p) => ({ x: p.x, y: p.y + p.height / 2 });

  const sequenceFlowEdgesXml = sequenceFlows.map((f) => {
    const src = positions.get(f.sourceRef);
    const tgt = positions.get(f.targetRef);
    const a = rightOf(src);
    const b = leftOf(tgt);
    let waypoints;
    if (Math.round(a.y) === Math.round(b.y)) {
      waypoints = [a, b];
    } else {
      const midX = (a.x + b.x) / 2;
      waypoints = [a, { x: midX, y: a.y }, { x: midX, y: b.y }, b];
    }
    const points = waypoints.map((w) => `<di:waypoint x="${Math.round(w.x)}" y="${Math.round(w.y)}"/>`).join('\n          ');
    return (
      `      <bpmndi:BPMNEdge id="${f.id}_di" bpmnElement="${f.id}">\n` +
      `          ${points}\n` +
      `      </bpmndi:BPMNEdge>`
    );
  }).join('\n');

  const annotationShapesAndEdges = [
    ...annotations.map((a) => {
      const taskPos = positions.get(a.targetId);
      const annoPos = { x: a.x, y: a.y, width: a.width, height: a.height };
      positions.set(a.id, annoPos);
      const from = { x: annoPos.x + annoPos.width / 2, y: annoPos.y };
      const to = { x: taskPos.x + taskPos.width / 2, y: taskPos.y + taskPos.height };
      return (
        `      <bpmndi:BPMNShape id="${a.id}_di" bpmnElement="${a.id}">\n` +
        `        <dc:Bounds x="${annoPos.x}" y="${annoPos.y}" width="${annoPos.width}" height="${annoPos.height}"/>\n` +
        `      </bpmndi:BPMNShape>\n` +
        `      <bpmndi:BPMNEdge id="${a.associationId}_di" bpmnElement="${a.associationId}">\n` +
        `          <di:waypoint x="${Math.round(from.x)}" y="${Math.round(from.y)}"/>\n` +
        `          <di:waypoint x="${Math.round(to.x)}" y="${Math.round(to.y)}"/>\n` +
        `      </bpmndi:BPMNEdge>`
      );
    }),
  ].join('\n');

  const diagramName = breadcrumb || `Business Flow: ${flowName}`;

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:bpmndi="http://www.omg.org/spec/BPMN/20100524/DI" xmlns:dc="http://www.omg.org/spec/DD/20100524/DC" xmlns:di="http://www.omg.org/spec/DD/20100524/DI" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" id="${definitionsId}" targetNamespace="http://bpmn.io/schema/bpmn">
  <bpmn:process id="${processId}" isExecutable="false">
    <bpmn:laneSet>
${laneSetXml}
    </bpmn:laneSet>
${flowNodesXml}
${sequenceFlowsXml}
${annotationsXml}
  </bpmn:process>
  <bpmndi:BPMNDiagram id="BPMNDiagram_${processId}" name="${escapeXml(diagramName)}">
    <bpmndi:BPMNPlane id="BPMNPlane_${processId}" bpmnElement="${processId}">
${laneShapesXml}
${flowNodeShapesXml}
${sequenceFlowEdgesXml}
${annotationShapesAndEdges}
    </bpmndi:BPMNPlane>
  </bpmndi:BPMNDiagram>
</bpmn:definitions>
`;

  return { xml, definitionsId, processId };
}

module.exports = { buildBpmnXmlForFlow, escapeXml };
