const express = require('express');
const router = express.Router();
const Task = require('../models/Task');
const Diagram = require('../models/Diagram');
const Component = require('../models/Component');
const CanonicalComponent = require('../models/CanonicalComponent');
const { BusinessFlow, Product, Actor, Channel, Domain, Subdomain, LineOfBusiness } = require('../models/ReferenceData');
const { findApplicationByCorrelationId, listApplicationReferences } = require('../utils/applicationReferenceLookup');
const { getNeighborhoodName, buildNeighborhoodFilter, withNeighborhood } = require('../utils/neighborhoodScope');

const APPLICATION_FIELDS = [
  'name',
  'correlationId',
  'shortDescription',
  'applicationType',
  'businessCriticality',
  'discoverySource',
  'installType',
  'cpniIndicator',
  'customerFacing',
  'handleSpi',
  'internetFacing',
  'pciData',
  'soxFsa',
  'storeSpi',
  'acronym',
  'applPurpose',
  'lifecycle',
  'lifecycleStatus',
  'businessPurpose',
  'pciDataStored',
  'userInterface',
  'owner',
  'state',
];

function pickFields(source, allowed) {
  const output = {};
  for (const field of allowed) {
    if (source[field] !== undefined) output[field] = source[field];
  }
  return output;
}

function duplicateErrorMessage(err) {
  const key = Object.keys(err?.keyPattern || {})[0] || '';
  if (key === 'correlationId') return 'Application correlationId already exists';
  if (key === 'name') return 'Application name already exists';
  return 'Already exists';
}

function normalizeValue(value) {
  return String(value || '').trim();
}

function normalizeKey(value) {
  return normalizeValue(value).toLowerCase();
}

function uniqueByName(items) {
  const seen = new Set();
  const uniqueItems = [];

  for (const item of Array.isArray(items) ? items : []) {
    const name = normalizeValue(item?.name);
    if (!name) continue;
    const key = normalizeKey(name);
    if (seen.has(key)) continue;
    seen.add(key);
    uniqueItems.push({ ...(item || {}), name });
  }

  return uniqueItems.sort((left, right) => left.name.localeCompare(right.name));
}

function getRowValues(values) {
  if (!values) return {};
  if (values instanceof Map) return Object.fromEntries(values.entries());
  return { ...values };
}

function getComponentRowName(row, component) {
  const values = getRowValues(row?.values);
  if (values.name !== undefined && values.name !== null && String(values.name).trim()) {
    return String(values.name).trim();
  }

  for (const column of Array.isArray(component?.columns) ? component.columns : []) {
    const value = values[column];
    if (value !== undefined && value !== null && String(value).trim()) {
      return String(value).trim();
    }
  }

  return '';
}

function matchComponentSemantic(componentName, aliases) {
  const key = normalizeKey(componentName);
  return aliases.some((alias) => key === normalizeKey(alias));
}

async function getComponentReferenceItems(neighborhoodName, aliases) {
  const components = await Component.find({ neighborhoodName }, { name: 1, rows: 1, columns: 1 }).lean();
  const matches = components.filter((component) => matchComponentSemantic(component?.name, aliases));

  const names = [];
  for (const component of matches) {
    for (const row of Array.isArray(component?.rows) ? component.rows : []) {
      const name = getComponentRowName(row, component);
      if (name) names.push({ name });
    }
  }

  return uniqueByName(names);
}

function normalizeTaskApplications(applications) {
  return (Array.isArray(applications) ? applications : [])
    .map((entry) => {
      if (typeof entry === 'string') return entry;
      return entry?.name;
    })
    .map((value) => normalizeValue(value))
    .filter(Boolean);
}

function filterTasksByQuery(tasks, query = {}) {
  const businessFlow = normalizeValue(query.businessFlow);
  const product = normalizeValue(query.product);
  const actor = normalizeValue(query.actor);
  const channel = normalizeValue(query.channel);
  const domain = normalizeValue(query.domain);
  const search = normalizeValue(query.search);
  const exact = String(query.exact || '') === '1';

  return (Array.isArray(tasks) ? tasks : []).filter((task) => {
    if (businessFlow && normalizeKey(task?.businessFlow) !== normalizeKey(businessFlow)) return false;
    if (product && normalizeKey(task?.product) !== normalizeKey(product)) return false;
    if (actor && normalizeKey(task?.actor) !== normalizeKey(actor)) return false;
    if (channel && normalizeKey(task?.channel) !== normalizeKey(channel)) return false;
    if (domain && normalizeKey(task?.domain) !== normalizeKey(domain)) return false;
    if (!search) return true;
    const taskName = normalizeValue(task?.name);
    if (exact) return taskName === search;
    return taskName.toLowerCase().includes(search.toLowerCase());
  });
}

