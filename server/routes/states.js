const express = require('express');
const router = express.Router();
const State = require('../models/State');
const StatusRef = require('../models/StatusRef');
const { transitions: HARDCODED_TRANSITIONS, VALID_STATES, getAllowedActions, getTargetState } = require('../services/stateTransitions');
const { DEFAULT_NEIGHBORHOOD_NAME, buildNeighborhoodFilter } = require('../utils/neighborhoodScope');
const Component = require('../models/Component');

// Models that support state transitions
const { BusinessFlow, Product, Actor: RefActor, Channel, Domain, Subdomain, LineOfBusiness } = require('../models/ReferenceData');
const Task = require('../models/Task');
const Actor = require('../models/Actor');
const Capability = require('../models/Capability');
const Diagram = require('../models/Diagram');
const { listApplicationReferences } = require('../utils/applicationReferenceLookup');

const collectionModelMap = {
  businessFlows: BusinessFlow,
  products: Product,
  actors: Actor,
  channels: Channel,
  domains: Domain,
  subdomains: Subdomain,
  linesOfBusiness: LineOfBusiness,
  tasks: Task,
  capabilities: Capability,
  diagrams: Diagram,
};

function extractLaneNames(xml) {
  if (!xml) return [];
  const laneNames = [];
  const laneRegex = /<bpmn:lane\b[^>]*\bname="([^"]+)"/gi;
  let match;
  while ((match = laneRegex.exec(xml)) !== null) {
    const name = String(match[1] || '').trim();
    if (name) laneNames.push(name);
  }
  return [...new Set(laneNames)];
}

function decodeXmlValue(value) {
  return String(value || '')
    .replace(/&#(\d+);/g, (_match, codePoint) => String.fromCharCode(Number(codePoint)))
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .trim();
}

function extractApplicationIdentifiersFromXml(xml) {
  if (!xml) return [];

  const identifiers = [];
  const taskBlockRegex = /<bpmn:(?:task|userTask|serviceTask|sendTask|receiveTask|manualTask|businessRuleTask|scriptTask|subProcess)\s+id="([^"]+)"[^>]*>([\s\S]*?)<\/bpmn:(?:task|userTask|serviceTask|sendTask|receiveTask|manualTask|businessRuleTask|scriptTask|subProcess)>/gi;
  let taskMatch;

  while ((taskMatch = taskBlockRegex.exec(xml)) !== null) {
    const [, , body] = taskMatch;

    const appAttrRegex = /<(?:bpmniq|ns\d+):(?:A|a)pplication[^>]+name="([^"]+)"/gi;
    let attrMatch;
    while ((attrMatch = appAttrRegex.exec(body)) !== null) {
      const identifier = decodeXmlValue(attrMatch[1]);
      if (identifier) identifiers.push(identifier);
    }

    const appElementRegex = /<(?:bpmniq|ns\d+):application\b[^>]*>([\s\S]*?)<\/(?:bpmniq|ns\d+):application>/gi;
    let appElementMatch;
    while ((appElementMatch = appElementRegex.exec(body)) !== null) {
      const appBody = appElementMatch[1];
      const correlationId = decodeXmlValue((appBody.match(/<(?:bpmniq|ns\d+):correlationIds\b[^>]*>[\s\S]*?<(?:bpmniq|ns\d+):id>([\s\S]*?)<\/(?:bpmniq|ns\d+):id>/i) || [])[1]);
      const acronym = decodeXmlValue((appBody.match(/<(?:bpmniq|ns\d+):acronym>([\s\S]*?)<\/(?:bpmniq|ns\d+):acronym>/i) || [])[1]);
      const name = decodeXmlValue((appBody.match(/<(?:bpmniq|ns\d+):name>([\s\S]*?)<\/(?:bpmniq|ns\d+):name>/i) || [])[1]);
      const identifier = correlationId || acronym || name;
      if (identifier) identifiers.push(identifier);
    }
  }

  return [...new Set(identifiers)];
}

