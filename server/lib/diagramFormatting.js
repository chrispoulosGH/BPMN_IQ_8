// Ensures a saved diagram matches the same structural/layout conventions the
// load/generation pipeline's buildBpmnXmlForFlow produces (see
// bpmnXmlBuilder.js): at least one lane wrapping the flow, and content
// left-justified starting near the lane's left edge — WITHOUT touching the
// flow's actual logic (tasks, gateways, sequence flows are left completely
// alone; this only adds a lane if one is missing, and translates
// x-coordinates if everything's floating away from the left edge). Runs on
// every diagram save, not just diagrams freshly built from a task list.
const { DOMParser, XMLSerializer } = require('@xmldom/xmldom');

const LANE_X = 60;
const LANE_LABEL_MARGIN = 30;
// Matches bpmnXmlBuilder.js's START_EVENT_X (LANE_X + LANE_LABEL_MARGIN + 10).
const CONTENT_LEFT_X = LANE_X + LANE_LABEL_MARGIN + 10;
const LANE_VERTICAL_PADDING = 20;
const LANE_MIN_WIDTH = 400;
const LANE_RIGHT_PADDING = 60;
// Only shift content if it's meaningfully off the left margin — avoids
// pointless churn on diagrams that are already reasonably positioned (e.g.
// previously reformatted, or produced by the load pipeline itself).
const LEFT_JUSTIFY_THRESHOLD = CONTENT_LEFT_X + 20;

const FLOW_NODE_LOCAL_NAMES = new Set([
  'startEvent', 'endEvent', 'intermediateThrowEvent', 'intermediateCatchEvent', 'boundaryEvent',
  'task', 'userTask', 'serviceTask', 'manualTask', 'scriptTask', 'businessRuleTask', 'sendTask', 'receiveTask',
  'subProcess', 'callActivity',
  'exclusiveGateway', 'parallelGateway', 'inclusiveGateway', 'eventBasedGateway', 'complexGateway',
]);

function localName(node) {
  return node.localName || String(node.nodeName || '').split(':').pop();
}

function firstChildByLocalName(parent, name) {
  if (!parent) return null;
  for (let i = 0; i < parent.childNodes.length; i += 1) {
    const node = parent.childNodes[i];
    if (node.nodeType === 1 && localName(node) === name) return node;
  }
  return null;
}

function childrenByLocalName(parent, name) {
  const out = [];
  if (!parent) return out;
  for (let i = 0; i < parent.childNodes.length; i += 1) {
    const node = parent.childNodes[i];
    if (node.nodeType === 1 && localName(node) === name) out.push(node);
  }
  return out;
}

function allDescendantsByLocalName(root, name) {
  const out = [];
  if (!root) return out;
  const walk = (node) => {
    for (let i = 0; i < node.childNodes.length; i += 1) {
      const child = node.childNodes[i];
      if (child.nodeType !== 1) continue;
      if (localName(child) === name) out.push(child);
      walk(child);
    }
  };
  walk(root);
  return out;
}

