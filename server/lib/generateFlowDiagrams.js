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
const MAX_LINEAGE_HOPS = 12;

function typeMatches(componentType, name) {
  const normalize = (value) => String(value || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '');
  return normalize(componentType) === normalize(name);
}

async function getFlowLineageBranches(flowDoc) {
  const emptyLineage = {
    lineOfBusiness: null,
    channel: null,
    product: null,
    valueStream: null,
    journey: null,
    businessCapability: null,
    subdomain: null,
    domain: null,
  };
  const flowName = flowDoc.values?.name || flowDoc.primaryKey;
  const baseBreadcrumb = `Business Flow: ${flowName}`;
  const parentCache = new Map();

  const loadParent = async (parentId) => {
    const key = String(parentId || '').trim();
    if (!key) return null;
    if (!parentCache.has(key)) {
      parentCache.set(
        key,
        CanonicalComponent.findById(key, { componentType: 1, primaryKey: 1, 'values.name': 1, parentRefs: 1 }).lean().exec()
      );
    }
    return parentCache.get(key);
  };

  const applyParentToLineage = (lineage, parent) => {
    const parentName = parent.values?.name || parent.primaryKey;
    if (typeMatches(parent.componentType, 'Line of Business')) lineage.lineOfBusiness = parentName;
    else if (typeMatches(parent.componentType, 'Channel')) lineage.channel = parentName;
    else if (typeMatches(parent.componentType, 'Product')) lineage.product = parentName;
    else if (typeMatches(parent.componentType, 'Value Stream')) lineage.valueStream = parentName;
    else if (typeMatches(parent.componentType, 'Journey')) lineage.journey = parentName;
    else if (typeMatches(parent.componentType, 'Business Capability')) lineage.businessCapability = parentName;
    else if (typeMatches(parent.componentType, 'Subdomain')) lineage.subdomain = parentName;
    else if (typeMatches(parent.componentType, 'Domain')) lineage.domain = parentName;
  };

  // Walks a SINGLE path upward from `startParent`, always taking the first
  // not-yet-visited parent at each subsequent level. This intentionally does not
  // branch on shared ancestor nodes (Value Stream/Journey/Product/Channel/etc.)
  // to avoid the combinatorial explosion those shared nodes would otherwise cause.
  const walkSinglePath = async (startParent, seen) => {
    const lineage = { ...emptyLineage };
    const breadcrumbParts = [];
    let current = startParent;
    let currentSeen = seen;
    let depth = 0;

    while (current && depth < MAX_LINEAGE_HOPS) {
      applyParentToLineage(lineage, current);
      const parentName = current.values?.name || current.primaryKey;
      breadcrumbParts.unshift(`${current.componentType}: ${parentName}`);

      const nextParentId = (current.parentRefs || [])
        .map((ref) => String(ref || '').trim())
        .find((id) => id && !currentSeen.has(id));
      if (!nextParentId) break;

      currentSeen = new Set(currentSeen);
      currentSeen.add(nextParentId);
      current = await loadParent(nextParentId);
      depth += 1;
    }

    return { lineage, breadcrumbParts };
  };

  // Branch only on the flow's OWN direct parents. In practice this is almost
  // always exactly one (Business Capability); a handful of flow names are
  // legitimately reused under more than one Business Capability, and those get
  // one branch per direct parent — bounded by the flow's own parent count, not
  // by the size of the shared ancestor graph above it.
  const directParentIds = Array.from(new Set((flowDoc.parentRefs || []).map((ref) => String(ref || '').trim()).filter(Boolean)));
  const rootSeen = new Set([String(flowDoc._id)]);

  const branches = [];
  for (const parentId of directParentIds) {
    const parent = await loadParent(parentId);
    if (!parent) continue;
    const nextSeen = new Set(rootSeen);
    nextSeen.add(parentId);
    const { lineage, breadcrumbParts } = await walkSinglePath(parent, nextSeen);
    branches.push({ lineage, breadcrumb: [...breadcrumbParts, baseBreadcrumb].join(' | ') });
  }
  if (!branches.length) {
    branches.push({ lineage: { ...emptyLineage }, breadcrumb: baseBreadcrumb });
  }

  // If the flow's own row(s) captured literal per-row lineage snapshots at upload
  // time (see buildLineageSnapshot in customFactories.js), those snapshots are the
  // unambiguous ground truth for whichever branch they came from. Match each
  // branch to the variant with the same businessCapability (falling back to the
  // single legacy `__lineage` field for data materialized before variants existed),
  // and apply it as a full override so that branch's journey/valueStream/domain/etc.
  // are corrected too, not just its businessCapability.
  const values = flowDoc.values && typeof flowDoc.values === 'object' ? flowDoc.values : null;
  const lineageVariants = Array.isArray(values?.__lineageVariants) && values.__lineageVariants.length
    ? values.__lineageVariants
    : (values?.__lineage ? [values.__lineage] : []);
  const usedVariantIndexes = new Set();
  return branches.map((branch) => {
    const resolvedLineage = { ...branch.lineage };
    let variantIndex = lineageVariants.findIndex(
      (variant, idx) => !usedVariantIndexes.has(idx) && variant?.businessCapability && variant.businessCapability === branch.lineage.businessCapability
    );
    if (variantIndex === -1 && branches.length === 1) {
      variantIndex = lineageVariants.findIndex((_variant, idx) => !usedVariantIndexes.has(idx));
    }
    if (variantIndex !== -1) {
      usedVariantIndexes.add(variantIndex);
      const variant = lineageVariants[variantIndex];
      for (const key of Object.keys(emptyLineage)) {
        if (variant[key]) resolvedLineage[key] = variant[key];
      }
    }
    return { lineage: resolvedLineage, breadcrumb: branch.breadcrumb };
  });
}