function normalizeBusinessFlowLookupValue(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');
}

function normalizeLookupValue(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
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
  if (!rawParentName.trim()) return false;
  return rawParentName
    .split(/[|,]/)
    .map((value) => normalizeObjectMatchValue(value))
    .includes(expected);
}

async function hasMatchingBusinessFlowReference(name, neighborhoodName = DEFAULT_NEIGHBORHOOD_NAME) {
  const normalizedName = normalizeBusinessFlowLookupValue(name);
  if (!normalizedName) return false;
  const businessFlowComponentFilter = combineFilters(
    buildNeighborhoodFilter(neighborhoodName),
    { name: { $regex: /^business[\s_]*flow$/i } }
  );
  const businessFlowComponent = await Component.findOne(businessFlowComponentFilter, { rows: 1 }).lean();
  return (businessFlowComponent?.rows || []).some((row) => {
    return normalizeBusinessFlowLookupValue(getCustomFactoryRowName(row)) === normalizedName;
  });
}

function combineFilters(left, right) {
  const leftFilter = left && Object.keys(left).length ? left : null;
  const rightFilter = right && Object.keys(right).length ? right : null;
  if (leftFilter && rightFilter) return { $and: [leftFilter, rightFilter] };
  return leftFilter || rightFilter || {};
}

async function validateDiagramForSubmission(diagram) {
  const capabilityNames = [...new Set(
    (diagram.capabilities || [])
      .map((capability) => String(capability?.capabilityName || '').trim())
      .filter(Boolean)
  )];
  const businessFlow = (diagram.name || diagram.businessFlow || '').trim();
  const taskNames = [...new Set((diagram.tasks || []).map((task) => String(task.name || '').trim()).filter(Boolean))];
  const xmlApplicationNames = extractApplicationIdentifiersFromXml(diagram.xml || '');
  const applicationNames = xmlApplicationNames.length
    ? xmlApplicationNames
    : [...new Set(
        (diagram.tasks || []).flatMap((task) =>
          (task.applications || []).map((app) => String(app?.name || '').trim()).filter(Boolean)
        )
      )];
  const laneNames = extractLaneNames(diagram.xml || '');
  const neighborhoodName = String(diagram.neighborhoodName || DEFAULT_NEIGHBORHOOD_NAME).trim() || DEFAULT_NEIGHBORHOOD_NAME;
  const neighborhoodFilter = buildNeighborhoodFilter(neighborhoodName);
  const taskComponentFilter = combineFilters(neighborhoodFilter, { name: { $regex: /^tasks?$/i } });

  const [taskComponent, knownApplications, knownActorNames] = await Promise.all([
    Component.findOne(taskComponentFilter, { rows: 1 }).lean(),
    listApplicationReferences(neighborhoodName),
    Actor.distinct('name', neighborhoodFilter),
  ]);

  const knownTaskNames = (taskComponent?.rows || [])
    .filter((row) => rowMatchesParent(row, businessFlow))
    .map((row) => getCustomFactoryRowName(row))
    .filter(Boolean);

  const taskSet = new Set(knownTaskNames.map((name) => normalizeObjectMatchValue(name)));
  const applicationSet = new Set(
    knownApplications.flatMap((application) => [application.correlationId, application.acronym, application.name]
      .map((value) => normalizeObjectMatchValue(value))
      .filter(Boolean))
  );
  const actorSet = new Set(knownActorNames.map((name) => normalizeObjectMatchValue(name)));

  const invalidTasks = taskNames.filter((name) => !taskSet.has(normalizeObjectMatchValue(name)));
  const invalidApplications = applicationNames.filter((name) => !applicationSet.has(normalizeObjectMatchValue(name)));
  const invalidActors = laneNames.filter((name) => !actorSet.has(normalizeObjectMatchValue(name)));
  const hasCapabilities = capabilityNames.length > 0;
  const hasBusinessFlowReference = await hasMatchingBusinessFlowReference(businessFlow || diagram.name, neighborhoodName);

  return { hasCapabilities, hasBusinessFlowReference, invalidTasks, invalidApplications, invalidActors };
}

