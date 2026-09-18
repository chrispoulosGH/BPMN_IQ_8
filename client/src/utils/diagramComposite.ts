import type { Diagram } from '../types';
import { EMPTY_DIAGRAM } from '../components/BpmnEditor';

// Shared by the Diagrams tab (App.tsx) and Process Change Radar
// (ProcessChangeRadar.tsx) — both stack more than one diagram's XML onto a
// single bpmn-js canvas and need the same id-namespacing/vertical-offset/
// title-banner bookkeeping to do it without id collisions or overlap.

export interface CompositeDiagramItem {
  diagram: Diagram;
  xml: string;
}

// One entry per diagram stacked onto the composite canvas — used to render a
// canvas-anchored title banner over each section (see CompositeSectionTitle
// prop on BpmnEditor) instead of baking the title into the section's XML.
export interface CompositeSectionTitle {
  prefix: string; // '' for the first (unprefixed) section, else 'stack_<index>'
  name: string;
  breadcrumb?: string;
  // The section's underlying Diagram document id — lets BpmnEditor's sticky
  // notes and impact indicators (and the "click a title to select its
  // diagram" behavior) target the right diagram even when several are
  // stacked on one composite canvas.
  diagramId?: string;
}

// Vertical gap (model-space units, same convention as lane height/task width
// elsewhere) inserted above each stacked diagram after the first. Chosen so
// that, at a typical 1:1 fit-viewport scale, the next diagram's title box
// (a ~65px-tall floating overlay, offset TITLE_SCREEN_GAP_PX above its own
// first lane — see BpmnEditor.tsx) lands ~100 screen px below the previous
// diagram's bottom lane edge (halved from an original ~200px target):
// STACK_GAP + TOP_Y(60) - TITLE_SCREEN_GAP_PX(10) - titleBoxHeight(~65) ≈ 100.
// This is an approximation, not an exact runtime measurement, so it drifts
// from 100px at other zoom levels or with unusually tall titles.
const STACK_GAP = 115;

function buildDiagramBreadcrumb(diagram: CompositeDiagramItem['diagram']): string | undefined {
  const parts = [
    diagram.lineOfBusiness,
    diagram.channel,
    diagram.product,
    diagram.domain,
    diagram.subdomain,
    diagram.businessFlow,
  ].filter(Boolean);
  return parts.length > 1 ? parts.join(' | ') : undefined;
}

function parseXmlDocument(xml: string) {
  return new DOMParser().parseFromString(xml, 'application/xml');
}

function serializeXmlDocument(doc: Document) {
  return new XMLSerializer().serializeToString(doc);
}

function namespaceDiagramXml(xml: string, prefix: string) {
  const doc = parseXmlDocument(xml);
  const idMap = new Map<string, string>();

  const elementsWithId = Array.from(doc.querySelectorAll('[id]'));
  elementsWithId.forEach((element) => {
    const oldId = element.getAttribute('id');
    if (!oldId) return;
    const nextId = `${prefix}_${oldId}`;
    idMap.set(oldId, nextId);
    element.setAttribute('id', nextId);
  });

  const referenceAttributes = ['bpmnElement', 'sourceRef', 'targetRef', 'attachedToRef', 'messageRef', 'structureRef', 'flowNodeRef'];
  Array.from(doc.querySelectorAll('*')).forEach((element) => {
    referenceAttributes.forEach((attr) => {
      const value = element.getAttribute(attr);
      if (!value) return;
      const nextValue = idMap.get(value);
      if (nextValue) {
        element.setAttribute(attr, nextValue);
      }
    });

    Array.from(element.attributes).forEach((attr) => {
      if (!attr.value || !idMap.has(attr.value)) return;
      if (referenceAttributes.includes(attr.name)) return;
      element.setAttribute(attr.name, idMap.get(attr.value) || attr.value);
    });
  });

  const textRefTags = ['flowNodeRef'];
  textRefTags.forEach((tagName) => {
    Array.from(doc.getElementsByTagName(tagName)).forEach((node) => {
      const value = node.textContent?.trim();
      if (!value) return;
      const nextValue = idMap.get(value);
      if (nextValue) node.textContent = nextValue;
    });
  });

  return serializeXmlDocument(doc);
}

