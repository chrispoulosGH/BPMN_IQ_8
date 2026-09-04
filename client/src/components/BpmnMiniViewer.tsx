import { useEffect, useRef } from 'react';
import BpmnViewer from 'bpmn-js/lib/NavigatedViewer';
import bpmniqModdle from '../bpmniq-moddle.json';

interface BpmnMiniViewerProps {
  xml: string | null;
  diagramName?: string | null;
}

const COMPUTER_ICON = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="14" rx="2" ry="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>`;

/** Returns true for Task, UserTask, ServiceTask, SubProcess, CallActivity, etc. */
function isActivityType(type?: string): boolean {
  if (!type) return false;
  return type.includes('Task') || type.includes('SubProcess') || type.includes('CallActivity');
}

function splitStoredApplicationNames(value: string): string[] {
  return String(value || '')
    .split(/[\r\n,;]+/)
    .map((part) => part.trim())
    .filter(Boolean);
}

/** Read app names from a task's extensionElements (same shape BpmnEditor writes). */
function getTaskApps(bo: any): string[] {
  const exts = bo.extensionElements?.values || [];
  const container = exts.find((e: any) => e.$type === 'bpmniq:TaskApplications');
  if (!container) return [];
  return (container.applications || [])
    .flatMap((a: any) => splitStoredApplicationNames(String(a.name || a.correlationId || '')))
    .filter(Boolean);
}

/**
 * Renders the same "computer icon + application name" tags under each
 * task/sub-process that BpmnEditor.tsx's renderAppOverlays draws on the full
 * Diagrams canvas — display-only here (no click handlers, no "+" add
 * button, no validity coloring), just enough to match that look in a small
 * embedded frame. Also honors the legacy text-annotation fallback so older
 * diagrams that never got migrated to extensionElements still show their
 * applications.
 */
function renderAppOverlays(viewer: any) {
  const overlays = viewer.get('overlays');
  const elementRegistry = viewer.get('elementRegistry');
  const canvas = viewer.get('canvas');

  const annotationAppMap = new Map<string, string[]>();
  const parsedAnnotationIds = new Set<string>();
  const parsedAssociationIds = new Set<string>();
  const allElements = elementRegistry.getAll();
  for (const el of allElements) {
    const bo = el.businessObject;
    if (bo?.$type === 'bpmn:Association' || bo?.$type === 'bpmn2:Association') {
      const srcRef = bo.sourceRef;
      const tgtRef = bo.targetRef;
      if (!srcRef || !tgtRef) continue;
      const annBo = srcRef.$type?.includes('TextAnnotation') ? srcRef : tgtRef.$type?.includes('TextAnnotation') ? tgtRef : null;
      const taskBo = srcRef.$type?.includes('TextAnnotation') ? tgtRef : tgtRef.$type?.includes('TextAnnotation') ? srcRef : null;
      if (!annBo || !taskBo || !isActivityType(taskBo.$type)) continue;
      const text = annBo.text?.trim();
      if (!text || (text.includes('|') && text.includes(':'))) continue;
      const apps = text.split(',').map((s: string) => s.trim()).filter(Boolean);
      if (apps.length) {
        const taskId = taskBo.id || taskBo.$attrs?.id;
        const existing = annotationAppMap.get(taskId) || [];
        annotationAppMap.set(taskId, [...existing, ...apps]);
        parsedAnnotationIds.add(annBo.id || annBo.$attrs?.id);
        parsedAssociationIds.add(el.id);
      }
    }
  }

  // Hide parsed text annotations and their association connectors, same as
  // the full editor does, so they don't duplicate what the overlay shows.
  for (const annId of parsedAnnotationIds) {
    const annEl = elementRegistry.get(annId);
    if (annEl) {
      const gfx = canvas.getGraphics(annEl);
      if (gfx) gfx.style.display = 'none';
    }
  }
  for (const assocId of parsedAssociationIds) {
    const assocEl = elementRegistry.get(assocId);
    if (assocEl) {
      const gfx = canvas.getGraphics(assocEl);
      if (gfx) gfx.style.display = 'none';
    }
  }

  const tasks = elementRegistry.filter((el: any) => isActivityType(el.businessObject?.$type));
  for (const el of tasks) {
    let appNames = getTaskApps(el.businessObject);
    if (!appNames.length && annotationAppMap.has(el.id)) {
      appNames = annotationAppMap.get(el.id) || [];
    }
    if (!appNames.length) continue;

    const html = document.createElement('div');
    html.style.cssText = 'display:flex;flex-direction:column;gap:1px;padding:2px 0;font-family:"IBM Plex Sans",Arial,sans-serif;pointer-events:none;';
    for (const appName of appNames) {
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;align-items:center;gap:3px;white-space:nowrap;';
      const icon = document.createElement('span');
      icon.innerHTML = COMPUTER_ICON;
      icon.style.cssText = 'display:inline-flex;align-items:center;justify-content:center;width:16px;height:16px;color:#0284c7;flex-shrink:0;';
      const label = document.createElement('span');
      label.textContent = appName;
      label.style.cssText = 'font-size:9px;color:#0284c7;line-height:1.1;overflow:hidden;text-overflow:ellipsis;max-width:120px;';
      row.appendChild(icon);
      row.appendChild(label);
      html.appendChild(row);
    }
    overlays.add(el.id, 'task-apps-readonly', {
      position: { bottom: -4, left: 0 },
      html,
    });
  }
}