function applyGeneratedDiagramFormatting(xml) {
  if (!xml || typeof xml !== 'string') return xml;
  try {
    const doc = new DOMParser({
      onError: (level, msg) => { if (level === 'fatalError') throw new Error(msg); },
    }).parseFromString(xml, 'text/xml');
    const definitions = doc.documentElement;
    if (!definitions) return xml;

    const process = firstChildByLocalName(definitions, 'process');
    const plane = allDescendantsByLocalName(definitions, 'BPMNPlane')[0];
    if (!process || !plane) return xml; // not a shape this transform understands — leave untouched

    const tagPrefix = process.nodeName.includes(':') ? `${process.nodeName.split(':')[0]}:` : '';
    const tag = (name) => `${tagPrefix}${name}`;
    // DI elements (BPMNShape/BPMNEdge/Bounds) live in the diagram-interchange
    // namespace, which is a DIFFERENT prefix than the process/lane elements
    // above (typically bpmndi:, while process elements are bpmn:/bpmn2:).
    const diPrefix = plane.nodeName.includes(':') ? `${plane.nodeName.split(':')[0]}:` : '';
    const diTag = (name) => `${diPrefix}${name}`;

    // Flow node ids directly under the process (not inside a subProcess —
    // those get their own nested laneSet/shapes if ever needed, untouched here).
    const flowNodeIds = [];
    for (let i = 0; i < process.childNodes.length; i += 1) {
      const node = process.childNodes[i];
      if (node.nodeType !== 1) continue;
      if (FLOW_NODE_LOCAL_NAMES.has(localName(node))) {
        const id = node.getAttribute('id');
        if (id) flowNodeIds.push(id);
      }
    }

    const existingLaneSet = firstChildByLocalName(process, 'laneSet');
    const existingLaneIds = new Set(allDescendantsByLocalName(existingLaneSet, 'lane').map((l) => l.getAttribute('id')).filter(Boolean));
    let addedLaneId = null;

    if (!existingLaneSet && flowNodeIds.length) {
      addedLaneId = 'Lane_Unassigned';
      const laneSet = doc.createElement(tag('laneSet'));
      const lane = doc.createElement(tag('lane'));
      lane.setAttribute('id', addedLaneId);
      lane.setAttribute('name', 'Unassigned');
      flowNodeIds.forEach((id) => {
        const ref = doc.createElement(tag('flowNodeRef'));
        ref.appendChild(doc.createTextNode(id));
        lane.appendChild(ref);
      });
      laneSet.appendChild(lane);
      process.insertBefore(laneSet, process.firstChild);
    }

    // Bounding box of everything EXCEPT lane shapes (existing or the one we
    // may have just added) — that's the "content" we might left-justify.
    const laneDiIds = new Set(existingLaneIds);
    if (addedLaneId) laneDiIds.add(addedLaneId);

    const shapeNodes = childrenByLocalName(plane, 'BPMNShape');
    const contentShapes = [];
    shapeNodes.forEach((shape) => {
      const elementId = shape.getAttribute('bpmnElement');
      if (laneDiIds.has(elementId)) return;
      const bounds = firstChildByLocalName(shape, 'Bounds');
      if (!bounds) return;
      const x = parseFloat(bounds.getAttribute('x'));
      const y = parseFloat(bounds.getAttribute('y'));
      const width = parseFloat(bounds.getAttribute('width')) || 0;
      const height = parseFloat(bounds.getAttribute('height')) || 0;
      if (Number.isNaN(x) || Number.isNaN(y)) return;
      contentShapes.push({ bounds, x, y, width, height });
    });

    const hasContent = contentShapes.length > 0;
    const minX = hasContent ? Math.min(...contentShapes.map((s) => s.x)) : null;
    const deltaX = hasContent && minX > LEFT_JUSTIFY_THRESHOLD ? (CONTENT_LEFT_X - minX) : 0;

    if (deltaX !== 0) {
      contentShapes.forEach(({ bounds, x }) => {
        bounds.setAttribute('x', String(Math.round(x + deltaX)));
      });
      childrenByLocalName(plane, 'BPMNEdge').forEach((edge) => {
        allDescendantsByLocalName(edge, 'waypoint').forEach((waypoint) => {
          const wx = parseFloat(waypoint.getAttribute('x'));
          if (!Number.isNaN(wx)) waypoint.setAttribute('x', String(Math.round(wx + deltaX)));
        });
      });
    }

    if (addedLaneId) {
      const contentMinY = hasContent ? Math.min(...contentShapes.map((s) => s.y)) : 60;
      const contentMaxY = hasContent ? Math.max(...contentShapes.map((s) => s.y + s.height)) : 200;
      const contentMaxX = hasContent
        ? Math.max(...contentShapes.map((s) => (deltaX !== 0 ? s.x + deltaX : s.x) + s.width))
        : LANE_X + LANE_MIN_WIDTH;

      const laneShape = doc.createElement(diTag('BPMNShape'));
      laneShape.setAttribute('id', `${addedLaneId}_di`);
      laneShape.setAttribute('bpmnElement', addedLaneId);
      laneShape.setAttribute('isHorizontal', 'true');
      const boundsTag = firstChildByLocalName(shapeNodes[0], 'Bounds')?.nodeName || 'dc:Bounds';
      const laneBounds = doc.createElement(boundsTag);
      laneBounds.setAttribute('x', String(LANE_X));
      laneBounds.setAttribute('y', String(Math.max(Math.round(contentMinY - LANE_VERTICAL_PADDING), 0)));
      laneBounds.setAttribute('width', String(Math.max(Math.round(contentMaxX - LANE_X + LANE_RIGHT_PADDING), LANE_MIN_WIDTH)));
      laneBounds.setAttribute('height', String(Math.round((contentMaxY - contentMinY) + LANE_VERTICAL_PADDING * 2)));
      laneShape.appendChild(laneBounds);
      plane.insertBefore(laneShape, plane.firstChild);
    } else if (deltaX !== 0 && existingLaneIds.size) {
      // Content moved but the lane(s) it lives in already existed — re-anchor
      // and widen each one to the left margin so it still visually contains
      // everything, rather than leaving the shift look clipped.
      const contentMaxX = hasContent
        ? Math.max(...contentShapes.map((s) => s.x + deltaX + s.width))
        : LANE_X + LANE_MIN_WIDTH;
      const targetWidth = Math.max(Math.round(contentMaxX - LANE_X + LANE_RIGHT_PADDING), LANE_MIN_WIDTH);
      shapeNodes.forEach((shape) => {
        if (!existingLaneIds.has(shape.getAttribute('bpmnElement'))) return;
        const bounds = firstChildByLocalName(shape, 'Bounds');
        if (!bounds) return;
        const laneOriginalX = parseFloat(bounds.getAttribute('x'));
        bounds.setAttribute('x', String(LANE_X));
        if (!Number.isNaN(laneOriginalX)) {
          const originalWidth = parseFloat(bounds.getAttribute('width')) || 0;
          bounds.setAttribute('width', String(Math.max(Math.round(originalWidth + (laneOriginalX - LANE_X)), targetWidth)));
        }
      });
    }

    if (!addedLaneId && deltaX === 0) return xml; // nothing changed — avoid needless re-serialization

    return new XMLSerializer().serializeToString(doc);
  } catch (err) {
    console.error('[DIAGRAM FORMAT] Failed to reformat diagram, saving as-is:', err && err.message);
    return xml;
  }
}

module.exports = { applyGeneratedDiagramFormatting };