async function getTasksFromDiagrams(req) {
  const diagrams = await Diagram.find(
    buildNeighborhoodFilter(getNeighborhoodName(req)),
    { _id: 1, businessFlow: 1, name: 1, product: 1, domain: 1, channel: 1, tasks: 1 }
  ).lean();

  const taskRows = [];
  for (const diagram of diagrams) {
    const flowName = normalizeValue(diagram?.businessFlow) || normalizeValue(diagram?.name) || 'Unspecified Business Flow';
    for (const task of Array.isArray(diagram?.tasks) ? diagram.tasks : []) {
      const taskName = normalizeValue(task?.name);
      if (!taskName) continue;
      taskRows.push({
        _id: `${diagram._id}:${taskName}`,
        neighborhoodName: getNeighborhoodName(req),
        name: taskName,
        businessFlow: flowName,
        product: normalizeValue(diagram?.product),
        domain: normalizeValue(diagram?.domain),
        subdomain: normalizeValue(diagram?.subdomain),
        channel: normalizeValue(diagram?.channel),
        actor: '',
        applications: normalizeTaskApplications(task?.applications),
        sequence: undefined,
      });
    }
  }

  return taskRows;
}

async function getMergedReferenceItems(req, collection) {
  if (collection === 'applications') {
    return listApplicationReferences(getNeighborhoodName(req));
  }

  const Model = refModels[collection];
  const legacyItems = Model ? await Model.find(withNeighborhood(req)).sort('name').lean() : [];

  const neighborhoodName = getNeighborhoodName(req);
  const aliasMap = {
    businessFlows: ['business flow', 'business_flow'],
    products: ['product'],
    actors: ['actor'],
    channels: ['channel'],
    domains: ['domain', 'l0'],
    subdomains: ['subdomain', 'l1'],
    linesOfBusiness: ['line of business', 'lineofbusiness', 'lob'],
  };

  const componentItems = aliasMap[collection]
    ? await getComponentReferenceItems(neighborhoodName, aliasMap[collection])
    : [];

  if (collection === 'businessFlows') {
    const diagramFlows = await Diagram.find(
      buildNeighborhoodFilter(neighborhoodName),
      { businessFlow: 1, name: 1, _id: 0 }
    ).lean();
    const diagramItems = diagramFlows
      .map((diagram) => ({ name: normalizeValue(diagram?.businessFlow) || normalizeValue(diagram?.name) }))
      .filter((item) => item.name);
    return uniqueByName([...(legacyItems || []), ...componentItems, ...diagramItems]);
  }

  return uniqueByName([...(legacyItems || []), ...componentItems]);
}

// ─── Reference Data ──────────────────────────────────────────
const refModels = { businessFlows: BusinessFlow, products: Product, actors: Actor, channels: Channel, domains: Domain, subdomains: Subdomain, linesOfBusiness: LineOfBusiness };

router.get('/reference', async (_req, res) => {
  const req = _req;
  const [businessFlows, products, applications, actors, channels, domains, subdomains, linesOfBusiness] = await Promise.all([
    getMergedReferenceItems(req, 'businessFlows'),
    getMergedReferenceItems(req, 'products'),
    listApplicationReferences(getNeighborhoodName(req)),
    getMergedReferenceItems(req, 'actors'),
    getMergedReferenceItems(req, 'channels'),
    getMergedReferenceItems(req, 'domains'),
    getMergedReferenceItems(req, 'subdomains'),
    getMergedReferenceItems(req, 'linesOfBusiness'),
  ]);
  res.json({ businessFlows, products, applications, actors, channels, domains, subdomains, linesOfBusiness });
});

// CRUD for individual reference collections
router.get('/reference/applications/by-correlation/:correlationId', async (req, res) => {
  const correlationId = String(req.params.correlationId || '').trim();
  if (!correlationId) return res.status(400).json({ error: 'correlationId is required' });

  const item = await findApplicationByCorrelationId(getNeighborhoodName(req), correlationId);
  if (!item) return res.status(404).json({ error: 'Application not found' });
  res.json(item);
});

router.get('/reference/:collection', async (req, res) => {
  if (req.params.collection === 'applications') {
    const items = await listApplicationReferences(getNeighborhoodName(req));
    return res.json(items);
  }
  if (!refModels[req.params.collection]) return res.status(404).json({ error: 'Unknown collection' });
  const items = await getMergedReferenceItems(req, req.params.collection);
  res.json(items);
});