async function generateDiagramForFlow(neighborhoodName, flow) {
  const flowName = flow.values?.name || flow.primaryKey;
  const taskIds = flow.childrenRefs || [];
  if (!taskIds.length) return [{ status: 'skipped', flowName, reason: 'no tasks' }];

  const taskDocs = await CanonicalComponent.find({ _id: { $in: taskIds } }).lean();
  const taskById = new Map(taskDocs.map((t) => [String(t._id), t]));
  const orderedTasks = taskIds.map((id) => taskById.get(String(id))).filter(Boolean);
  if (!orderedTasks.length) return [{ status: 'skipped', flowName, reason: 'no tasks' }];

  const allAppIds = Array.from(new Set(orderedTasks.flatMap((t) => (t.childrenRefs || []).map(String))));
  const appDocs = allAppIds.length ? await CanonicalComponent.find({ _id: { $in: allAppIds } }).lean() : [];
  const appNameById = new Map(appDocs.map((a) => [String(a._id), a.values?.name || a.primaryKey]));

  const tasks = orderedTasks.map((t) => ({
    name: t.values?.name || t.primaryKey,
    bpmnType: t.values?.bpmn_task_qualifier,
    actor: t.values?.actor_qualifier,
    applications: (t.childrenRefs || []).map((id) => appNameById.get(String(id))).filter(Boolean),
  }));

  const diagramTasks = tasks.map((t, i) => ({
    name: t.name,
    source: i > 0 ? tasks[i - 1].name : null,
    target: i < tasks.length - 1 ? tasks[i + 1].name : null,
    actor: t.actor || null,
    applications: t.applications.map((name) => ({ name })),
  }));

  const branches = await getFlowLineageBranches(flow);
  const results = [];

  for (let index = 0; index < branches.length; index += 1) {
    const { breadcrumb, lineage } = branches[index];
    const { lineOfBusiness, channel, product, valueStream, journey, businessCapability, domain, subdomain } = lineage;
    const diagramName = branches.length === 1
      ? flowName
      : `${flowName} (${businessCapability || journey || valueStream || `Variant ${index + 1}`})`;

    const { xml } = buildBpmnXmlForFlow({ flowName: diagramName, breadcrumb, tasks });

    const existing = await Diagram.findOne({ neighborhoodName, name: diagramName }, { sourcedFrom: 1 }).lean();
    if (existing && existing.sourcedFrom !== SOURCED_FROM) {
      // A manually-created (or differently-sourced) diagram already owns this name — don't clobber it.
      results.push({ status: 'conflict', flowName: diagramName });
      continue;
    }

    await Diagram.findOneAndUpdate(
      { neighborhoodName, name: diagramName },
      {
        $set: {
          neighborhoodName,
          name: diagramName,
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

    results.push({ status: existing ? 'updated' : 'created', flowName: diagramName });
  }

  return results;
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
      const flowResults = await generateDiagramForFlow(neighborhoodName, flow);
      for (const result of flowResults) {
        if (result.status === 'created') created += 1;
        else if (result.status === 'updated') updated += 1;
        else if (result.status === 'conflict') {
          conflicts += 1;
          console.warn(`[BPMN AUTOMATION] Skipped "${result.flowName}" — a non-automated diagram already uses that name in "${neighborhoodName}"`);
        }
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
