// Automatically generates a BPMN 2.0 diagram (persisted in the `diagrams` collection) for
// every Business Process Flow in a model, whenever Model Components are loaded. Runs as part
// of the materializer's post-process step (see materializer.js), after parentRefs/childrenRefs
// have been resolved on the canonical components.
//
// Only runs when the model's canonical components include the required flow types: Business
// Process Flow, Task, and Application. Business Capability is optional; if present it is used
// for lineage metadata, but its absence no longer blocks diagram generation.

const CanonicalComponent = require('../models/CanonicalComponent');
const Diagram = require('../models/Diagram');
const { buildBpmnXmlForFlow } = require('./bpmnXmlBuilder');

const REQUIRED_TYPES = ['Business Process Flow', 'Task', 'Application'];
const BUSINESS_FLOW_TYPE = /^business\s*process\s*flow$/i;
const SOURCED_FROM = 'BPMN Automation';

function typeMatches(componentType, name) {
  const normalize = (value) => String(value || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '');
  return normalize(componentType) === normalize(name);
}

async function getFlowLineage(flowDoc) {
  const lineage = {
    lineOfBusiness: null,
    channel: null,
    product: null,
    valueStream: null,
    journey: null,
    businessCapability: null,
    subdomain: null,
    domain: null,
  };
  const breadcrumbParts = [`Business Flow: ${flowDoc.values?.name || flowDoc.primaryKey}`];

  let currentRefs = flowDoc.parentRefs || [];
  const seen = new Set([String(flowDoc._id)]);
  for (let hop = 0; hop < 6 && currentRefs.length; hop += 1) {
    const parentId = currentRefs[0];
    if (!parentId || seen.has(String(parentId))) break;
    seen.add(String(parentId));
    const parent = await CanonicalComponent.findById(parentId, { componentType: 1, primaryKey: 1, 'values.name': 1, parentRefs: 1 }).lean();
    if (!parent) break;
    const parentName = parent.values?.name || parent.primaryKey;
    breadcrumbParts.unshift(`${parent.componentType}: ${parentName}`);
    if (typeMatches(parent.componentType, 'Line of Business')) lineage.lineOfBusiness = parentName;
    else if (typeMatches(parent.componentType, 'Channel')) lineage.channel = parentName;
    else if (typeMatches(parent.componentType, 'Product')) lineage.product = parentName;
    else if (typeMatches(parent.componentType, 'Value Stream')) lineage.valueStream = parentName;
    else if (typeMatches(parent.componentType, 'Journey')) lineage.journey = parentName;
    else if (typeMatches(parent.componentType, 'Business Capability')) lineage.businessCapability = parentName;
    else if (typeMatches(parent.componentType, 'Subdomain')) lineage.subdomain = parentName;
    else if (typeMatches(parent.componentType, 'Domain')) lineage.domain = parentName;
    currentRefs = parent.parentRefs || [];
  }

  return { ...lineage, breadcrumb: breadcrumbParts.join(' | ') };
}