function shiftDiagramXml(xml: string, offsetY: number, diagramIndex: number) {
  const doc = parseXmlDocument(xml);
  const shapes = Array.from(doc.getElementsByTagName('bpmndi:BPMNShape'));
  shapes.forEach((shape) => {
    const bounds = shape.getElementsByTagName('dc:Bounds')[0];
    if (!bounds) return;
    const y = Number(bounds.getAttribute('y') || '0');
    bounds.setAttribute('y', String(y + offsetY));
  });

  const edges = Array.from(doc.getElementsByTagName('bpmndi:BPMNEdge'));
  edges.forEach((edge) => {
    const waypoints = Array.from(edge.getElementsByTagName('di:waypoint'));
    waypoints.forEach((waypoint) => {
      const y = Number(waypoint.getAttribute('y') || '0');
      waypoint.setAttribute('y', String(y + offsetY));
    });
  });

  const annotationNode = doc.getElementsByTagName('bpmndi:BPMNDiagram')[0];
  if (annotationNode && !annotationNode.getAttribute('id')) {
    annotationNode.setAttribute('id', `BPMNDiagram_stack_${diagramIndex}`);
  }

  return serializeXmlDocument(doc);
}

// Stacks multiple diagrams' XML onto one canvas. Each section used to get its
// title baked in as a floating bpmn:textAnnotation (BPMNDiagramTitle_<index>);
// titles are now rendered as canvas-anchored HTML overlays in BpmnEditor.tsx
// instead (see the `sections` return value and BpmnEditor's sectionTitles
// prop), keyed by the same id prefix namespaceDiagramXml applies per section.
export function composeStackedDiagramXml(items: CompositeDiagramItem[]): { xml: string; sections: CompositeSectionTitle[] | null } {
  if (!items.length) return { xml: EMPTY_DIAGRAM, sections: null };
  if (items.length === 1) return { xml: items[0].xml, sections: null };

  const baseDoc = parseXmlDocument(items[0].xml);
  const definitions = baseDoc.getElementsByTagName('bpmn:definitions')[0] || baseDoc.documentElement;
  const process = baseDoc.getElementsByTagName('bpmn:process')[0];
  const plane = baseDoc.getElementsByTagName('bpmndi:BPMNPlane')[0];
  if (!definitions || !process || !plane) return { xml: items[0].xml, sections: null };

  const importFragment = (fragmentXml: string) => {
    const fragmentDoc = parseXmlDocument(fragmentXml);
    const fragmentProcess = fragmentDoc.getElementsByTagName('bpmn:process')[0];
    const fragmentPlane = fragmentDoc.getElementsByTagName('bpmndi:BPMNPlane')[0];
    if (!fragmentProcess || !fragmentPlane) return;

    Array.from(fragmentProcess.children).forEach((node) => {
      process.appendChild(baseDoc.importNode(node, true));
    });
    Array.from(fragmentPlane.children).forEach((node) => {
      plane.appendChild(baseDoc.importNode(node, true));
    });
  };

  const sections: CompositeSectionTitle[] = [];
  let offsetY = 0;
  items.forEach((item, index) => {
    const namespaced = index === 0 ? item.xml : namespaceDiagramXml(item.xml, `stack_${index}`);
    const shifted = index === 0 ? namespaced : shiftDiagramXml(namespaced, offsetY, index);
    importFragment(shifted);
    sections.push({
      prefix: index === 0 ? '' : `stack_${index}`,
      name: item.diagram.businessFlow || item.diagram.name || 'Untitled',
      breadcrumb: buildDiagramBreadcrumb(item.diagram),
      diagramId: item.diagram._id,
    });
    const doc = parseXmlDocument(shifted);
    const bounds = Array.from(doc.getElementsByTagName('dc:Bounds'))
      .map((node) => Number(node.getAttribute('y') || '0') + Number(node.getAttribute('height') || '0'));
    const maxY = bounds.length ? Math.max(...bounds) : 0;
    offsetY = maxY + STACK_GAP;
  });

  return { xml: serializeXmlDocument(baseDoc), sections };
}