router.post('/reference/:collection', async (req, res) => {
  if (req.params.collection === 'applications') {
    return res.status(410).json({ error: 'Application records are derived from loaded data and cannot be created here' });
  }

  const Model = refModels[req.params.collection];
  if (!Model) return res.status(404).json({ error: 'Unknown collection' });
  try {
    const isApplications = req.params.collection === 'applications';
    const data = isApplications
      ? { neighborhoodName: getNeighborhoodName(req), ...pickFields(req.body, APPLICATION_FIELDS) }
      : { neighborhoodName: getNeighborhoodName(req), name: req.body.name };

    if (!isApplications) {
      if (req.body.owner !== undefined) data.owner = req.body.owner;
      if (req.body.state !== undefined) data.state = req.body.state;
    }

    const item = await Model.create(data);
    res.status(201).json(item);
  } catch (err) {
    if (err.code === 11000) return res.status(409).json({ error: duplicateErrorMessage(err) });
    res.status(400).json({ error: err.message });
  }
});

router.put('/reference/:collection/:id', async (req, res) => {
  if (req.params.collection === 'applications') {
    return res.status(410).json({ error: 'Application records are derived from loaded data and cannot be edited here' });
  }

  const Model = refModels[req.params.collection];
  if (!Model) return res.status(404).json({ error: 'Unknown collection' });
  try {
    const isApplications = req.params.collection === 'applications';
    const update = isApplications
      ? pickFields(req.body, APPLICATION_FIELDS)
      : { name: req.body.name };

    if (!isApplications && req.body.owner !== undefined) update.owner = req.body.owner;

    const item = await Model.findOneAndUpdate({
      $and: [
        buildNeighborhoodFilter(getNeighborhoodName(req)),
        { _id: req.params.id },
      ],
    }, update, { new: true, runValidators: true });
    if (!item) return res.status(404).json({ error: 'Not found' });
    res.json(item);
  } catch (err) {
    if (err.code === 11000) return res.status(409).json({ error: duplicateErrorMessage(err) });
    res.status(400).json({ error: err.message });
  }
});

router.delete('/reference/:collection/:id', async (req, res) => {
  if (req.params.collection === 'applications') {
    return res.status(410).json({ error: 'Application records are derived from loaded data and cannot be deleted here' });
  }

  const Model = refModels[req.params.collection];
  if (!Model) return res.status(404).json({ error: 'Unknown collection' });
  const item = await Model.findOneAndDelete({
    $and: [
      buildNeighborhoodFilter(getNeighborhoodName(req)),
      { _id: req.params.id },
    ],
  });
  if (!item) return res.status(404).json({ error: 'Not found' });
  res.json({ success: true });
});

// ─── Tasks CRUD ──────────────────────────────────────────────

// GET /api/tasks/names — distinct task names for autocomplete (must be before /:id)
// Optional ?businessFlow=X to scope to a specific business flow
router.get('/names', async (req, res) => {
  const filter = withNeighborhood(req, req.query.businessFlow ? { businessFlow: req.query.businessFlow } : {});
  const legacyTaskNames = await Task.distinct('name', filter);

  // The "Tasks" factory (Model Components — where "Add to Task Component"
  // and the "New Task" dialog actually write rows) is a different data
  // source entirely from the legacy `Task` collection above: it lives in
  // either CanonicalComponent (componentType "Task"/"Tasks") or a legacy
  // Component doc with embedded rows, depending on how this neighborhood's
  // data was loaded. Without this, a task just added to the factory would
  // never appear here — and would even be rejected if typed by hand, since
  // the Enter-to-confirm check below validates against this same list.
  const neighborhoodName = getNeighborhoodName(req);
  const neighborhoodFilter = buildNeighborhoodFilter(neighborhoodName);
  const [canonicalTaskDocs, legacyFactoryItems] = await Promise.all([
    CanonicalComponent.find(
      { $and: [neighborhoodFilter, { componentType: { $regex: /^tasks?$/i } }] },
      { primaryKey: 1 }
    ).lean(),
    getComponentReferenceItems(neighborhoodName, ['task', 'tasks']),
  ]);
  const factoryTaskNames = [
    ...canonicalTaskDocs.map((doc) => doc.primaryKey),
    ...legacyFactoryItems.map((item) => item.name),
  ].map((name) => String(name || '').trim()).filter(Boolean);

  const names = [...new Set([...legacyTaskNames, ...factoryTaskNames])];
  if (names.length) return res.json(names.sort());

  const fallbackTasks = await getTasksFromDiagrams(req);
  const fallbackNames = [...new Set(filterTasksByQuery(fallbackTasks, req.query).map((task) => task.name))];
  return res.json(fallbackNames.sort());
});