/**
 * Read-only bpmn.io canvas for embedding a single Business Process Flow
 * diagram inside a small dashboard frame — pan/zoom only (NavigatedViewer,
 * not Modeler), so there's no palette, no context pad, no properties panel
 * and nothing on the canvas is editable. Mirrors the application-icon
 * overlays used on the full Diagrams tab (see BpmnEditor.tsx's
 * renderAppOverlays) so the mini view looks consistent with it.
 */
export default function BpmnMiniViewer({ xml, diagramName }: BpmnMiniViewerProps) {
  const canvasRef = useRef<HTMLDivElement>(null);
  const viewerRef = useRef<any>(null);

  useEffect(() => {
    if (!canvasRef.current) return;
    const viewer = new BpmnViewer({
      container: canvasRef.current,
      moddleExtensions: { bpmniq: bpmniqModdle },
    });
    viewerRef.current = viewer;
    return () => {
      viewer.destroy();
      viewerRef.current = null;
    };
  }, []);

  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer || !xml) return;
    let cancelled = false;
    viewer.importXML(xml)
      .then(() => {
        if (cancelled) return;
        // Passing a truthy center forces diagram-js to center the fitted
        // content within the viewport rather than just anchoring it at
        // (0,0) — otherwise a diagram narrower/shorter than this frame
        // sits flush in the top-left corner instead of in the middle.
        const canvas = viewer.get('canvas');
        canvas.zoom('fit-viewport', true);
        // Fitting alone leaves the diagram touching the frame's edges —
        // scale down a bit more (no center arg, so diagram-js zooms around
        // the viewport's own center) to leave a visible margin all around.
        canvas.zoom(canvas.zoom() * 0.88);
        renderAppOverlays(viewer);
      })
      .catch((err: any) => {
        console.warn('[BpmnMiniViewer] Failed to import diagram XML:', err);
      });
    return () => { cancelled = true; };
  }, [xml]);

  return (
    <div style={{ position: 'relative', height: '100%', width: '100%' }}>
      {diagramName && (
        <div
          style={{
            position: 'absolute',
            top: 8,
            left: 8,
            zIndex: 5,
            background: 'rgba(255,255,255,0.9)',
            border: '1px solid #e5e7eb',
            borderRadius: 6,
            padding: '4px 10px',
            fontWeight: 700,
            fontSize: 13,
            maxWidth: 'calc(100% - 16px)',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            boxShadow: '0 1px 3px rgba(0,0,0,.08)',
            pointerEvents: 'none',
          }}
          title={diagramName}
        >
          {diagramName}
        </div>
      )}
      <div ref={canvasRef} style={{ height: '100%', width: '100%' }} />
    </div>
  );
}
