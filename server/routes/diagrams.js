const express = require('express');
const router = express.Router();
const Diagram = require('../models/Diagram');
const Component = require('../models/Component');
const CanonicalComponent = require('../models/CanonicalComponent');
const Model = require('../models/Model');
const Actor = require('../models/Actor');
const { Product, Domain, Subdomain, LineOfBusiness } = require('../models/ReferenceData');
const { DEFAULT_NEIGHBORHOOD_NAME, getNeighborhoodName, buildNeighborhoodFilter } = require('../utils/neighborhoodScope');
const { listApplicationReferences } = require('../utils/applicationReferenceLookup');
const { rebuildSearchIndex } = require('../utils/searchIndexBuilder');
const { buildBpmnXmlForFlow } = require('../lib/bpmnXmlBuilder');
const { applyGeneratedDiagramFormatting } = require('../lib/diagramFormatting');

/** Strip title/status housekeeping text annotations from the XML (they clutter the canvas) */
function stripTitleAnnotations(xml) {
  if (!xml) return xml;
  // Remove known housekeeping textAnnotation elements
  xml = xml.replace(/<bpmn:textAnnotation id="TextAnnotation_DiagramTitle">[\s\S]*?<\/bpmn:textAnnotation>\s*/g, '');
  xml = xml.replace(/<bpmn:textAnnotation id="TextAnnotation_LastUpdated">[\s\S]*?<\/bpmn:textAnnotation>\s*/g, '');
  xml = xml.replace(/<bpmn:textAnnotation id="TextAnnotation_Status">[\s\S]*?<\/bpmn:textAnnotation>\s*/g, '');

  // Remove one-off annotations whose text is purely housekeeping metadata.
  // Keep task/application annotations intact.
  xml = xml.replace(
    /<bpmn:textAnnotation\s+id="([^"]+)"[^>]*>[\s\S]*?<bpmn:text>([\s\S]*?)<\/bpmn:text>[\s\S]*?<\/bpmn:textAnnotation>\s*/gi,
    (match, annId, annText) => {
      const text = String(annText || '').trim();
      if (/^(status|factory status)\s*:/i.test(text)) return '';
      return match;
    }
  );

  // Remove their DI shapes
  xml = xml.replace(/<bpmndi:BPMNShape id="TextAnnotation_DiagramTitle_di"[\s\S]*?<\/bpmndi:BPMNShape>\s*/g, '');
  xml = xml.replace(/<bpmndi:BPMNShape id="TextAnnotation_LastUpdated_di"[\s\S]*?<\/bpmndi:BPMNShape>\s*/g, '');
  xml = xml.replace(/<bpmndi:BPMNShape id="TextAnnotation_Status_di"[\s\S]*?<\/bpmndi:BPMNShape>\s*/g, '');
  xml = xml.replace(/<bpmndi:BPMNShape[^>]+bpmnElement="TextAnnotation_Status"[\s\S]*?<\/bpmndi:BPMNShape>\s*/g, '');
  return xml;
}

/** Extract tasks array with source, target, and applications from BPMN XML */
function extractTasks(xml) {
  if (!xml) return [];

  // 1. Collect all elements (tasks, gateways, events) with their ids and names
  const elementMap = new Map(); // id -> { id, name, isTask }
  const taskTypes = /task|subProcess/i;

  // Match task-like elements (self-closing or with body)
  const elRegex = /<bpmn2?:(\w+)\b([^>]*)\/?>/gi;
  let m;
  while ((m = elRegex.exec(xml)) !== null) {
    const [, type, attrsRaw] = m;
    const id = (String(attrsRaw || '').match(/\bid="([^"]+)"/i) || [])[1];
    if (!id) continue;
    const name = (String(attrsRaw || '').match(/\bname="([^"]*)"/i) || [])[1];
    const isTask = taskTypes.test(type);
    elementMap.set(id, { id, name: decodeXmlValue(name || id), isTask });
  }

  // 2. Parse sequence flows into adjacency lists
  const outgoing = new Map(); // id -> [targetId, ...]
  const incoming = new Map(); // id -> [sourceId, ...]
  const flowRegex = /<bpmn2?:sequenceFlow[^>]+sourceRef="([^"]+)"[^>]+targetRef="([^"]+)"[^>]*\/?>/gi;
  while ((m = flowRegex.exec(xml)) !== null) {
    const [, src, tgt] = m;
    if (!outgoing.has(src)) outgoing.set(src, []);
    outgoing.get(src).push(tgt);
    if (!incoming.has(tgt)) incoming.set(tgt, []);
    incoming.get(tgt).push(src);
  }

  // 3. Trace through non-task nodes (gateways/events) to find connected tasks
  function findConnectedTasks(startId, direction) {
    const visited = new Set();
    const tasks = [];
    const queue = [startId];
    while (queue.length) {
      const id = queue.shift();
      if (visited.has(id)) continue;
      visited.add(id);
      const neighbors = direction === 'out' ? (outgoing.get(id) || []) : (incoming.get(id) || []);
      for (const nid of neighbors) {
        const el = elementMap.get(nid);
        if (!el) continue;
        if (el.isTask) {
          tasks.push(el.name);
        } else {
          queue.push(nid);
        }
      }
    }
    return tasks;
  }

  // 4. Parse per-task applications from bpmniq:TaskApplications extension elements
  //    Pattern: <bpmn:task id="...">...<bpmniq:Application name="AppName"/>...</bpmn:task>
  const taskAppExtMap = new Map(); // taskId -> [appName, ...]
  const taskBlockRegex = /<bpmn2?:(?:task|userTask|serviceTask|sendTask|receiveTask|manualTask|businessRuleTask|scriptTask|subProcess)\b([^>]*)>([\s\S]*?)<\/bpmn2?:(?:task|userTask|serviceTask|sendTask|receiveTask|manualTask|businessRuleTask|scriptTask|subProcess)>/gi;
  while ((m = taskBlockRegex.exec(xml)) !== null) {
    const [, taskAttrsRaw, body] = m;
    const taskId = (String(taskAttrsRaw || '').match(/\bid="([^"]+)"/i) || [])[1];
    if (!taskId) continue;
    const appNames = [];
    const appAttrRegex = /<(?:bpmniq|ns\d+):(?:A|a)pplication[^>]+name="([^"]+)"/gi;
    let am;
    while ((am = appAttrRegex.exec(body)) !== null) {
      const decoded = decodeXmlValue(am[1]);
      decoded.split(/[\r\n,;]+/).map((value) => value.trim()).filter(Boolean).forEach((value) => {
        if (!appNames.includes(value)) appNames.push(value);
      });
    }
    // Also handle element-style: <bpmniq:application><bpmniq:name>X</bpmniq:name></bpmniq:application>
    const appElRegex = /<(?:bpmniq|ns\d+):application>[\s\S]*?<(?:bpmniq|ns\d+):name>([\s\S]*?)<\/(?:bpmniq|ns\d+):name>[\s\S]*?<\/(?:bpmniq|ns\d+):application>/gi;
    while ((am = appElRegex.exec(body)) !== null) {
      const decoded = decodeXmlValue(am[1]);
      decoded.split(/[\r\n,;]+/).map((value) => value.trim()).filter(Boolean).forEach((value) => {
        if (!appNames.includes(value)) appNames.push(value);
      });
    }
    if (appNames.length) taskAppExtMap.set(taskId, appNames);
  }

  // 5. Parse text annotations and associations (fallback for apps)
  const annotationMap = new Map(); // annotationId -> text
  const annRegex = /<bpmn2?:textAnnotation\s+id="([^"]+)"[^>]*>[\s\S]*?<bpmn2?:text>([\s\S]*?)<\/bpmn2?:text>[\s\S]*?<\/bpmn2?:textAnnotation>/gi;
  while ((m = annRegex.exec(xml)) !== null) {
    const [, annId, text] = m;
    const trimmed = decodeXmlValue(text);
    // Skip metadata annotations (contain | and :) and empty annotations
    if (!trimmed || (trimmed.includes('|') && trimmed.includes(':'))) continue;
    annotationMap.set(annId, trimmed);
  }

  const assocAppMap = new Map(); // taskId -> [appName, ...]
  const assocRegex = /<bpmn2?:association[^>]+sourceRef="([^"]+)"[^>]+targetRef="([^"]+)"[^>]*\/?>/gi;
  while ((m = assocRegex.exec(xml)) !== null) {
    const [, srcRef, tgtRef] = m;
    // One of them is a textAnnotation, the other is a task
    const annId = annotationMap.has(srcRef) ? srcRef : annotationMap.has(tgtRef) ? tgtRef : null;
    const taskId = annId === srcRef ? tgtRef : srcRef;
    if (!annId) continue;
    const el = elementMap.get(taskId);
    if (!el || !el.isTask) continue;
    const apps = annotationMap.get(annId).split(/[\r\n,;]+/).map(s => s.trim()).filter(Boolean);
    if (apps.length) {
      const existing = assocAppMap.get(taskId) || [];
      assocAppMap.set(taskId, [...existing, ...apps]);
    }
  }

  // 6. Build tasks array
  const tasks = [];
  for (const [id, el] of elementMap) {
    if (!el.isTask) continue;
    const sourceTasks = findConnectedTasks(id, 'in');
    const targetTasks = findConnectedTasks(id, 'out');

    // Get applications: prefer extension elements, fall back to annotations
    const apps = taskAppExtMap.get(id) || assocAppMap.get(id) || [];

    tasks.push({
      name: el.name,
      source: sourceTasks.length ? sourceTasks.join(', ') : null,
      target: targetTasks.length ? targetTasks.join(', ') : null,
      applications: apps.map(name => ({ name })),
    });
  }

  return tasks;
}

/**
 * Per-task detail needed only for syncing into the Task factory (below) —
 * kept separate from extractTasks() so that function's well-established
 * output (and its tests) stay untouched. Returns the task's raw BPMN element
 * type (e.g. "userTask", for the bpmn_task_type_qualifier column) and the
 * name of the lane/actor it sits in (for actor_qualifier), alongside its name.
 */
function extractTaskDetailsForSync(xml) {
  if (!xml) return [];
  const taskTypes = /task|subProcess/i;
  const elRegex = /<bpmn2?:(\w+)\b([^>]*)\/?>/gi;
  const details = new Map(); // id -> { id, name, type }
  let m;
  while ((m = elRegex.exec(xml)) !== null) {
    const [, type, attrsRaw] = m;
    if (!taskTypes.test(type)) continue;
    const id = (String(attrsRaw || '').match(/\bid="([^"]+)"/i) || [])[1];
    if (!id) continue;
    const name = (String(attrsRaw || '').match(/\bname="([^"]*)"/i) || [])[1];
    details.set(id, { id, name: decodeXmlValue(name || id), type });
  }

  // Map each lane's flowNodeRef task ids to that lane's name.
  const laneForTaskId = new Map();
  const laneBlockRegex = /<bpmn2?:lane\b[^>]*\bname="([^"]+)"[^>]*>([\s\S]*?)<\/bpmn2?:lane>/gi;
  let lm;
  while ((lm = laneBlockRegex.exec(xml)) !== null) {
    const [, laneNameRaw, body] = lm;
    const laneName = decodeXmlValue(laneNameRaw);
    const refRegex = /<bpmn2?:flowNodeRef>([^<]+)<\/bpmn2?:flowNodeRef>/gi;
    let rm;
    while ((rm = refRegex.exec(body)) !== null) {
      laneForTaskId.set(rm[1].trim(), laneName);
    }
  }

  return [...details.values()].map((detail) => ({
    name: detail.name,
    type: detail.type,
    actor: laneForTaskId.get(detail.id) || null,
  }));
}

