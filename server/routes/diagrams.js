const express = require('express');
const router = express.Router();
const Diagram = require('../models/Diagram');
const Component = require('../models/Component');
const Model = require('../models/Model');
const Actor = require('../models/Actor');
const { Product, Channel, Domain, Subdomain, LineOfBusiness } = require('../models/ReferenceData');
const { DEFAULT_NEIGHBORHOOD_NAME, getNeighborhoodName, buildNeighborhoodFilter } = require('../utils/neighborhoodScope');
const { listApplicationReferences } = require('../utils/applicationReferenceLookup');

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
  const elRegex = /<bpmn:(\w+)\s+id="([^"]+)"(?:\s+name="([^"]*)")?[^>]*?\/?>/gi;
  let m;
  while ((m = elRegex.exec(xml)) !== null) {
    const [, type, id, name] = m;
    const isTask = taskTypes.test(type);
    elementMap.set(id, { id, name: name || id, isTask });
  }

  // 2. Parse sequence flows into adjacency lists
  const outgoing = new Map(); // id -> [targetId, ...]
  const incoming = new Map(); // id -> [sourceId, ...]
  const flowRegex = /<bpmn:sequenceFlow[^>]+sourceRef="([^"]+)"[^>]+targetRef="([^"]+)"[^>]*\/?>/gi;
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
  const taskBlockRegex = /<bpmn:(?:task|userTask|serviceTask|sendTask|receiveTask|manualTask|businessRuleTask|scriptTask|subProcess)\s+id="([^"]+)"[^>]*>([\s\S]*?)<\/bpmn:(?:task|userTask|serviceTask|sendTask|receiveTask|manualTask|businessRuleTask|scriptTask|subProcess)>/gi;
  while ((m = taskBlockRegex.exec(xml)) !== null) {
    const [, taskId, body] = m;
    const appNames = [];
    const appAttrRegex = /<(?:bpmniq|ns\d+):(?:A|a)pplication[^>]+name="([^"]+)"/gi;
    let am;
    while ((am = appAttrRegex.exec(body)) !== null) {
      appNames.push(am[1].trim());
    }
    // Also handle element-style: <bpmniq:application><bpmniq:name>X</bpmniq:name></bpmniq:application>
    const appElRegex = /<(?:bpmniq|ns\d+):application>[\s\S]*?<(?:bpmniq|ns\d+):name>([\s\S]*?)<\/(?:bpmniq|ns\d+):name>[\s\S]*?<\/(?:bpmniq|ns\d+):application>/gi;
    while ((am = appElRegex.exec(body)) !== null) {
      const name = am[1].trim();
      if (name && !appNames.includes(name)) appNames.push(name);
    }
    if (appNames.length) taskAppExtMap.set(taskId, appNames);
  }

  // 5. Parse text annotations and associations (fallback for apps)
  const annotationMap = new Map(); // annotationId -> text
  const annRegex = /<bpmn:textAnnotation\s+id="([^"]+)"[^>]*>[\s\S]*?<bpmn:text>([\s\S]*?)<\/bpmn:text>[\s\S]*?<\/bpmn:textAnnotation>/gi;
  while ((m = annRegex.exec(xml)) !== null) {
    const [, annId, text] = m;
    const trimmed = text.trim();
    // Skip metadata annotations (contain | and :) and empty annotations
    if (!trimmed || (trimmed.includes('|') && trimmed.includes(':'))) continue;
    annotationMap.set(annId, trimmed);
  }

  const assocAppMap = new Map(); // taskId -> [appName, ...]
  const assocRegex = /<bpmn:association[^>]+sourceRef="([^"]+)"[^>]+targetRef="([^"]+)"[^>]*\/?>/gi;
  while ((m = assocRegex.exec(xml)) !== null) {
    const [, srcRef, tgtRef] = m;
    // One of them is a textAnnotation, the other is a task
    const annId = annotationMap.has(srcRef) ? srcRef : annotationMap.has(tgtRef) ? tgtRef : null;
    const taskId = annId === srcRef ? tgtRef : srcRef;
    if (!annId) continue;
    const el = elementMap.get(taskId);
    if (!el || !el.isTask) continue;
    const apps = annotationMap.get(annId).split(',').map(s => s.trim()).filter(Boolean);
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
  if (!rawParentName.trim()) return false;
  return rawParentName
    .split(/[|,]/)
    .map((value) => normalizeObjectMatchValue(value))
    .includes(expected);
}

async function getNeighborhoodMetadataMappings(neighborhoodName) {
  const baseMappings = {
    lineOfBusiness: { label: 'Line of Business', kind: 'reference', model: LineOfBusiness },
    channel: { label: 'Channel', kind: 'reference', model: Channel },
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
  const xmlApplicationNames = extractApplicationIdentifiersFromXml(diagramLike.xml || '');
  const applicationNames = xmlApplicationNames.length
    ? xmlApplicationNames
    : [...new Set(
        (diagramLike.tasks || []).flatMap((task) =>
          (task.applications || []).map((app) => String(app?.name || '').trim()).filter(Boolean)
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

  const businessFlowComponentFilter = combineFilters(
    buildNeighborhoodFilter(neighborhoodName),
    { name: { $regex: /^business[\s_]*flow$/i } }
  );
  const businessFlowComponent = await Component.findOne(businessFlowComponentFilter, { rows: 1 }).lean();
  return (businessFlowComponent?.rows || []).some((row) => {
    return normalizeBusinessFlowLookupValue(getCustomFactoryRowName(row)) === normalizedName;
  });
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
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/diagrams — list all (Viewers only see published)
router.get('/', async (req, res) => {
  try {
    const role = req.currentUser?.role;
    const neighborhoodName = getNeighborhoodName(req);
    const filter = (!role || role === 'Viewer')
      ? { $and: [buildNeighborhoodFilter(neighborhoodName), { status: 'published' }] }
      : buildNeighborhoodFilter(neighborhoodName);
    const diagrams = await Diagram.find(filter).sort({ updatedAt: -1 }).lean();
    const hydratedDiagrams = diagrams.map((diagram) => {
      const metadata = parseDiagramMetadata(diagram.xml);
      const hydrated = {
        ...diagram,
        lineOfBusiness: diagram.lineOfBusiness || metadata.lineOfBusiness || null,
        channel: diagram.channel || metadata.channel || null,
        product: diagram.product || metadata.product || null,
        domain: diagram.domain || metadata.domain || null,
        subdomain: diagram.subdomain || metadata.subdomain || null,
        businessCapability: diagram.businessCapability || metadata.businessCapability || null,
        valueStream: diagram.valueStream || metadata.valueStream || null,
        journey: diagram.journey || metadata.journey || null,
        businessFlow: diagram.businessFlow || metadata.businessFlow || null,
      };
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
  const isViewer = !role || role === 'Viewer';
  const neighborhoodName = getNeighborhoodName(req);
  try {
    // Try full-text search first
    const textFilter = isViewer
      ? { $and: [buildNeighborhoodFilter(neighborhoodName), { $text: { $search: q.trim() } }, { status: 'published' }] }
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
        ? { $and: [buildNeighborhoodFilter(neighborhoodName), { $or: orConditions }, { status: 'published' }] }
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
  const { name, description, xml, tags, capabilities, status, sourcedFrom, createdBy } = req.body;
  if (!name || !xml) {
    return res.status(400).json({ error: 'Fields "name" and "xml" are required.' });
  }
  try {
    const meta = parseDiagramMetadata(xml);
    const hintedNeighborhoodName = getNeighborhoodName(req);
    const metadataValidationSummary = await validateDiagramMetadataForNeighborhood(meta, hintedNeighborhoodName);
    // Use the caller-supplied name; meta.businessFlow is informational metadata only
    const diagramName = name;
    const cleanXml = stripTitleAnnotations(xml);
    const tasks = extractTasks(xml);
    const resolvedStatus = await resolveImportedDiagramStatus(
      status,
      sourcedFrom,
      meta.businessFlow || diagramName,
      hintedNeighborhoodName,
      metadataValidationSummary,
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
  const { name, description, xml, tags, capabilities, changeNote, status, sourcedFrom, updatedBy } = req.body;
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
      $set.xml = stripTitleAnnotations(xml);
      // Re-parse metadata from updated XML
      const meta = parseDiagramMetadata(xml);
      $set.lineOfBusiness = meta.lineOfBusiness || null;
      $set.channel = meta.channel || null;
      $set.domain = meta.domain || null;
      $set.subdomain = meta.subdomain || null;
      $set.product = meta.product || null;
      $set.businessFlow = meta.businessFlow || null;
      // Extract tasks with source/target/applications
      $set.tasks = extractTasks(xml);
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
router.delete('/:id', async (req, res) => {
  try {
    const diagram = await Diagram.findOneAndDelete({ $and: [buildNeighborhoodFilter(getNeighborhoodName(req)), { _id: req.params.id }] });
    if (!diagram) return res.status(404).json({ error: 'Diagram not found.' });
    res.json({ message: 'Diagram deleted.' });
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
      const resolvedStatus = await resolveImportedDiagramStatus(
        'staged',
        fileName,
        meta.businessFlow || name,
        resolvedNeighborhood.neighborhoodName,
        resolvedNeighborhood,
        {
          name,
          businessFlow: meta.businessFlow || name,
          xml: cleanXml,
          tasks,
          capabilities: [],
        }
      );
      const diagram = await Diagram.create({
        neighborhoodName: resolvedNeighborhood.neighborhoodName,
        name,
        xml: cleanXml,
        tasks,
        status: resolvedStatus,
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