// List tasks (with optional filters)
router.get('/', async (req, res) => {
  const extraFilter = {};
  if (req.query.businessFlow) extraFilter.businessFlow = req.query.businessFlow;
  if (req.query.product) extraFilter.product = req.query.product;
  if (req.query.actor) extraFilter.actor = req.query.actor;
  if (req.query.channel) extraFilter.channel = req.query.channel;
  if (req.query.domain) extraFilter.domain = req.query.domain;
  if (req.query.search) {
    if (String(req.query.exact || '') === '1') {
      extraFilter.name = String(req.query.search);
    } else {
      extraFilter.name = { $regex: req.query.search, $options: 'i' };
    }
  }

  const filter = withNeighborhood(req, extraFilter);
  const tasks = await Task.find(filter).sort({ businessFlow: 1, sequence: 1, name: 1 }).lean();
  if (tasks.length) return res.json(tasks);

  const fallbackTasks = await getTasksFromDiagrams(req);
  const filteredFallbackTasks = filterTasksByQuery(fallbackTasks, req.query)
    .sort((left, right) => {
      if (normalizeValue(left.businessFlow) !== normalizeValue(right.businessFlow)) {
        return normalizeValue(left.businessFlow).localeCompare(normalizeValue(right.businessFlow));
      }
      return normalizeValue(left.name).localeCompare(normalizeValue(right.name));
    });

  return res.json(filteredFallbackTasks);
});

// Get single task
router.get('/:id', async (req, res) => {
  const task = await Task.findOne({
    $and: [
      buildNeighborhoodFilter(getNeighborhoodName(req)),
      { _id: req.params.id },
    ],
  }).lean();
  if (!task) return res.status(404).json({ error: 'Task not found' });
  res.json(task);
});

// Create task
router.post('/', async (req, res) => {
  try {
    const task = await Task.create({ ...req.body, neighborhoodName: getNeighborhoodName(req) });
    res.status(201).json(task);
  } catch (err) {
    if (err.code === 11000) {
      return res.status(409).json({ error: 'Task with this name/flow/product already exists' });
    }
    res.status(400).json({ error: err.message });
  }
});

// Update task
router.put('/:id', async (req, res) => {
  try {
    const task = await Task.findOneAndUpdate({
      $and: [
        buildNeighborhoodFilter(getNeighborhoodName(req)),
        { _id: req.params.id },
      ],
    }, { $set: req.body }, { new: true, runValidators: true });
    if (!task) return res.status(404).json({ error: 'Task not found' });
    res.json(task);
  } catch (err) {
    if (err.code === 11000) {
      return res.status(409).json({ error: 'Task with this name/flow/product already exists' });
    }
    res.status(400).json({ error: err.message });
  }
});

// Delete task
router.delete('/:id', async (req, res) => {
  const task = await Task.findOneAndDelete({
    $and: [
      buildNeighborhoodFilter(getNeighborhoodName(req)),
      { _id: req.params.id },
    ],
  });
  if (!task) return res.status(404).json({ error: 'Task not found' });
  res.json({ success: true });
});

// ─── Validate task names against Task Factory ────────────────
// POST /api/tasks/validate  { taskNames: string[] }
// Returns { valid: string[], invalid: string[] }
router.post('/validate', async (req, res) => {
  const { taskNames, businessFlow } = req.body;
  if (!Array.isArray(taskNames)) return res.status(400).json({ error: 'taskNames must be an array' });

  // Get distinct task names scoped to the businessFlow if provided, otherwise all
  const filter = withNeighborhood(req, businessFlow ? { businessFlow } : {});
  const knownNames = await Task.distinct('name', filter);
  const fallbackNames = knownNames.length
    ? knownNames
    : [...new Set(filterTasksByQuery(await getTasksFromDiagrams(req), businessFlow ? { businessFlow } : {}).map((task) => task.name))];
  const knownSet = new Set(fallbackNames.map((n) => n.toLowerCase().trim()));

  const valid = [];
  const invalid = [];
  for (const name of taskNames) {
    if (knownSet.has(name.toLowerCase().trim())) {
      valid.push(name);
    } else {
      invalid.push(name);
    }
  }
  res.json({ valid, invalid });
});

module.exports = router;