/**
 * Look up a parent row's _id by type + name, for setting parentRefs on a
 * freshly-synced row. Every PRE-EXISTING canonical row (from the original
 * upload/materialization) already has real parentRefs, which is what lets
 * the search index correctly climb Task -> Business Process Flow -> Subdomain
 * -> Domain — but the schema-declared parent-factory chain that would
 * otherwise drive that climb as a fallback doesn't cover every level for
 * every framework (e.g. "Business Process Flow" often isn't itself
 * registered anywhere with a declared parent). So a synced row with no
 * parentRefs of its own can silently fail to climb past itself. Setting
 * parentRefs explicitly here — the same mechanism real rows already use —
 * sidesteps that gap entirely instead of depending on it being fixed.
 */
async function resolveParentRowRef(neighborhoodName, parentTypeRegex, parentName) {
  if (!parentName) return null;
  const parentRow = await CanonicalComponent.findOne(
    { neighborhoodName, componentType: { $regex: parentTypeRegex }, primaryKey: { $regex: `^${escapeRegExp(parentName)}$`, $options: 'i' } },
    { _id: 1 }
  ).lean();
  return parentRow?._id || null;
}

/**
 * After a diagram is created/updated, make sure every task in its XML also
 * exists as a row in this neighborhood's Task factory (Model Components) —
 * otherwise a task added straight on the canvas only ever lives in that one
 * diagram's own XML/snapshot, and Tree Views/search (which read the Task
 * factory, not diagrams) never pick it up until someone manually runs
 * "Add to Task Component" for it. Best-effort: a sync problem here should
 * never fail the diagram save itself.
 */
// Returns whether it changed anything, so the caller can trigger a single
// search-index rebuild after ALL of this save's syncs finish, rather than
// each sync racing its own concurrent rebuild against the others'.
async function syncDiagramTasksToTaskFactory(neighborhoodName, diagramMeta, xml) {
  try {
    if (!neighborhoodName || !xml) return false;
    const taskDetails = extractTaskDetailsForSync(xml).filter((task) => task.name && task.name.trim());
    if (!taskDetails.length) return false;

    // diagramMeta fields (parsed from the diagram title annotation) can carry
    // un-decoded XML entities (e.g. "After-Sales &#38; Service" instead of
    // "After-Sales & Service") — decode defensively so a lineage value here
    // actually matches the cleanly-named Domain/Subdomain/etc rows it's
    // meant to link up with; otherwise the hierarchy climb silently stops
    // one level early with no error.
    const businessFlow = decodeXmlValue(String(diagramMeta.businessFlow || diagramMeta.name || '').trim());
    const lineageEntry = {};
    if (diagramMeta.lineOfBusiness) lineageEntry.lineOfBusiness = decodeXmlValue(diagramMeta.lineOfBusiness);
    if (diagramMeta.channel) lineageEntry.channel = decodeXmlValue(diagramMeta.channel);
    if (diagramMeta.product) lineageEntry.product = decodeXmlValue(diagramMeta.product);
    if (diagramMeta.domain) lineageEntry.domain = decodeXmlValue(diagramMeta.domain);
    if (diagramMeta.subdomain) lineageEntry.subdomain = decodeXmlValue(diagramMeta.subdomain);
    if (businessFlow) lineageEntry.businessFlow = businessFlow;
    const hasLineage = Object.keys(lineageEntry).length > 0;

    // Prefer the canonical-backed Task factory — that's what "New Task" /
    // "Add to Task Component" actually write to — falling back to a legacy
    // Component-backed factory for neighborhoods that still use one.
    const canonicalSample = await CanonicalComponent.findOne(
      { neighborhoodName, componentType: { $regex: /^tasks?$/i } },
      { componentType: 1 }
    ).lean();

    let changed = false;

    if (canonicalSample) {
      const componentType = canonicalSample.componentType;
      for (const task of taskDetails) {
        const taskName = task.name.trim();
        const existing = await CanonicalComponent.findOne({
          neighborhoodName,
          componentType,
          primaryKey: { $regex: `^${escapeRegExp(taskName)}$`, $options: 'i' },
        });

        if (!existing) {
          const parentRef = await resolveParentRowRef(neighborhoodName, /^business\s*(process\s*)?flow$/i, businessFlow);
          await CanonicalComponent.create({
            neighborhoodName,
            componentType,
            primaryKey: taskName,
            values: {
              name: taskName,
              ...(task.type ? { bpmn_task_type_qualifier: task.type } : {}),
              ...(task.actor ? { actor_qualifier: task.actor } : {}),
              ...(hasLineage ? { __lineage: lineageEntry, __lineageVariants: [lineageEntry] } : {}),
            },
            ...(parentRef ? { parentRefs: [parentRef] } : {}),
          });
          changed = true;
          continue;
        }

        // Already a known task — only touch it to record a *new* business
        // flow using it (so it shows up under that parent in the Tree View
        // too), never overwriting qualifiers a person may have set by hand.
        if (!hasLineage) continue;
        const values = existing.values && typeof existing.values === 'object' ? existing.values : {};
        const variants = Array.isArray(values.__lineageVariants) ? values.__lineageVariants : [];
        const alreadyTracked = variants.some(
          (variant) => variant && String(variant.businessFlow || '').trim().toLowerCase() === businessFlow.toLowerCase()
        );
        let rowChanged = false;
        if (!alreadyTracked) {
          existing.values = {
            ...values,
            __lineage: values.__lineage || lineageEntry,
            __lineageVariants: [...variants, lineageEntry],
          };
          rowChanged = true;
        }
        // A task reused under a second flow needs THAT flow's BPF added as
        // an additional parent too, not just skipped because it already has
        // one from wherever it was originally used — same "append, don't
        // just fill-when-empty" rule the Application sync below already
        // uses, since a row can legitimately have more than one parent.
        const parentRef = await resolveParentRowRef(neighborhoodName, /^business\s*(process\s*)?flow$/i, businessFlow);
        if (parentRef) {
          const existingParentIds = (existing.parentRefs || []).map((id) => String(id));
          if (!existingParentIds.includes(String(parentRef))) {
            existing.parentRefs = [...(existing.parentRefs || []), parentRef];
            rowChanged = true;
          }
        }
        if (rowChanged) {
          existing.markModified('values');
          await existing.save();
          changed = true;
        }
      }
    } else {
      const legacyFactory = await Component.findOne({ neighborhoodName, name: { $regex: /^tasks?$/i } });
      if (legacyFactory) {
        for (const task of taskDetails) {
          const taskName = task.name.trim();
          const existingRow = legacyFactory.rows.find(
            (row) => String(row.values?.get?.('name') || '').trim().toLowerCase() === taskName.toLowerCase()
          );
          if (existingRow) continue;

          const rowValues = new Map([['name', taskName]]);
          if (task.type) rowValues.set('bpmn_task_type_qualifier', task.type);
          if (task.actor) rowValues.set('actor_qualifier', task.actor);
          legacyFactory.rows.push({
            values: rowValues,
            owner: '',
            state: 'staged',
            sourcedFrom: 'diagram-sync',
            parentFactoryName: hasLineage ? 'Business Process Flow' : '',
            parentName: businessFlow || '',
          });
          changed = true;
        }
        if (changed) await legacyFactory.save();
      }
    }

    return changed;
  } catch (err) {
    console.error('[DIAGRAM SYNC] Failed to sync diagram tasks to Task factory:', err && err.message);
    return false;
  }
}

/**
 * After a diagram is created/updated, make sure the flow ITSELF also exists
 * as a row in this neighborhood's Business Process Flow factory — otherwise
 * a brand-new flow created via the "New Diagram" dialog only ever lives in
 * the Diagram document, and Model Components (Tree/Table views) and search
 * (which read the component factory, not diagrams) never pick it up. Mirrors
 * syncDiagramTasksToTaskFactory above, one level up the hierarchy.
 * Best-effort: a sync problem here should never fail the diagram save itself.
 */