async function generateDiagramForFlow(neighborhoodName, flow) {
  const flowName = flow.values?.name || flow.primaryKey;
  const taskIds = flow.childrenRefs || [];
  if (!taskIds.length) return { status: 'skipped', flowName, reason: 'no tasks' };

  const taskDocs = await CanonicalComponent.find({ _id: { $in: taskIds } }).lean();
  const taskById = new Map(taskDocs.map((t) => [String(t._id), t]));
  const orderedTasks = taskIds.map((id) => taskById.get(String(id))).filter(Boolean);
  if (!orderedTasks.length) return { status: 'skipped', flowName, reason: 'no tasks' };

  const allAppIds = Array.from(new Set(orderedTasks.flatMap((t) => (t.childrenRefs || []).map(String))));
  const appDocs = allAppIds.length ? await CanonicalComponent.find({ _id: { $in: allAppIds } }).lean() : [];
  const appNameById = new Map(appDocs.map((a) => [String(a._id), a.values?.name || a.primaryKey]));

  const tasks = orderedTasks.map((t) => ({
    name: t.values?.name || t.primaryKey,
    bpmnType: t.values?.bpmn_task_qualifier,
    actor: t.values?.actor_qualifier,
    applications: (t.childrenRefs || []).map((id) => appNameById.get(String(id))).filter(Boolean),
  }));

  const { breadcrumb, lineOfBusiness, channel, product, valueStream, journey, businessCapability, domain, subdomain } = await getFlowLineage(flow);
  const { xml } = buildBpmnXmlForFlow({ flowName, breadcrumb, tasks });

  const diagramTasks = tasks.map((t, i) => ({
    name: t.name,
    source: i > 0 ? tasks[i - 1].name : null,
    target: i < tasks.length - 1 ? tasks[i + 1].name : null,
    actor: t.actor || null,
    applications: t.applications.map((name) => ({ name })),
  }));

  const existing = await Diagram.findOne({ neighborhoodName, name: flowName }, { sourcedFrom: 1 }).lean();
  if (existing && existing.sourcedFrom !== SOURCED_FROM) {
    // A manually-created (or differently-sourced) diagram already owns this name — don't clobber it.
    return { status: 'conflict', flowName };
  }

  await Diagram.findOneAndUpdate(
    { neighborhoodName, name: flowName },
    {
      $set: {
        neighborhoodName,
        name: flowName,
        description: `Auto-generated from Business Process Flow "${flowName}".`,
        xml,
        tags: Array.from(new Set(['BPMN Automation', businessCapability].filter(Boolean))),
        tasks: diagramTasks,
        lineOfBusiness: lineOfBusiness || null,
        channel: channel || null,
        product: product || null,
        valueStream: valueStream || null,
        journey: journey || null,
        domain: domain || null,
        subdomain: subdomain || null,
        businessFlow: flowName,
        businessCapability: businessCapability || null,
        sourcedFrom: SOURCED_FROM,
        updatedBy: SOURCED_FROM,
        status: 'published',
      },
      $setOnInsert: { createdBy: SOURCED_FROM, version: 1 },
    },
    { upsert: true }
  );

  return { status: existing ? 'updated' : 'created', flowName };
}

/**
 * @param {Object} params
 * @param {string} params.neighborhoodName
 * @returns {Promise<{ skipped: boolean, reason?: string, missing?: string[], created?: number, updated?: number, conflicts?: number, failed?: number, total?: number }>}
 */
async function generateFlowDiagramsForNeighborhood({ neighborhoodName } = {}) {
  if (!neighborhoodName) return { skipped: true, reason: 'no neighborhoodName' };

  const presentTypes = await CanonicalComponent.distinct('componentType', { neighborhoodName });
  const presentSet = new Set(presentTypes.map((t) => String(t || '').trim().toLowerCase()));
  const missing = REQUIRED_TYPES.filter((t) => !presentSet.has(t.toLowerCase()));
  if (missing.length) {
    console.log(`[BPMN AUTOMATION] Skipping diagram generation for "${neighborhoodName}" — missing component type(s): ${missing.join(', ')}`);
    return { skipped: true, reason: 'missing-types', missing };
  }

  const flows = await CanonicalComponent.find({ neighborhoodName, componentType: BUSINESS_FLOW_TYPE }).lean();
  let created = 0;
  let updated = 0;
  let conflicts = 0;
  let failed = 0;

  for (const flow of flows) {
    try {
      const result = await generateDiagramForFlow(neighborhoodName, flow);
      if (result.status === 'created') created += 1;
      else if (result.status === 'updated') updated += 1;
      else if (result.status === 'conflict') {
        conflicts += 1;
        console.warn(`[BPMN AUTOMATION] Skipped "${result.flowName}" — a non-automated diagram already uses that name in "${neighborhoodName}"`);
      }
    } catch (err) {
      failed += 1;
      console.error('[BPMN AUTOMATION] Failed to generate diagram for flow', flow?.primaryKey, err && err.message);
    }
  }

  console.log(`[BPMN AUTOMATION] Diagram generation for "${neighborhoodName}": ${created} created, ${updated} updated, ${conflicts} conflicts, ${failed} failed (${flows.length} flows total)`);
  return { skipped: false, created, updated, conflicts, failed, total: flows.length };
}

module.exports = { generateFlowDiagramsForNeighborhood };