// GET /api/states — list all valid states
router.get('/', async (_req, res) => {
  try {
    const states = await State.find().sort('order').lean();
    if (states.length) return res.json(states);
    // Fallback to VALID_STATES constant if collection is empty
    res.json(VALID_STATES.map((name, i) => ({ name, order: i })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/states/transitions — list all role/action/from/to transition
// rules (the status_ref collection). Was hardcoded as STATE_TRANSITIONS in
// client/src/components/BpmnFactory.tsx — that table now fetches this
// endpoint instead. Falls back to the hardcoded rules in
// services/stateTransitions.js if the collection hasn't been seeded yet.
router.get('/transitions', async (_req, res) => {
  try {
    const rules = await StatusRef.find().lean();
    res.json(rules.length ? rules : HARDCODED_TRANSITIONS);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/states/actions?collection=xxx&id=yyy&role=zzz — get allowed actions for a record
router.get('/actions', async (req, res) => {
  const { collection, id, role } = req.query;
  if (!collection || !id || !role) {
    return res.status(400).json({ error: 'collection, id, and role are required' });
  }
  const Model = collectionModelMap[collection];
  if (!Model) return res.status(404).json({ error: 'Unknown collection' });

  try {
    const record = await Model.findById(id).lean();
    if (!record) return res.status(404).json({ error: 'Record not found' });
    const currentState = (record.state || record.status || 'draft').toLowerCase();
    const actions = getAllowedActions(role, currentState);
    res.json({ currentState, actions });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/states/transition — perform a state transition
router.post('/transition', async (req, res) => {
  const { collection, id, action, role } = req.body;
  if (!collection || !id || !action || !role) {
    return res.status(400).json({ error: 'collection, id, action, and role are required' });
  }
  const Model = collectionModelMap[collection];
  if (!Model) return res.status(404).json({ error: 'Unknown collection' });

  try {
    const record = await Model.findById(id);
    if (!record) return res.status(404).json({ error: 'Record not found' });

    const currentState = (record.state || record.status || 'draft').toLowerCase();
    const targetState = getTargetState(role, action.toLowerCase(), currentState);

    if (!targetState) {
      return res.status(403).json({
        error: `Role "${role}" cannot perform "${action}" on a record in state "${currentState}"`,
      });
    }

    if (collection === 'diagrams' && currentState === 'draft' && targetState === 'submitted for approval') {
      const {
        hasCapabilities,
        hasBusinessFlowReference,
        invalidTasks,
        invalidApplications,
        invalidActors,
      } = await validateDiagramForSubmission(record);
      if (!hasBusinessFlowReference || !hasCapabilities || invalidTasks.length || invalidApplications.length || invalidActors.length) {
        const problems = [];
        if (!hasBusinessFlowReference) problems.push('business flow reference does not exist in this model');
        if (!hasCapabilities) problems.push('at least one associated business capability is required');
        if (invalidTasks.length) problems.push(`invalid tasks: ${invalidTasks.join(', ')}`);
        if (invalidApplications.length) problems.push(`invalid applications: ${invalidApplications.join(', ')}`);
        if (invalidActors.length) problems.push(`invalid actors: ${invalidActors.join(', ')}`);
        return res.status(400).json({
          error: `Cannot submit diagram with invalid objects: ${problems.join(' | ')}`,
          missingBusinessFlowReference: !hasBusinessFlowReference,
          missingCapabilities: !hasCapabilities,
          invalidTasks,
          invalidApplications,
          invalidActors,
        });
      }
    }

    // Update the state field (use 'state' for ref data, 'status' for diagrams if that's what they use)
    if (collection === 'diagrams') {
      record.status = targetState;
    } else {
      record.state = targetState;
    }
    await record.save();

    res.json({ previousState: currentState, newState: targetState, record });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