async function syncDiagramFlowToBusinessFlowFactory(neighborhoodName, diagramMeta) {
  try {
    if (!neighborhoodName) return false;
    const flowName = decodeXmlValue(String(diagramMeta.businessFlow || diagramMeta.name || '').trim());
    if (!flowName) return false;

    // Same un-decoded-XML-entity defensiveness as the task sync above.
    const lineageEntry = {};
    if (diagramMeta.lineOfBusiness) lineageEntry.lineOfBusiness = decodeXmlValue(diagramMeta.lineOfBusiness);
    if (diagramMeta.channel) lineageEntry.channel = decodeXmlValue(diagramMeta.channel);
    if (diagramMeta.product) lineageEntry.product = decodeXmlValue(diagramMeta.product);
    if (diagramMeta.domain) lineageEntry.domain = decodeXmlValue(diagramMeta.domain);
    if (diagramMeta.subdomain) lineageEntry.subdomain = decodeXmlValue(diagramMeta.subdomain);
    lineageEntry.businessFlow = flowName;
    const hasAncestorLineage = Boolean(lineageEntry.domain || lineageEntry.subdomain);

    // Value Stream/Journey/Business Capability live as qualifier columns on
    // the flow's own row for this kind of framework (see the earlier "only
    // 3 of 10 domains" investigation) — not as separate parent levels.
    const qualifierUpdates = {};
    if (diagramMeta.valueStream) qualifierUpdates.value_stream_qualifier = decodeXmlValue(diagramMeta.valueStream);
    if (diagramMeta.journey) qualifierUpdates.journey_qualifier = decodeXmlValue(diagramMeta.journey);
    if (diagramMeta.businessCapability) qualifierUpdates.business_capability_qualifier = decodeXmlValue(diagramMeta.businessCapability);

    const canonicalSample = await CanonicalComponent.findOne(
      { neighborhoodName, componentType: { $regex: /^business\s*(process\s*)?flow$/i } },
      { componentType: 1 }
    ).lean();

    let changed = false;

    if (canonicalSample) {
      const componentType = canonicalSample.componentType;
      const existing = await CanonicalComponent.findOne({
        neighborhoodName,
        componentType,
        primaryKey: { $regex: `^${escapeRegExp(flowName)}$`, $options: 'i' },
      });

      if (!existing) {
        const parentRef = await resolveParentRowRef(neighborhoodName, /^subdomain$/i, lineageEntry.subdomain);
        await CanonicalComponent.create({
          neighborhoodName,
          componentType,
          primaryKey: flowName,
          values: {
            name: flowName,
            ...qualifierUpdates,
            ...(hasAncestorLineage ? { __lineage: lineageEntry, __lineageVariants: [lineageEntry] } : {}),
          },
          ...(parentRef ? { parentRefs: [parentRef] } : {}),
        });
        changed = true;
      } else {
        const values = existing.values && typeof existing.values === 'object' ? existing.values : {};
        const nextValues = { ...values };
        let rowChanged = false;

        // Fill missing qualifiers only — never clobber one a person already
        // set by hand (same "gap-filling, not overriding" rule as tasks).
        for (const [key, value] of Object.entries(qualifierUpdates)) {
          if (!nextValues[key]) {
            nextValues[key] = value;
            rowChanged = true;
          }
        }

        if (hasAncestorLineage) {
          const variants = Array.isArray(values.__lineageVariants) ? values.__lineageVariants : [];
          const alreadyTracked = variants.some((variant) => variant
            && String(variant.domain || '').trim().toLowerCase() === String(lineageEntry.domain || '').trim().toLowerCase()
            && String(variant.subdomain || '').trim().toLowerCase() === String(lineageEntry.subdomain || '').trim().toLowerCase());
          if (!alreadyTracked) {
            nextValues.__lineage = nextValues.__lineage || lineageEntry;
            nextValues.__lineageVariants = [...variants, lineageEntry];
            rowChanged = true;
          }
        }

        // Same "append, don't just fill-when-empty" rule as the task sync —
        // a flow name reused under a different subdomain needs that parent
        // added too, not skipped because one's already there.
        const parentRef = await resolveParentRowRef(neighborhoodName, /^subdomain$/i, lineageEntry.subdomain);
        if (parentRef) {
          const existingParentIds = (existing.parentRefs || []).map((id) => String(id));
          if (!existingParentIds.includes(String(parentRef))) {
            existing.parentRefs = [...(existing.parentRefs || []), parentRef];
            rowChanged = true;
          }
        }

        if (rowChanged) {
          existing.values = nextValues;
          existing.markModified('values');
          await existing.save();
          changed = true;
        }
      }
    } else {
      const legacyFactory = await Component.findOne({ neighborhoodName, name: { $regex: /^business\s*(process\s*)?flow$/i } });
      if (legacyFactory) {
        const existingRow = legacyFactory.rows.find(
          (row) => String(row.values?.get?.('name') || '').trim().toLowerCase() === flowName.toLowerCase()
        );
        if (!existingRow) {
          const rowValues = new Map([['name', flowName]]);
          for (const [key, value] of Object.entries(qualifierUpdates)) rowValues.set(key, value);
          legacyFactory.rows.push({
            values: rowValues,
            owner: '',
            state: 'staged',
            sourcedFrom: 'diagram-sync',
            parentFactoryName: lineageEntry.subdomain ? 'Subdomain' : '',
            parentName: lineageEntry.subdomain || '',
          });
          changed = true;
          await legacyFactory.save();
        }
      }
    }

    return changed;
  } catch (err) {
    console.error('[DIAGRAM SYNC] Failed to sync diagram flow to Business Process Flow factory:', err && err.message);
    return false;
  }
}

/**
 * After a diagram is created/updated, make sure every application its tasks
 * reference is linked (via parentRefs) to those tasks — otherwise a diagram
 * that reuses EXISTING tasks under a brand-new flow (e.g. one created via
 * the "New Diagram" dialog, reusing task names already in the Task
 * factory) leaves those applications' hierarchy still pointing only at
 * whichever flow they were ORIGINALLY used under. The application itself
 * technically "exists," but Tree Views/search never reach it for the NEW
 * flow, since nothing links it there. Mirrors the task/flow syncs above,
 * one level further down. Best-effort: never fails the diagram save itself.
 */
async function syncDiagramApplicationsToApplicationFactory(neighborhoodName, diagramMeta, tasks) {
  try {
    if (!neighborhoodName || !Array.isArray(tasks) || !tasks.length) return false;

    const businessFlow = decodeXmlValue(String(diagramMeta.businessFlow || diagramMeta.name || '').trim());
    const lineageEntry = {};
    if (diagramMeta.lineOfBusiness) lineageEntry.lineOfBusiness = decodeXmlValue(diagramMeta.lineOfBusiness);
    if (diagramMeta.channel) lineageEntry.channel = decodeXmlValue(diagramMeta.channel);
    if (diagramMeta.product) lineageEntry.product = decodeXmlValue(diagramMeta.product);
    if (diagramMeta.domain) lineageEntry.domain = decodeXmlValue(diagramMeta.domain);
    if (diagramMeta.subdomain) lineageEntry.subdomain = decodeXmlValue(diagramMeta.subdomain);
    if (businessFlow) lineageEntry.businessFlow = businessFlow;
    const hasLineage = Object.keys(lineageEntry).length > 0;

    const canonicalSample = await CanonicalComponent.findOne(
      { neighborhoodName, componentType: { $regex: /^applications?$/i } },
      { componentType: 1 }
    ).lean();
    if (!canonicalSample) return false; // no Application factory for this neighborhood — nothing to link into

    const componentType = canonicalSample.componentType;
    let changed = false;

    for (const task of tasks) {
      const taskName = decodeXmlValue(String(task?.name || '').trim());
      const applications = Array.isArray(task?.applications) ? task.applications : [];
      if (!taskName || !applications.length) continue;

      const taskRow = await CanonicalComponent.findOne(
        { neighborhoodName, componentType: { $regex: /^tasks?$/i }, primaryKey: { $regex: `^${escapeRegExp(taskName)}$`, $options: 'i' } },
        { _id: 1 }
      ).lean();
      if (!taskRow) continue; // task itself isn't synced yet (task-sync runs before this) — skip

      for (const application of applications) {
        // The diagram stores whichever identifier was in the task's
        // extension elements — sometimes the app's own name, sometimes its
        // app_id/correlationId — so match against either.
        const identifier = decodeXmlValue(String(application?.name || application?.correlationId || '').trim());
        if (!identifier) continue;

        let appRow = await CanonicalComponent.findOne({
          neighborhoodName,
          componentType,
          $or: [
            { primaryKey: { $regex: `^${escapeRegExp(identifier)}$`, $options: 'i' } },
            { 'values.app_id': { $regex: `^${escapeRegExp(identifier)}$`, $options: 'i' } },
          ],
        });

        if (!appRow) {
          appRow = await CanonicalComponent.create({
            neighborhoodName,
            componentType,
            primaryKey: identifier,
            values: {
              name: identifier,
              ...(hasLineage ? { __lineage: lineageEntry, __lineageVariants: [lineageEntry] } : {}),
            },
            parentRefs: [taskRow._id],
          });
          changed = true;
          continue;
        }

        let rowChanged = false;
        const parentRefIds = (appRow.parentRefs || []).map((id) => String(id));
        if (!parentRefIds.includes(String(taskRow._id))) {
          appRow.parentRefs = [...(appRow.parentRefs || []), taskRow._id];
          rowChanged = true;
        }

        if (hasLineage) {
          const values = appRow.values && typeof appRow.values === 'object' ? appRow.values : {};
          const variants = Array.isArray(values.__lineageVariants) ? values.__lineageVariants : [];
          const alreadyTracked = variants.some(
            (variant) => variant && String(variant.businessFlow || '').trim().toLowerCase() === businessFlow.toLowerCase()
          );
          if (!alreadyTracked) {
            appRow.values = {
              ...values,
              __lineage: values.__lineage || lineageEntry,
              __lineageVariants: [...variants, lineageEntry],
            };
            appRow.markModified('values');
            rowChanged = true;
          }
        }

        if (rowChanged) {
          await appRow.save();
          changed = true;
        }
      }
    }

    return changed;
  } catch (err) {
    console.error('[DIAGRAM SYNC] Failed to sync diagram applications to Application factory:', err && err.message);
    return false;
  }
}

/** Parse metadata from TextAnnotation_DiagramTitle text content (primary),
 *  falling back to <bpmndi:BPMNDiagram name="..."> attribute.
 *  Format: "Line of Business: X | Channel: Y | ... | Business Flow: Z"
 */
function parseDiagramMetadata(xml) {
  const meta = {};
  if (!xml) return meta;

  // 1. Prefer TextAnnotation_DiagramTitle (standard for BPMN Bender exports)
  let metaString = null;
  const annMatch = xml.match(/<bpmn:textAnnotation\s+id="TextAnnotation_DiagramTitle"[^>]*>[\s\S]*?<bpmn:text>([\s\S]*?)<\/bpmn:text>/i);
  if (annMatch) metaString = annMatch[1].trim();

  // 2. Fall back to BPMNDiagram name attribute
  if (!metaString) {
    const diagMatch = xml.match(/<bpmndi:BPMNDiagram[^>]+name="([^"]+)"/i);
    if (diagMatch) metaString = diagMatch[1];
  }

  if (!metaString) return meta;

  const pairs = metaString.split('|').map(s => s.trim());
  for (const pair of pairs) {
    const idx = pair.indexOf(':');
    if (idx < 0) continue;
    const key = pair.slice(0, idx).trim().toLowerCase();
    const value = pair.slice(idx + 1).trim();
    if (!value) continue;
    if (key === 'line of business') meta.lineOfBusiness = value;
    else if (key === 'channel') meta.channel = value;
    else if (key === 'domain') meta.domain = value;
    else if (key === 'subdomain') meta.subdomain = value;
    else if (key === 'product') meta.product = value;
    else if (key === 'value stream') meta.valueStream = value;
    else if (key === 'journey') meta.journey = value;
    else if (key === 'business capability') meta.businessCapability = value;
    else if (key === 'business flow') meta.businessFlow = value;
  }
  return meta;
}

