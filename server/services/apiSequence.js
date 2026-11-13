/**
 * Builds the API sequence for one business-flow diagram: the API calls the
 * flow makes, in process order.
 *
 * - Order comes from the diagram's BPMN sequence flows: back edges (loops) are
 *   dropped, then nodes are topologically sorted, ties broken left-to-right by
 *   the shape's x position on the canvas.
 * - Each task is joined to its API by the "Flow — Task API" naming convention
 *   (normalized flow + task name).
 * - A diverging gateway becomes a fragment: `par` for a parallel gateway, `alt`
 *   for an exclusive/inclusive/event-based one with 2+ non-empty branches, and
 *   `opt` when only one branch has tasks. Branches run until the next join.
 *   Nested splits are not nested in the output — their tasks stay in the
 *   enclosing branch, in order.
 * - Call direction follows the data, as each API records it ("from X to Y"):
 *   provider → consumer. In these flows the consumer of one step is usually
 *   the provider of the next, so the arrows read as one hand-off chain.
 */

const normalizeKey = (value) => String(value ?? '')
  .replace(/&amp;/g, '&')
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, ' ')
  .trim();

const decodeXml = (value) => String(value ?? '')
  .replace(/&#10;|&#xA;/gi, ' ')
  .replace(/&lt;/g, '<')
  .replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"')
  .replace(/&apos;/g, "'")
  .replace(/&amp;/g, '&')
  .replace(/\s+/g, ' ')
  .trim();

const attr = (attrs, name) => {
  const match = String(attrs || '').match(new RegExp(`\\b${name}="([^"]*)"`, 'i'));
  return match ? match[1] : '';
};

const TASK_TYPE = /^(task|userTask|serviceTask|sendTask|receiveTask|manualTask|businessRuleTask|scriptTask|callActivity|subProcess)$/i;
const GATEWAY_TYPE = /Gateway$/i;
const EVENT_TYPE = /Event$/i;

function parseBpmn(xml) {
  const nodes = new Map(); // id -> { id, name, type, kind, x, y }
  const elementRegex = /<bpmn2?:(\w+)\b([^>]*?)\/?>/gi;
  let m;
  while ((m = elementRegex.exec(xml)) !== null) {
    const [, type, attrs] = m;
    const kind = TASK_TYPE.test(type) ? 'task' : GATEWAY_TYPE.test(type) ? 'gateway' : EVENT_TYPE.test(type) && !/Definition$/i.test(type) ? 'event' : null;
    if (!kind) continue;
    const id = attr(attrs, 'id');
    if (!id || nodes.has(id)) continue;
    nodes.set(id, { id, name: decodeXml(attr(attrs, 'name')), type, kind, x: Number.POSITIVE_INFINITY, y: Number.POSITIVE_INFINITY });
  }

  const flows = [];
  const flowRegex = /<bpmn2?:sequenceFlow\b([^>]*?)\/?>/gi;
  while ((m = flowRegex.exec(xml)) !== null) {
    const source = attr(m[1], 'sourceRef');
    const target = attr(m[1], 'targetRef');
    if (nodes.has(source) && nodes.has(target)) flows.push({ id: attr(m[1], 'id'), source, target, name: decodeXml(attr(m[1], 'name')) });
  }

  const shapeRegex = /<bpmndi:BPMNShape\b([^>]*)>[\s\S]*?<dc:Bounds\b([^>]*)\/?>/gi;
  while ((m = shapeRegex.exec(xml)) !== null) {
    const node = nodes.get(attr(m[1], 'bpmnElement'));
    if (!node) continue;
    node.x = Number(attr(m[2], 'x')) || 0;
    node.y = Number(attr(m[2], 'y')) || 0;
  }

  const laneByNode = new Map();
  const laneRegex = /<bpmn2?:lane\b([^>]*)>([\s\S]*?)<\/bpmn2?:lane>/gi;
  while ((m = laneRegex.exec(xml)) !== null) {
    const laneName = decodeXml(attr(m[1], 'name'));
    const refRegex = /<bpmn2?:flowNodeRef>([^<]+)<\/bpmn2?:flowNodeRef>/gi;
    let r;
    while ((r = refRegex.exec(m[2])) !== null) laneByNode.set(r[1].trim(), laneName);
  }

  return { nodes, flows, laneByNode };
}

const byPosition = (a, b) => (a.x - b.x) || (a.y - b.y) || a.id.localeCompare(b.id);

/** Drop loop-back edges and topologically order the nodes. */
function orderNodes(nodes, flows) {
  const outgoing = new Map([...nodes.keys()].map((id) => [id, []]));
  for (const flow of flows) outgoing.get(flow.source).push(flow);

  const hasIncoming = new Set(flows.map((f) => f.target));
  const roots = [...nodes.values()]
    .filter((n) => !hasIncoming.has(n.id))
    .sort((a, b) => ((a.type === 'startEvent' ? 0 : 1) - (b.type === 'startEvent' ? 0 : 1)) || byPosition(a, b));
  const remaining = [...nodes.values()].sort(byPosition);

  // Iterative DFS to find back edges (an edge into a node still on the stack).
  const state = new Map(); // id -> 1 visiting, 2 done
  const backEdges = new Set();
  for (const start of [...roots, ...remaining]) {
    if (state.has(start.id)) continue;
    const stack = [{ id: start.id, i: 0 }];
    state.set(start.id, 1);
    while (stack.length) {
      const frame = stack[stack.length - 1];
      const edges = outgoing.get(frame.id);
      if (frame.i >= edges.length) {
        state.set(frame.id, 2);
        stack.pop();
        continue;
      }
      const edge = edges[frame.i++];
      const s = state.get(edge.target);
      if (s === 1) backEdges.add(edge);
      else if (!s) {
        state.set(edge.target, 1);
        stack.push({ id: edge.target, i: 0 });
      }
    }
  }

  const forward = flows.filter((f) => !backEdges.has(f));
  const fwdOut = new Map([...nodes.keys()].map((id) => [id, []]));
  const inDegree = new Map([...nodes.keys()].map((id) => [id, 0]));
  for (const flow of forward) {
    fwdOut.get(flow.source).push(flow);
    inDegree.set(flow.target, inDegree.get(flow.target) + 1);
  }

  // Kahn's algorithm; the ready set is kept sorted by canvas position.
  const ready = [...nodes.values()].filter((n) => inDegree.get(n.id) === 0).sort(byPosition);
  const order = [];
  while (ready.length) {
    const node = ready.shift();
    order.push(node.id);
    for (const flow of fwdOut.get(node.id)) {
      inDegree.set(flow.target, inDegree.get(flow.target) - 1);
      if (inDegree.get(flow.target) === 0) {
        ready.push(nodes.get(flow.target));
        ready.sort(byPosition);
      }
    }
  }
  return { order, forward, fwdOut, inDegreeOf: (id) => forward.filter((f) => f.target === id).length };
}

/** Assign each task under a diverging gateway to that gateway's branch. */
function findFragments(nodes, fwdOut, inDegreeOf, order) {
  const fragmentByTask = new Map(); // taskId -> { gatewayId, branch }
  const fragments = new Map(); // gatewayId -> { gateway, branches: [{ label, taskIds }] }

  for (const id of order) {
    const node = nodes.get(id);
    if (node.kind !== 'gateway') continue;
    const edges = fwdOut.get(id);
    if (edges.length < 2) continue;

    const branches = edges.map((edge, i) => {
      const target = nodes.get(edge.target);
      const taskIds = [];
      const seen = new Set();
      const queue = [edge.target];
      while (queue.length) {
        const current = queue.shift();
        if (seen.has(current)) continue;
        seen.add(current);
        const n = nodes.get(current);
        if (inDegreeOf(current) > 1) continue; // reached a join
        // A nested split is walked through, so its tasks stay in this branch.
        if (n.kind === 'task' && !fragmentByTask.has(current)) taskIds.push(current);
        for (const next of fwdOut.get(current)) queue.push(next.target);
      }
      const label = edge.name || (target.kind !== 'task' ? target.name : '') || `Branch ${i + 1}`;
      return { label, taskIds };
    });

    const nonEmpty = branches.filter((b) => b.taskIds.length);
    if (!nonEmpty.length) continue;
    nonEmpty.forEach((branch, branchIndex) => {
      for (const taskId of branch.taskIds) fragmentByTask.set(taskId, { gatewayId: id, branch: branchIndex });
    });
    const isParallel = /parallel/i.test(node.type);
    fragments.set(id, {
      gatewayId: id,
      type: isParallel ? 'par' : nonEmpty.length === 1 ? 'opt' : 'alt',
      gatewayType: node.type,
      label: node.name || (isParallel ? 'In parallel' : 'Decision'),
      branches: nonEmpty,
    });
  }
  return { fragmentByTask, fragments };
}

function buildApiSequence(diagram, { apiIndex, apps, dataObjects, hosts }) {
  const flowName = diagram.businessFlow || diagram.name || '';
  const flowKeys = [...new Set([normalizeKey(flowName), normalizeKey(diagram.name)])].filter(Boolean);
  const appsById = new Map((apps || []).map((app) => [app.id, app]));

  const { nodes, flows, laneByNode } = parseBpmn(diagram.xml || '');
  const { order, fwdOut, inDegreeOf } = orderNodes(nodes, flows);
  const { fragmentByTask, fragments } = findFragments(nodes, fwdOut, inDegreeOf, order);
  const taskOrder = order.filter((id) => nodes.get(id).kind === 'task');
  const rank = new Map(taskOrder.map((id, i) => [id, i]));

  const participants = [];
  const participantIds = new Set();
  const addParticipant = (appId) => {
    const id = appId || 'UNASSIGNED';
    if (participantIds.has(id)) return id;
    participantIds.add(id);
    const app = appsById.get(id);
    participants.push(app
      ? { id, acronym: app.acronym, name: app.name, domain: app.domain, criticality: app.criticality }
      : { id, acronym: id === 'UNASSIGNED' ? 'Unassigned' : id, name: id === 'UNASSIGNED' ? 'No provider application recorded' : '', domain: '', criticality: '', unassigned: id === 'UNASSIGNED' });
    return id;
  };

  const usedObjects = new Set();
  const usedHosts = new Set();
  let callNumber = 0;
  let tasksWithoutApi = 0;

  const makeStep = (taskId) => {
    const node = nodes.get(taskId);
    let apis = [];
    for (const key of flowKeys) {
      apis = apiIndex.get(`${key}|${normalizeKey(node.name)}`) || [];
      if (apis.length) break;
    }
    if (!apis.length) tasksWithoutApi += 1;
    const calls = apis.map((api) => {
      const from = addParticipant(api.provider);
      const to = addParticipant(api.consumer || api.provider);
      for (const objectId of [api.requestObject, api.responseObject]) if (objectId) usedObjects.add(objectId);
      if (api.host) usedHosts.add(api.host);
      callNumber += 1;
      return { ...api, number: callNumber, from, to, internal: from === to };
    });
    return { taskId, taskName: node.name, taskType: node.type, lane: laneByNode.get(taskId) || '', calls };
  };

  const items = [];
  const emitted = new Set();
  for (const taskId of taskOrder) {
    if (emitted.has(taskId)) continue;
    const membership = fragmentByTask.get(taskId);
    if (!membership) {
      emitted.add(taskId);
      items.push({ kind: 'step', step: makeStep(taskId) });
      continue;
    }
    const fragment = fragments.get(membership.gatewayId);
    items.push({
      kind: 'fragment',
      fragment: {
        type: fragment.type,
        gatewayType: fragment.gatewayType,
        label: fragment.label,
        branches: fragment.branches.map((branch) => ({
          label: branch.label,
          steps: [...branch.taskIds].sort((a, b) => rank.get(a) - rank.get(b)).map((id) => {
            emitted.add(id);
            return makeStep(id);
          }),
        })),
      },
    });
  }

  const pick = (source, ids) => Object.fromEntries([...ids].filter((id) => source?.[id]).map((id) => [id, source[id]]));
  const lanes = [...new Set(taskOrder.map((id) => laneByNode.get(id)).filter(Boolean))];

  return {
    diagramId: String(diagram._id),
    diagramName: diagram.name,
    businessFlow: flowName,
    domain: diagram.domain || '',
    subdomain: diagram.subdomain || '',
    lanes,
    participants,
    items,
    callCount: callNumber,
    taskCount: taskOrder.length,
    tasksWithoutApi,
    fragmentCount: fragments.size,
    dataObjects: pick(dataObjects, usedObjects),
    hosts: pick(hosts, usedHosts),
    directionNote: 'Arrows follow the data, from each API\'s provider application to its consumer, as recorded on the API. Calls are in the order of the diagram\'s sequence flows; loop-backs are omitted.',
    dataObjectNote: 'Request/response objects are generated (illustrative), not sourced from API specs. Host servers are derived.',
  };
}

module.exports = { buildApiSequence, normalizeKey, parseBpmn, orderNodes };