// Inverse of parseDiagramMetadata's title-annotation format — used when
// generating a fresh, properly-formatted skeleton diagram (see
// buildBpmnXmlForFlow below) so it round-trips the same way a diagram
// produced by the load/generation pipeline does.
function buildMetadataBreadcrumb(meta) {
  const parts = [];
  if (meta.lineOfBusiness) parts.push(`Line of Business: ${meta.lineOfBusiness}`);
  if (meta.channel) parts.push(`Channel: ${meta.channel}`);
  if (meta.domain) parts.push(`Domain: ${meta.domain}`);
  if (meta.subdomain) parts.push(`Subdomain: ${meta.subdomain}`);
  if (meta.product) parts.push(`Product: ${meta.product}`);
  if (meta.valueStream) parts.push(`Value Stream: ${meta.valueStream}`);
  if (meta.journey) parts.push(`Journey: ${meta.journey}`);
  if (meta.businessCapability) parts.push(`Business Capability: ${meta.businessCapability}`);
  parts.push(`Business Flow: ${meta.businessFlow || ''}`.trim());
  return parts.join(' | ');
}

function normalizeLookupValue(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

function normalizeMetadataMatchValue(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/&/g, ' ')
    .replace(/\//g, ' ')
    .replace(/[^a-z0-9\s]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function escapeRegExp(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildFlexibleNameRegex(value) {
  const normalized = normalizeLookupValue(value);
  if (!normalized) return null;
  const flexible = escapeRegExp(normalized).replace(/\s+/g, '[\\s_]*');
  try {
    return new RegExp(`^${flexible}$`, 'i');
  } catch {
    return null;
  }
}

function normalizeObjectMatchValue(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/&/g, ' ')
    .replace(/\//g, ' ')
    .replace(/[^a-z0-9\s]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function getPlainRowValues(values) {
  if (!values) return {};
  if (values instanceof Map) return Object.fromEntries(values.entries());
  if (typeof values.toObject === 'function') return values.toObject();
  return { ...values };
}

function getCustomFactoryRowName(row) {
  const values = getPlainRowValues(row?.values);
  return String(values.name || '').trim();
}

function rowMatchesParent(row, parentName) {
  const expected = normalizeObjectMatchValue(parentName);
  if (!expected) return true;
  const rawParentName = String(row?.parentName || '');
  if (rawParentName.trim()) {
    return rawParentName
      .split(/[|,]/)
      .map((value) => normalizeObjectMatchValue(value))
      .includes(expected);
  }

  // Spreadsheet lineage snapshot is the source of truth when parentName is absent.
  const values = getPlainRowValues(row?.values);
  const lineageVariants = [];
  if (values.__lineage && typeof values.__lineage === 'object') lineageVariants.push(values.__lineage);
  if (Array.isArray(values.__lineageVariants)) {
    values.__lineageVariants.forEach((variant) => {
      if (variant && typeof variant === 'object') lineageVariants.push(variant);
    });
  }

  if (!lineageVariants.length) return false;

  const lineageKeys = [
    'businessCapability',
    'journey',
    'valueStream',
    'subdomain',
    'domain',
    'product',
    'channel',
    'lineOfBusiness',
    'businessFlow',
  ];

  return lineageVariants.some((variant) => lineageKeys.some((key) => normalizeObjectMatchValue(variant?.[key]) === expected));
}

async function getNeighborhoodMetadataMappings(neighborhoodName) {
  const baseMappings = {
    lineOfBusiness: { label: 'Line of Business', kind: 'reference', model: LineOfBusiness },
    channel: { label: 'Channel', kind: 'metadata' },
    product: { label: 'Product', kind: 'reference', model: Product },
    valueStream: { label: 'Value Stream', kind: 'customFactory', factoryName: 'value stream', parentFactoryName: 'product', parentField: 'product' },
    journey: { label: 'Journey', kind: 'customFactory', factoryName: 'journey', parentFactoryName: 'value stream', parentField: 'valueStream' },
    businessCapability: { label: 'Business Capability', kind: 'customFactory', factoryName: 'business capability', parentFactoryName: 'journey', parentField: 'journey' },
    businessFlow: {
      label: 'Business Flow',
      kind: 'customFactory',
      factoryName: 'business_flow',
      parentFactoryName: 'business capability',
      parentField: 'businessCapability',
    },
  };

  if (neighborhoodName === DEFAULT_NEIGHBORHOOD_NAME) {
    return {
      ...baseMappings,
      domain: { label: 'Domain', kind: 'reference', model: Domain },
      subdomain: { label: 'Subdomain', kind: 'reference', model: Subdomain },
    };
  }

  const model = await Model.findOne({ name: neighborhoodName }, { schemaFactories: 1 }).lean();
  const orderedFactories = [...(model?.schemaFactories || [])].sort((left, right) => {
    const leftLevel = Number.isFinite(left?.level) ? left.level : Number.MAX_SAFE_INTEGER;
    const rightLevel = Number.isFinite(right?.level) ? right.level : Number.MAX_SAFE_INTEGER;
    if (leftLevel !== rightLevel) return leftLevel - rightLevel;
    return String(left?.name || '').localeCompare(String(right?.name || ''));
  });

  const mappings = {};
  const fieldOrder = ['lineOfBusiness', 'channel', 'product', 'domain', 'subdomain', 'valueStream', 'journey', 'businessCapability', 'businessFlow'];
  const parentFieldByField = {
    lineOfBusiness: null,
    channel: 'lineOfBusiness',
    product: 'channel',
    domain: 'product',
    subdomain: 'domain',
    valueStream: 'subdomain',
    journey: 'valueStream',
    businessCapability: 'journey',
    businessFlow: 'businessCapability',
  };

  for (let index = 0; index < fieldOrder.length; index += 1) {
    const fieldName = fieldOrder[index];
    const factory = orderedFactories[index];
    if (!factory?.name) continue;
    mappings[fieldName] = {
      label: factory.name,
      kind: 'customFactory',
      factoryName: factory.name,
      parentFactoryName: index > 0 ? (orderedFactories[index - 1]?.name || '') : '',
      parentField: parentFieldByField[fieldName],
    };
  }

  return mappings;
}

async function hasMatchingReferenceValue(Model, neighborhoodName, value) {
  const normalizedTarget = normalizeMetadataMatchValue(value);
  if (!normalizedTarget) return false;
  const items = await Model.find(buildNeighborhoodFilter(neighborhoodName), { name: 1 }).lean();
  return items.some((item) => normalizeMetadataMatchValue(item?.name) === normalizedTarget);
}

async function hasMatchingCustomFactoryValue(neighborhoodName, mapping, value, parentValue) {
  if (!mapping?.factoryName) return false;
  const factoryNameRegex = buildFlexibleNameRegex(mapping.factoryName);
  if (!factoryNameRegex) return false;
  const factory = await Component.findOne(
    {
      neighborhoodName,
      name: { $regex: factoryNameRegex },
    },
    { rows: 1, parentFactoryName: 1 }
  ).lean();
  if (!factory) return false;

  const normalizedTarget = normalizeMetadataMatchValue(value);
  return (factory.rows || []).some((row) => {
    if (normalizeMetadataMatchValue(getCustomFactoryRowName(row)) !== normalizedTarget) return false;
    if (!parentValue || !mapping.parentFactoryName) return true;
    return rowMatchesParent(row, parentValue);
  });
}

async function getComponentFieldMatchInfo(neighborhoodName, mapping, fieldName, value, parentValue) {
  const candidateNames = [];
  if (mapping?.factoryName) candidateNames.push(String(mapping.factoryName || '').trim());
  if (mapping?.label) candidateNames.push(String(mapping.label || '').trim());

  if (fieldName === 'lineOfBusiness') candidateNames.push('line_of_business', 'line of business', 'lob');
  if (fieldName === 'valueStream') candidateNames.push('value_stream', 'value stream');
  if (fieldName === 'journey') candidateNames.push('journey');
  if (fieldName === 'businessCapability') candidateNames.push('business_capability', 'business capability');
  if (fieldName === 'businessFlow') candidateNames.push('business_flow', 'business flow');
  if (fieldName === 'subdomain') candidateNames.push('sub_domain', 'sub domain');

  const uniqueNames = [...new Set(candidateNames.filter(Boolean).map((name) => normalizeLookupValue(name)))];
  if (!uniqueNames.length) return { hasComponentType: false, isValid: false };

  const regexList = uniqueNames
    .map((name) => buildFlexibleNameRegex(name))
    .filter(Boolean);
  if (!regexList.length) return { hasComponentType: false, isValid: false };

  const component = await Component.findOne(
    {
      neighborhoodName,
      $or: regexList.map((regex) => ({ name: { $regex: regex } })),
    },
    { rows: 1 }
  ).lean();

  if (!component) return { hasComponentType: false, isValid: false };

  const normalizedTarget = normalizeMetadataMatchValue(value);
  const isValid = (component.rows || []).some((row) => {
    if (normalizeMetadataMatchValue(getCustomFactoryRowName(row)) !== normalizedTarget) return false;
    if (!parentValue) return true;
    return rowMatchesParent(row, parentValue);
  });

  return { hasComponentType: true, isValid };
}

async function validateDiagramMetadataForNeighborhood(meta, neighborhoodName) {
  const mappings = await getNeighborhoodMetadataMappings(neighborhoodName);
  const invalidFields = [];
  const matchedFields = [];

  for (const [fieldName, mapping] of Object.entries(mappings)) {
    const value = String(meta?.[fieldName] || '').trim();
    if (!value) continue;

    let isValid = false;
    const parentValue = mapping.parentField ? meta?.[mapping.parentField] : undefined;
    const componentMatch = await getComponentFieldMatchInfo(neighborhoodName, mapping, fieldName, value, parentValue);

    if (componentMatch.hasComponentType) {
      // Component rows are the source of truth for model metadata when available.
      isValid = componentMatch.isValid;
    } else if (mapping.kind === 'reference' && mapping.model) {
      isValid = await hasMatchingReferenceValue(mapping.model, neighborhoodName, value);
    } else if (mapping.kind === 'customFactory') {
      isValid = await hasMatchingCustomFactoryValue(neighborhoodName, mapping, value, parentValue);
    } else if (mapping.kind === 'metadata') {
      isValid = true;
    }

    matchedFields.push({ fieldName, label: mapping.label, value, isValid });
    if (!isValid) {
      invalidFields.push({ fieldName, label: mapping.label, value });
    }
  }

  return {
    neighborhoodName,
    matchedFields,
    invalidFields,
    validFieldCount: matchedFields.length - invalidFields.length,
  };
}

async function resolveDiagramNeighborhood(meta, hintedNeighborhoodName) {
  const modelNames = await Model.distinct('name');
  const orderedNames = [
    String(hintedNeighborhoodName || '').trim(),
    ...modelNames.map((name) => String(name || '').trim()),
    DEFAULT_NEIGHBORHOOD_NAME,
  ].filter(Boolean).filter((name, index, list) => list.indexOf(name) === index);

  let bestMatch = null;
  for (const neighborhoodName of orderedNames) {
    const summary = await validateDiagramMetadataForNeighborhood(meta, neighborhoodName);
    if (!summary.matchedFields.length || summary.invalidFields.length) continue;
    if (!bestMatch || summary.validFieldCount > bestMatch.validFieldCount) {
      bestMatch = summary;
    }
  }

  if (bestMatch) return bestMatch;

  const fallbackNeighborhoodName = String(hintedNeighborhoodName || '').trim() || DEFAULT_NEIGHBORHOOD_NAME;
  return validateDiagramMetadataForNeighborhood(meta, fallbackNeighborhoodName);
}

function normalizeBusinessFlowLookupValue(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');
}

function extractLaneNames(xml) {
  if (!xml) return [];
  const laneNames = [];
  const laneRegex = /<bpmn2?:lane\b[^>]*\bname="([^"]+)"/gi;
  let match;
  while ((match = laneRegex.exec(xml)) !== null) {
    const name = decodeXmlValue(match[1]);
    if (name) laneNames.push(name);
  }
  return [...new Set(laneNames)];
}

function decodeXmlValue(value) {
  let next = String(value || '');
  for (let i = 0; i < 2; i += 1) {
    const decoded = next
      .replace(/&#(\d+);/g, (_match, codePoint) => String.fromCharCode(Number(codePoint)))
      .replace(/&#x([0-9a-f]+);/gi, (_match, hexCodePoint) => String.fromCharCode(parseInt(hexCodePoint, 16)))
      .replace(/&amp;/gi, '&')
      .replace(/&lt;/gi, '<')
      .replace(/&gt;/gi, '>')
      .replace(/&quot;/gi, '"')
      .replace(/&apos;/gi, "'");
    if (decoded === next) break;
    next = decoded;
  }
  return next.trim();
}

function normalizeNameForFuzzyMatch(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function levenshteinDistance(left, right) {
  const a = normalizeNameForFuzzyMatch(left);
  const b = normalizeNameForFuzzyMatch(right);
  if (!a) return b.length;
  if (!b) return a.length;

  const matrix = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let i = 0; i <= a.length; i += 1) matrix[i][0] = i;
  for (let j = 0; j <= b.length; j += 1) matrix[0][j] = j;

  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      const substitutionCost = a[i - 1] === b[j - 1] ? 0 : 1;
      matrix[i][j] = Math.min(
        matrix[i - 1][j] + 1,
        matrix[i][j - 1] + 1,
        matrix[i - 1][j - 1] + substitutionCost
      );
    }
  }

  return matrix[a.length][b.length];
}

function similarityScore(left, right) {
  const a = normalizeNameForFuzzyMatch(left);
  const b = normalizeNameForFuzzyMatch(right);
  if (!a || !b) return 0;
  if (a === b) return 1;
  const maxLength = Math.max(a.length, b.length);
  if (!maxLength) return 0;
  return 1 - (levenshteinDistance(a, b) / maxLength);
}

function parseApplicationEntriesFromXml(xml) {
  if (!xml) return [];

  const entries = [];
  const taskBlockRegex = /<bpmn2?:(?:task|userTask|serviceTask|sendTask|receiveTask|manualTask|businessRuleTask|scriptTask|subProcess)\b([^>]*)>([\s\S]*?)<\/bpmn2?:(?:task|userTask|serviceTask|sendTask|receiveTask|manualTask|businessRuleTask|scriptTask|subProcess)>/gi;
  let taskMatch;

  while ((taskMatch = taskBlockRegex.exec(xml)) !== null) {
    const [, , body] = taskMatch;

    const appAttrRegex = /<(?:bpmniq|ns\d+):(?:A|a)pplication\b([^>]*)\/?>(?:<\/\s*(?:bpmniq|ns\d+):(?:A|a)pplication>)?/gi;
    let attrMatch;
    while ((attrMatch = appAttrRegex.exec(body)) !== null) {
      const attrs = attrMatch[1] || '';
      const correlationId = decodeXmlValue((attrs.match(/\bcorrelationId="([^"]+)"/i) || [])[1]);
      const acronym = decodeXmlValue((attrs.match(/\bacronym="([^"]+)"/i) || [])[1]);
      const name = decodeXmlValue((attrs.match(/\bname="([^"]+)"/i) || [])[1]);
      if (correlationId || acronym || name) {
        entries.push({ correlationId: correlationId || null, acronym: acronym || null, name: name || correlationId || acronym || '' });
      }
    }

    const appElementRegex = /<(?:bpmniq|ns\d+):application\b[^>]*>([\s\S]*?)<\/(?:bpmniq|ns\d+):application>/gi;
    let appElementMatch;
    while ((appElementMatch = appElementRegex.exec(body)) !== null) {
      const appBody = appElementMatch[1];
      const correlationId = decodeXmlValue((appBody.match(/<(?:bpmniq|ns\d+):correlationId>([\s\S]*?)<\/(?:bpmniq|ns\d+):correlationId>/i) || [])[1])
        || decodeXmlValue((appBody.match(/<(?:bpmniq|ns\d+):correlationIds\b[^>]*>[\s\S]*?<(?:bpmniq|ns\d+):id>([\s\S]*?)<\/(?:bpmniq|ns\d+):id>/i) || [])[1]);
      const acronym = decodeXmlValue((appBody.match(/<(?:bpmniq|ns\d+):acronym>([\s\S]*?)<\/(?:bpmniq|ns\d+):acronym>/i) || [])[1]);
      const name = decodeXmlValue((appBody.match(/<(?:bpmniq|ns\d+):name>([\s\S]*?)<\/(?:bpmniq|ns\d+):name>/i) || [])[1]);
      if (correlationId || acronym || name) {
        entries.push({ correlationId: correlationId || null, acronym: acronym || null, name: name || correlationId || acronym || '' });
      }
    }
  }

  return entries;
}

function extractApplicationIdentifiersFromXml(xml) {
  return [...new Set(parseApplicationEntriesFromXml(xml).flatMap((entry) => [entry.correlationId, entry.acronym, entry.name].filter(Boolean)))];
}

function combineFilters(left, right) {
  const leftFilter = left && Object.keys(left).length ? left : null;
  const rightFilter = right && Object.keys(right).length ? right : null;
  if (leftFilter && rightFilter) return { $and: [leftFilter, rightFilter] };
  return leftFilter || rightFilter || {};
}

async function validateDiagramObjectIntegrity(diagramLike, neighborhoodName = DEFAULT_NEIGHBORHOOD_NAME) {
  const capabilityNames = [...new Set(
    (diagramLike.capabilities || [])
      .map((capability) => String(capability?.capabilityName || '').trim())
      .filter(Boolean)
  )];
  const businessFlow = String(diagramLike.name || diagramLike.businessFlow || '').trim();
  const taskNames = [...new Set((diagramLike.tasks || []).map((task) => String(task?.name || '').trim()).filter(Boolean))];
  const xmlApplicationEntries = parseApplicationEntriesFromXml(diagramLike.xml || '');
  const applicationEntries = xmlApplicationEntries.length
    ? xmlApplicationEntries
    : [...new Set(
        (diagramLike.tasks || []).flatMap((task) =>
          (task.applications || []).map((app) => ({
            correlationId: String(app?.correlationId || '').trim(),
            acronym: String(app?.acronym || '').trim(),
            name: String(app?.name || '').trim(),
          })).filter((app) => app.name || app.correlationId || app.acronym)
        )
      )];
  const laneNames = extractLaneNames(diagramLike.xml || '');

  const neighborhoodFilter = buildNeighborhoodFilter(neighborhoodName);
  const taskComponentFilter = combineFilters(neighborhoodFilter, { name: { $regex: /^tasks?$/i } });

  const [taskComponent, knownApplications, knownActorNames] = await Promise.all([
    Component.findOne(taskComponentFilter, { rows: 1 }).lean(),
    listApplicationReferences(neighborhoodName),
    Actor.distinct('name', neighborhoodFilter),
  ]);

  const scopedTaskNames = (taskComponent?.rows || [])
    .filter((row) => rowMatchesParent(row, businessFlow))
    .map((row) => getCustomFactoryRowName(row))
    .filter(Boolean);
  const knownTaskNames = scopedTaskNames.length
    ? scopedTaskNames
    : (taskComponent?.rows || []).map((row) => getCustomFactoryRowName(row)).filter(Boolean);

  const taskSet = new Set(knownTaskNames.map((name) => normalizeObjectMatchValue(name)));
  const knownByCorrelationId = new Map(
    knownApplications
      .map((application) => [normalizeObjectMatchValue(application.correlationId), application])
      .filter(([key]) => key)
  );
  const knownByName = new Map(
    knownApplications
      .map((application) => [normalizeObjectMatchValue(application.name), application])
      .filter(([key]) => key)
  );
  const actorSet = new Set(knownActorNames.map((name) => normalizeObjectMatchValue(name)));

  const invalidTasks = taskNames.filter((name) => !taskSet.has(normalizeObjectMatchValue(name)));
  const invalidApplications = [];
  for (const application of applicationEntries) {
    const correlationId = normalizeObjectMatchValue(application.correlationId);
    const name = normalizeObjectMatchValue(application.name);

    if (correlationId && knownByCorrelationId.has(correlationId)) {
      continue;
    }

    if (name && knownByName.has(name)) {
      continue;
    }

    if (name) {
      const bestMatch = knownApplications
        .map((candidate) => ({ candidate, score: similarityScore(candidate.name, application.name) }))
        .sort((left, right) => right.score - left.score)[0];
      if (bestMatch && bestMatch.score >= 0.55) continue;
    }

    invalidApplications.push(application.name || application.correlationId || 'Unknown application');
  }
  const invalidActors = laneNames.filter((name) => !actorSet.has(normalizeObjectMatchValue(name)));
  const hasCapabilities = capabilityNames.length > 0;

  return {
    hasCapabilities,
    invalidTasks,
    invalidApplications,
    invalidActors,
    hasValidObjects: hasCapabilities && !invalidTasks.length && !invalidApplications.length && !invalidActors.length,
  };
}

async function hasMatchingBusinessFlowReference(name, neighborhoodName = DEFAULT_NEIGHBORHOOD_NAME) {
  const normalizedName = normalizeBusinessFlowLookupValue(name);
  if (!normalizedName) return false;

  const BUSINESS_FLOW_COMPONENT_REGEX = /^(business[\s_]*flow|business[\s_]*process[\s_]*flow)$/i;
  const businessFlowComponentFilter = combineFilters(
    buildNeighborhoodFilter(neighborhoodName),
    { name: { $regex: BUSINESS_FLOW_COMPONENT_REGEX } }
  );
  const businessFlowComponents = await Component.find(businessFlowComponentFilter, { rows: 1, name: 1 }).lean();

  for (const businessFlowComponent of businessFlowComponents || []) {
    const hasMatch = (businessFlowComponent?.rows || []).some((row) => {
      const rowValues = getPlainRowValues(row?.values);
      const rowCandidates = [
        getCustomFactoryRowName(row),
        row?.name,
        row?.primaryKey,
        ...Object.values(rowValues || {}),
      ]
        .map((value) => String(value || '').trim())
        .filter(Boolean);

      return rowCandidates.some((candidate) => normalizeBusinessFlowLookupValue(candidate) === normalizedName);
    });

    if (hasMatch) return true;
  }

  return false;
}

async function resolveImportedDiagramStatus(requestedStatus, sourcedFrom, businessFlowName, neighborhoodName, metadataValidationSummary, diagramLike = {}, validStatus = 'staged') {
  const normalizedStatus = String(requestedStatus || '').trim().toLowerCase();
  const isImportLike = ['invalid', 'staged'].includes(normalizedStatus) || Boolean(sourcedFrom);
  if (!isImportLike) {
    return requestedStatus || 'Draft';
  }

  const hasReferenceValidity = metadataValidationSummary?.invalidFields?.length
    ? false
    : metadataValidationSummary?.matchedFields?.length
      ? true
      : await hasMatchingBusinessFlowReference(businessFlowName, neighborhoodName);

  const objectValidity = await validateDiagramObjectIntegrity(
    {
      ...diagramLike,
      name: diagramLike.name || businessFlowName,
      businessFlow: diagramLike.businessFlow || businessFlowName,
    },
    neighborhoodName
  );

  return hasReferenceValidity && objectValidity.hasValidObjects ? validStatus : 'invalid';
}

// POST /api/diagrams/validate — validate a diagram and return a detailed report
router.post('/validate', async (req, res) => {
  try {
    const {
      id,
      xml,
      name,
      businessFlow,
      capabilities,
      neighborhoodName: requestedNeighborhoodName,
    } = req.body || {};

    const neighborhoodName = String(requestedNeighborhoodName || getNeighborhoodName(req) || DEFAULT_NEIGHBORHOOD_NAME).trim() || DEFAULT_NEIGHBORHOOD_NAME;

    let diagramLike;
    if (id) {
      const existing = await Diagram.findOne({ $and: [buildNeighborhoodFilter(neighborhoodName), { _id: id }] }).lean();
      if (!existing) {
        return res.status(404).json({ error: 'Diagram not found for validation.' });
      }
      diagramLike = {
        ...existing,
        xml: xml !== undefined ? String(xml) : (existing.xml || ''),
        name: name !== undefined ? String(name) : existing.name,
        businessFlow: businessFlow !== undefined ? String(businessFlow) : existing.businessFlow,
        capabilities: Array.isArray(capabilities) ? capabilities : (existing.capabilities || []),
      };
      if (xml !== undefined) {
        diagramLike.tasks = extractTasks(String(xml));
      }
    } else {
      const rawXml = String(xml || '');
      if (!rawXml) {
        return res.status(400).json({ error: 'xml is required when id is not provided.' });
      }
      const meta = parseDiagramMetadata(rawXml);
      const inferredName = String(name || meta.businessFlow || '').trim();
      diagramLike = {
        xml: rawXml,
        name: inferredName || 'Untitled',
        businessFlow: String(businessFlow || meta.businessFlow || inferredName || '').trim(),
        capabilities: Array.isArray(capabilities) ? capabilities : [],
        tasks: extractTasks(rawXml),
        ...meta,
      };
    }

    const xmlForValidation = String(diagramLike.xml || '');
    const metadata = parseDiagramMetadata(xmlForValidation);
    const mergedMeta = {
      lineOfBusiness: diagramLike.lineOfBusiness || metadata.lineOfBusiness,
      channel: diagramLike.channel || metadata.channel,
      domain: diagramLike.domain || metadata.domain,
      subdomain: diagramLike.subdomain || metadata.subdomain,
      product: diagramLike.product || metadata.product,
      valueStream: diagramLike.valueStream || metadata.valueStream,
      journey: diagramLike.journey || metadata.journey,
      businessCapability: diagramLike.businessCapability || metadata.businessCapability,
      businessFlow: diagramLike.businessFlow || diagramLike.name || metadata.businessFlow || '',
    };

    const metadataValidation = await validateDiagramMetadataForNeighborhood(mergedMeta, neighborhoodName);
    const hasBusinessFlowReference = await hasMatchingBusinessFlowReference(mergedMeta.businessFlow || diagramLike.name, neighborhoodName);
    const objectValidation = await validateDiagramObjectIntegrity(
      {
        ...diagramLike,
        name: diagramLike.name || mergedMeta.businessFlow,
        businessFlow: mergedMeta.businessFlow || diagramLike.name,
        xml: xmlForValidation,
      },
      neighborhoodName
    );

    const hasReferenceValidity = metadataValidation.invalidFields.length
      ? false
      : metadataValidation.matchedFields.length
        ? true
        : hasBusinessFlowReference;

    const isValid = hasReferenceValidity && objectValidation.hasValidObjects;

    const reasons = [];
    if (!hasBusinessFlowReference) reasons.push('Business flow is missing from BPMN component rows for this model.');
    if (!objectValidation.hasCapabilities) reasons.push('At least one associated business capability is required.');
    if (metadataValidation.invalidFields.length) {
      reasons.push(`Invalid metadata fields: ${metadataValidation.invalidFields.map((field) => `${field.label}="${field.value}"`).join(', ')}`);
    }
    if (objectValidation.invalidTasks.length) reasons.push(`Invalid tasks: ${objectValidation.invalidTasks.length}`);
    if (objectValidation.invalidApplications.length) reasons.push(`Invalid applications: ${objectValidation.invalidApplications.length}`);
    if (objectValidation.invalidActors.length) reasons.push(`Invalid actors: ${objectValidation.invalidActors.length}`);

    return res.json({
      isValid,
      neighborhoodName,
      diagramName: diagramLike.name || null,
      businessFlow: mergedMeta.businessFlow || null,
      summary: {
        hasBusinessFlowReference,
        hasCapabilities: objectValidation.hasCapabilities,
        metadataInvalidFieldCount: metadataValidation.invalidFields.length,
        invalidTaskCount: objectValidation.invalidTasks.length,
        invalidApplicationCount: objectValidation.invalidApplications.length,
        invalidActorCount: objectValidation.invalidActors.length,
      },
      reasons,
      details: {
        metadataInvalidFields: metadataValidation.invalidFields,
        invalidTasks: objectValidation.invalidTasks,
        invalidApplications: objectValidation.invalidApplications,
        invalidActors: objectValidation.invalidActors,
      },
      debug: {
        invalidTaskNormalized: objectValidation.invalidTasks.slice(0, 25).map((name) => normalizeObjectMatchValue(name)),
        invalidApplicationNormalized: objectValidation.invalidApplications.slice(0, 25).map((name) => normalizeObjectMatchValue(name)),
      },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/diagrams — list all (Viewers only see published)
router.get('/', async (req, res) => {
  try {
    const role = req.currentUser?.role;
    const currentUserId = req.currentUser?.userId;
    const neighborhoodName = getNeighborhoodName(req);
    // A restricted (Viewer/unassigned-role) session only sees published
    // diagrams — but ALWAYS sees its own, regardless of status. Otherwise a
    // diagram you just created (which starts as "Draft") is invisible to
    // its own creator until someone else publishes it.
    const filter = (!role || role === 'Viewer')
      ? {
          $and: [
            buildNeighborhoodFilter(neighborhoodName),
            currentUserId ? { $or: [{ status: 'published' }, { createdBy: currentUserId }] } : { status: 'published' },
          ],
        }
      : buildNeighborhoodFilter(neighborhoodName);
    const diagrams = await Diagram.find(filter).sort({ updatedAt: -1 }).lean();
    const hydratedDiagrams = diagrams.map((diagram) => {
      const metadata = parseDiagramMetadata(diagram.xml);
      const lineOfBusiness = diagram.lineOfBusiness || metadata.lineOfBusiness || null;
      const channel = diagram.channel || metadata.channel || null;
      const hydrated = {
        ...diagram,
        lineOfBusiness,
        channel,
        product: diagram.product || metadata.product || null,
        domain: diagram.domain || metadata.domain || null,
        subdomain: diagram.subdomain || metadata.subdomain || null,
        businessCapability: diagram.businessCapability || metadata.businessCapability || null,
        valueStream: diagram.valueStream || metadata.valueStream || null,
        journey: diagram.journey || metadata.journey || null,
        businessFlow: diagram.businessFlow || metadata.businessFlow || null,
      };
      if (!diagram.lineOfBusiness && lineOfBusiness) hydrated.lineOfBusiness = lineOfBusiness;
      if (!diagram.channel && channel) hydrated.channel = channel;
      delete hydrated.xml;
      return hydrated;
    });
    res.json(hydratedDiagrams);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/diagrams/flow-breadcrumbs?names=Flow+A,Flow+B — returns breadcrumb metadata per flow name
router.get('/flow-breadcrumbs', async (req, res) => {
  try {
    const rawNames = req.query.names;
    if (!rawNames) return res.json([]);
    const names = String(rawNames).split(',').map(n => n.trim()).filter(Boolean);
    if (!names.length) return res.json([]);
    const docs = await Diagram.find(
      { $and: [buildNeighborhoodFilter(getNeighborhoodName(req)), { businessFlow: { $in: names } }] },
      { businessFlow: 1, businessCapability: 1, valueStream: 1, journey: 1, lineOfBusiness: 1, channel: 1, product: 1, domain: 1, subdomain: 1 }
    ).lean();
    // De-dupe: keep one record per businessFlow name
    const seen = new Set();
    const result = [];
    for (const d of docs) {
      if (!d.businessFlow || seen.has(d.businessFlow)) continue;
      seen.add(d.businessFlow);
      result.push({
        name: d.businessFlow,
        businessCapability: d.businessCapability || null,
        valueStream: d.valueStream || null,
        journey: d.journey || null,
        lineOfBusiness: d.lineOfBusiness || null,
        channel: d.channel || null,
        product: d.product || null,
        domain: d.domain || null,
        subdomain: d.subdomain || null,
      });
    }
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/diagrams/business-flow-map — returns { flowName: diagramId } for all diagrams with a businessFlow
router.get('/business-flow-map', async (req, res) => {
  try {
    const docs = await Diagram.find({ $and: [buildNeighborhoodFilter(getNeighborhoodName(req)), { businessFlow: { $ne: null } }] }, { businessFlow: 1 }).lean();
    const map = {};
    for (const d of docs) {
      if (d.businessFlow) map[d.businessFlow] = d._id.toString();
    }
    res.json(map);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/diagrams/search?q=term — full-text + regex fallback search
router.get('/search', async (req, res) => {
  const { q } = req.query;
  if (!q || !q.trim()) {
    return res.status(400).json({ error: 'Query parameter "q" is required.' });
  }
  const role = req.currentUser?.role;
  const currentUserId = req.currentUser?.userId;
  const isViewer = !role || role === 'Viewer';
  // Same "always see your own, even if unpublished" carve-out as the plain
  // list route — otherwise a diagram you just created (status "Draft") is
  // unsearchable by its own creator.
  const visibilityFilter = currentUserId ? { $or: [{ status: 'published' }, { createdBy: currentUserId }] } : { status: 'published' };
  const neighborhoodName = getNeighborhoodName(req);
  try {
    // Try full-text search first
    const textFilter = isViewer
      ? { $and: [buildNeighborhoodFilter(neighborhoodName), { $text: { $search: q.trim() } }, visibilityFilter] }
      : { $and: [buildNeighborhoodFilter(neighborhoodName), { $text: { $search: q.trim() } }] };
    let results = await Diagram.find(
      textFilter,
      { score: { $meta: 'textScore' }, xml: 0 }
    ).sort({ score: { $meta: 'textScore' } });
    // Fallback to regex (partial/prefix match) if text search yields nothing
    if (!results.length) {
      const escaped = q.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const regex = new RegExp(escaped, 'i');
      const orConditions = [{ name: regex }, { businessFlow: regex }, { businessCapability: regex }, { valueStream: regex }, { journey: regex }, { lineOfBusiness: regex }, { domain: regex }, { subdomain: regex }, { product: regex }, { channel: regex }, { status: regex }, { createdBy: regex }, { 'tasks.name': regex }];
      const regexFilter = isViewer
        ? { $and: [buildNeighborhoodFilter(neighborhoodName), { $or: orConditions }, visibilityFilter] }
        : { $and: [buildNeighborhoodFilter(neighborhoodName), { $or: orConditions }] };
      results = await Diagram.find(regexFilter, { xml: 0 }).limit(50);
    }
    res.json(results);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/diagrams/:id — get single diagram with XML
router.get('/:id', async (req, res) => {
  try {
    const diagram = await Diagram.findOne({ $and: [buildNeighborhoodFilter(getNeighborhoodName(req)), { _id: req.params.id }] });
    if (!diagram) return res.status(404).json({ error: 'Diagram not found.' });
    res.json(diagram);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/diagrams — create new diagram
router.post('/', async (req, res) => {
  const {
    name, description, xml, tags, capabilities, status, sourcedFrom, createdBy,
    lineOfBusiness, channel, domain, subdomain, product, valueStream, journey, businessCapability, businessFlow,
    // Set by the "New Diagram" dialog: this is a brand-new, still-blank
    // canvas, so build it fresh with buildBpmnXmlForFlow (same builder the
    // load/generation pipeline uses) instead of persisting the client's
    // bare bpmn-js default — gives it a proper lane, a start event clear of
    // the lane label, everything left-justified from LANE_X, and the
    // standard title-annotation breadcrumb, rather than a lane-less shape
    // floating in the middle of the canvas.
    generateSkeleton,
  } = req.body;
  if (!name || !xml) {
    return res.status(400).json({ error: 'Fields "name" and "xml" are required.' });
  }
  try {
    // A caller (e.g. the "New Diagram" dialog) can supply hierarchy metadata
    // directly instead of relying on it being encoded in the XML's title
    // annotation — explicit values win; anything not supplied falls back to
    // whatever parseDiagramMetadata found in the XML.
    const explicitMeta = { lineOfBusiness, channel, domain, subdomain, product, valueStream, journey, businessCapability, businessFlow };
    const parsedMeta = parseDiagramMetadata(xml);
    const meta = { ...parsedMeta };
    for (const [key, value] of Object.entries(explicitMeta)) {
      if (value !== undefined && value !== null && String(value).trim()) meta[key] = value;
    }
    const hintedNeighborhoodName = getNeighborhoodName(req);
    // Use the caller-supplied name; meta.businessFlow is informational metadata only
    const diagramName = name;
    const sourceXml = generateSkeleton
      ? buildBpmnXmlForFlow({
          flowName: meta.businessFlow || diagramName,
          breadcrumb: buildMetadataBreadcrumb({ ...meta, businessFlow: meta.businessFlow || diagramName }),
          tasks: [],
        }).xml
      // Any other create (a locally-loaded file, an old-style prompt, etc.)
      // still gets the same lane/left-justify treatment applied to whatever
      // was actually drawn, without touching its flow logic.
      : applyGeneratedDiagramFormatting(xml);
    const cleanXml = stripTitleAnnotations(sourceXml);
    const tasks = extractTasks(sourceXml);
    const resolvedStatus = sourcedFrom
      ? (status || 'staged')
      : await resolveImportedDiagramStatus(
          status,
          sourcedFrom,
          meta.businessFlow || diagramName,
          hintedNeighborhoodName,
          await validateDiagramMetadataForNeighborhood(meta, hintedNeighborhoodName),
          {
            name: diagramName,
            businessFlow: meta.businessFlow || diagramName,
            xml: cleanXml,
            tasks,
            capabilities: Array.isArray(capabilities) ? capabilities : [],
          }
        );
    const diagram = await Diagram.create({
      name: diagramName, description, xml: cleanXml, tags, capabilities, tasks,
      status: resolvedStatus,
      neighborhoodName: hintedNeighborhoodName,
      sourcedFrom: sourcedFrom || null,
      createdBy: createdBy || null,
      updatedBy: createdBy || null,
      ...meta,
    });
    const diagramMetaForSync = {
      businessFlow: diagram.businessFlow || diagramName,
      lineOfBusiness: diagram.lineOfBusiness,
      channel: diagram.channel,
      domain: diagram.domain,
      subdomain: diagram.subdomain,
      product: diagram.product,
      valueStream: diagram.valueStream,
      journey: diagram.journey,
      businessCapability: diagram.businessCapability,
    };
    // Run all three syncs before rebuilding the search index ONCE — each one
    // firing its own concurrent rebuild raced the others (all hitting the
    // same collection's delete-then-reinsert cycle at once) and could leave
    // the index missing whatever the last-finishing rebuild's stale
    // in-flight snapshot didn't yet include.
    const flowChanged = await syncDiagramFlowToBusinessFlowFactory(hintedNeighborhoodName, diagramMetaForSync);
    const tasksChanged = await syncDiagramTasksToTaskFactory(hintedNeighborhoodName, diagramMetaForSync, diagram.xml);
    const appsChanged = await syncDiagramApplicationsToApplicationFactory(hintedNeighborhoodName, diagramMetaForSync, diagram.tasks);
    if (flowChanged || tasksChanged || appsChanged) {
      rebuildSearchIndex(hintedNeighborhoodName).catch((err) => {
        console.error('[DIAGRAM SYNC] search index rebuild failed:', err && err.message);
      });
    }
    res.status(201).json(diagram);
  } catch (err) {
    console.error('POST /api/diagrams failed', {
      neighborhoodName: getNeighborhoodName(req),
      name: req.body?.name,
      code: err?.code,
      errorName: err?.name,
      message: err?.message,
      stack: err?.stack,
    });
    if (err?.code === 11000) {
      return res.status(409).json({
        error: `A diagram named "${name}" already exists in model "${getNeighborhoodName(req)}".`,
      });
    }
    if (err?.name === 'ValidationError') {
      return res.status(400).json({ error: err.message });
    }
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/diagrams/:id — update diagram
router.put('/:id', async (req, res) => {
  const {
    name, description, xml, tags, capabilities, changeNote, status, sourcedFrom, updatedBy,
    lineOfBusiness, channel, domain, subdomain, product, valueStream, journey, businessCapability, businessFlow,
  } = req.body;
  try {
    const neighborhoodName = getNeighborhoodName(req);
    const existing = await Diagram.findOne({ $and: [buildNeighborhoodFilter(neighborhoodName), { _id: req.params.id }] });
    if (!existing) return res.status(404).json({ error: 'Diagram not found.' });

    const $set = {};
    if (name !== undefined) $set.name = name;
    if (description !== undefined) $set.description = description;
    if (status !== undefined) $set.status = status;
    if (sourcedFrom !== undefined) $set.sourcedFrom = sourcedFrom;
    if (updatedBy !== undefined) $set.updatedBy = updatedBy;
    if (xml !== undefined) {
      // Same lane/left-justify treatment as on create — ensures a diagram
      // that started life without a lane (or drifted off the left margin)
      // gets reformatted every time it's saved, not just once at creation.
      const formattedXml = applyGeneratedDiagramFormatting(xml);
      $set.xml = stripTitleAnnotations(formattedXml);
      // Re-parse metadata from updated XML, but let explicit body fields
      // (e.g. from the "New Diagram" dialog) win over whatever's encoded in
      // the XML's title annotation, same precedence as on create.
      const parsedMeta = parseDiagramMetadata(xml);
      const explicitMeta = { lineOfBusiness, channel, domain, subdomain, product, valueStream, journey, businessCapability, businessFlow };
      const pick = (key) => {
        const explicitValue = explicitMeta[key];
        if (explicitValue !== undefined && explicitValue !== null && String(explicitValue).trim()) return explicitValue;
        return parsedMeta[key] || null;
      };
      $set.lineOfBusiness = pick('lineOfBusiness');
      $set.channel = pick('channel');
      $set.domain = pick('domain');
      $set.subdomain = pick('subdomain');
      $set.product = pick('product');
      $set.valueStream = pick('valueStream');
      $set.journey = pick('journey');
      $set.businessCapability = pick('businessCapability');
      $set.businessFlow = pick('businessFlow');
      // Extract tasks with source/target/applications
      $set.tasks = extractTasks(formattedXml);
    }
    if (tags !== undefined) $set.tags = tags;
    if (capabilities !== undefined) $set.capabilities = capabilities;

    const currentStatus = String(existing.status || '').toLowerCase();
    const shouldReevaluateStatus = status === undefined
      && ['invalid', 'staged'].includes(currentStatus);

    if (shouldReevaluateStatus) {
      const nextName = $set.name !== undefined ? $set.name : existing.name;
      const nextXml = $set.xml !== undefined ? $set.xml : existing.xml;
      const nextTasks = $set.tasks !== undefined ? $set.tasks : (existing.tasks || []);
      const nextCapabilities = $set.capabilities !== undefined ? $set.capabilities : (existing.capabilities || []);
      const nextBusinessFlow = $set.businessFlow !== undefined ? $set.businessFlow : existing.businessFlow;
      const nextSourcedFrom = $set.sourcedFrom !== undefined ? $set.sourcedFrom : existing.sourcedFrom;

      const nextMeta = {
        lineOfBusiness: $set.lineOfBusiness !== undefined ? $set.lineOfBusiness : existing.lineOfBusiness,
        channel: $set.channel !== undefined ? $set.channel : existing.channel,
        domain: $set.domain !== undefined ? $set.domain : existing.domain,
        subdomain: $set.subdomain !== undefined ? $set.subdomain : existing.subdomain,
        product: $set.product !== undefined ? $set.product : existing.product,
        businessFlow: nextBusinessFlow || nextName,
      };
      const metadataValidationSummary = await validateDiagramMetadataForNeighborhood(nextMeta, neighborhoodName);

      const targetValidStatus = 'staged';
      $set.status = await resolveImportedDiagramStatus(
        existing.status,
        nextSourcedFrom,
        nextBusinessFlow || nextName,
        neighborhoodName,
        metadataValidationSummary,
        {
          name: nextName,
          businessFlow: nextBusinessFlow || nextName,
          xml: nextXml,
          tasks: nextTasks,
          capabilities: nextCapabilities,
        },
        targetValidStatus
      );
    }

    const update = { $set, $inc: { version: 1 } };

    // Append change note to history
    if (changeNote) {
      update.$push = {
        changeHistory: {
          date: new Date(),
          userId: changeNote.userId,
          note: changeNote.note,
        },
      };
    }

    const diagram = await Diagram.findOneAndUpdate(
      { $and: [buildNeighborhoodFilter(neighborhoodName), { _id: req.params.id }] },
      update,
      { new: true, runValidators: true }
    );
    if (!diagram) return res.status(404).json({ error: 'Diagram not found.' });
    if (xml !== undefined) {
      const diagramMetaForSync = {
        businessFlow: diagram.businessFlow || diagram.name,
        lineOfBusiness: diagram.lineOfBusiness,
        channel: diagram.channel,
        domain: diagram.domain,
        subdomain: diagram.subdomain,
        product: diagram.product,
        valueStream: diagram.valueStream,
        journey: diagram.journey,
        businessCapability: diagram.businessCapability,
      };
      const flowChanged = await syncDiagramFlowToBusinessFlowFactory(neighborhoodName, diagramMetaForSync);
      const tasksChanged = await syncDiagramTasksToTaskFactory(neighborhoodName, diagramMetaForSync, diagram.xml);
      const appsChanged = await syncDiagramApplicationsToApplicationFactory(neighborhoodName, diagramMetaForSync, diagram.tasks);
      if (flowChanged || tasksChanged || appsChanged) {
        rebuildSearchIndex(neighborhoodName).catch((err) => {
          console.error('[DIAGRAM SYNC] search index rebuild failed:', err && err.message);
        });
      }
    }
    res.json(diagram);
  } catch (err) {
    console.error('PUT /api/diagrams/:id failed', {
      id: req.params?.id,
      neighborhoodName: getNeighborhoodName(req),
      name: req.body?.name,
      code: err?.code,
      errorName: err?.name,
      message: err?.message,
      stack: err?.stack,
    });
    if (err?.code === 11000) {
      return res.status(409).json({
        error: `A diagram named "${name}" already exists in model "${getNeighborhoodName(req)}".`,
      });
    }
    if (err?.name === 'ValidationError') {
      return res.status(400).json({ error: err.message });
    }
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/diagrams/:id — delete diagram
// DELETE /api/diagrams/:id?cascadeComponent=true — also deletes the diagram's
// own Business Process Flow component row (and rebuilds the search index so
// nothing stale is left behind referencing it). Plain delete (no query flag)
// keeps its original diagram-only behavior — used elsewhere (e.g. the
// editor's "revert" flow, which deletes then immediately recreates a
// diagram) where touching the component row would be wrong.
router.delete('/:id', async (req, res) => {
  try {
    const diagram = await Diagram.findOneAndDelete({ $and: [buildNeighborhoodFilter(getNeighborhoodName(req)), { _id: req.params.id }] });
    if (!diagram) return res.status(404).json({ error: 'Diagram not found.' });

    const cascadeComponent = String(req.query?.cascadeComponent || '').trim().toLowerCase() === 'true';
    let componentDeleted = false;
    if (cascadeComponent) {
      const neighborhoodName = diagram.neighborhoodName;
      const flowName = String(diagram.businessFlow || diagram.name || '').trim();
      if (neighborhoodName && flowName) {
        try {
          const canonicalDeletion = await CanonicalComponent.deleteMany({
            neighborhoodName,
            componentType: { $regex: /^business\s*(process\s*)?flow$/i },
            primaryKey: { $regex: `^${escapeRegExp(flowName)}$`, $options: 'i' },
          });
          const legacyFactory = await Component.findOne({ neighborhoodName, name: { $regex: /^business\s*(process\s*)?flow$/i } });
          let legacyDeletedCount = 0;
          if (legacyFactory) {
            const before = legacyFactory.rows.length;
            legacyFactory.rows = legacyFactory.rows.filter(
              (row) => String(row.values?.get?.('name') || '').trim().toLowerCase() !== flowName.toLowerCase()
            );
            legacyDeletedCount = before - legacyFactory.rows.length;
            if (legacyDeletedCount) await legacyFactory.save();
          }
          componentDeleted = canonicalDeletion.deletedCount > 0 || legacyDeletedCount > 0;

          if (componentDeleted) {
            rebuildSearchIndex(neighborhoodName).catch((err) => {
              console.error('[DELETE DIAGRAM] search index rebuild failed:', err && err.message);
            });
          }
        } catch (cascadeErr) {
          // The diagram is already gone — don't fail the whole request over
          // a best-effort cleanup step; report it so the caller can retry.
          console.error('[DELETE DIAGRAM] Failed to cascade-delete the Business Process Flow component:', cascadeErr && cascadeErr.message);
          return res.json({ message: 'Diagram deleted, but the linked component could not be removed.', componentDeleted: false, componentError: cascadeErr.message });
        }
      }
    }

    res.json({
      message: componentDeleted ? 'Diagram and Business Process Flow component deleted.' : 'Diagram deleted.',
      componentDeleted,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/diagrams/batch — batch import multiple diagrams with status "Staged"
router.post('/batch', async (req, res) => {
  const { files, createdBy } = req.body;
  if (!Array.isArray(files) || !files.length) {
    return res.status(400).json({ error: 'Array of files is required.' });
  }
  const results = { success: [], failed: [] };
  const hintedNeighborhoodName = getNeighborhoodName(req);
  for (const file of files) {
    try {
      const { xml, fileName } = file;
      if (!xml) {
        results.failed.push({ fileName, error: 'No XML content' });
        continue;
      }
      const meta = parseDiagramMetadata(xml);
      const resolvedNeighborhood = await resolveDiagramNeighborhood(meta, hintedNeighborhoodName);
      const name = meta.businessFlow || fileName?.replace(/\.bpmn$/i, '').replace(/\.xml$/i, '') || 'Untitled';
      const cleanXml = stripTitleAnnotations(xml);
      const tasks = extractTasks(xml);
      const diagram = await Diagram.create({
        neighborhoodName: resolvedNeighborhood.neighborhoodName,
        name,
        xml: cleanXml,
        tasks,
        status: 'staged',
        sourcedFrom: fileName || null,
        createdBy: createdBy || null,
        updatedBy: createdBy || null,
        ...meta,
      });
      results.success.push({ _id: diagram._id, name: diagram.name, fileName, status: diagram.status, neighborhoodName: diagram.neighborhoodName });
    } catch (err) {
      results.failed.push({ fileName: file.fileName, error: err.message });
    }
  }
  res.status(201).json(results);
});

module.exports = router;
