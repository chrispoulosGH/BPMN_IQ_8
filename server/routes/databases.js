const express = require('express');
const DataSearchIndex = require('../models/DataSearchIndex');
const { getNeighborhoodName } = require('../utils/neighborhoodScope');
const { findLinkedApplicationsFromFieldByValue } = require('../utils/applicationReferenceLookup');

const router = express.Router();
const SYSTEM_COMPONENTS_NEIGHBORHOOD = 'System Components';

const DATABASE_COMPONENT_REGEX = /database/i;

const DB_NAME_FIELDS = ['database_name', 'instance_name', 'name'];
const DB_INSTANCE_FIELDS = ['instance_name', 'instance'];
const DB_SERVICE_FIELDS = ['service_name', 'service'];
const DB_VENDOR_FIELDS = ['vendor'];
const DB_VENDOR_NORMALIZED_FIELDS = ['normalized_vendor', 'vendor_normalized'];
const DB_VERSION_FIELDS = ['version', 'db_version'];
const DB_CLASS_FIELDS = ['database_class_name', 'database_type', 'class_name'];

function normalizeText(value) {
  return String(value || '').trim();
}

function normalizeLookupKey(value) {
  return normalizeText(value).toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function toComparableToken(value) {
  const text = normalizeText(value);
  if (!text) return '';
  const asNumber = Number(text);
  return Number.isFinite(asNumber) ? String(asNumber) : text;
}

function valueFromFieldByValue(fieldByValue, aliases) {
  const source = fieldByValue && typeof fieldByValue === 'object' ? fieldByValue : {};
  const sourceEntries = Object.entries(source);
  for (const alias of aliases) {
    const direct = source[alias];
    if (direct !== undefined && direct !== null) {
      const value = normalizeText(direct);
      if (value) return value;
      continue;
    }

    const normalizedAlias = normalizeLookupKey(alias);
    const match = sourceEntries.find(([key]) => normalizeLookupKey(key) === normalizedAlias);
    if (!match) continue;
    const value = normalizeText(match[1]);
    if (value) return value;
  }
  return '';
}

function linkedApplicationsFromFieldByValue(fieldByValue) {
  return findLinkedApplicationsFromFieldByValue(fieldByValue);
}

function mapIndexDocToDatabaseItem(doc) {
  const fieldByValue = doc.fieldByValue && typeof doc.fieldByValue === 'object' ? doc.fieldByValue : {};
  const linkedApplications = linkedApplicationsFromFieldByValue(fieldByValue);

  const _id = normalizeText(doc._id) || `${doc.componentId || 'database'}:${doc.rowId || doc.rowName}`;
  const name = normalizeText(doc.rowName) || valueFromFieldByValue(fieldByValue, DB_NAME_FIELDS) || 'Unknown Database';

  return {
    _id,
    sourceKey: normalizeText(doc.rowId) || _id,
    name,
    instanceName: valueFromFieldByValue(fieldByValue, DB_INSTANCE_FIELDS),
    serviceName: valueFromFieldByValue(fieldByValue, DB_SERVICE_FIELDS),
    vendor: valueFromFieldByValue(fieldByValue, DB_VENDOR_FIELDS),
    normalizedVendor: valueFromFieldByValue(fieldByValue, DB_VENDOR_NORMALIZED_FIELDS),
    version: valueFromFieldByValue(fieldByValue, DB_VERSION_FIELDS),
    databaseClassName: valueFromFieldByValue(fieldByValue, DB_CLASS_FIELDS),
    linkedApplications,
    healthNotes: [],
  };
}

function matchesSearch(item, search) {
  const q = normalizeText(search).toLowerCase();
  if (!q) return true;
  const fields = [
    item.name,
    item.instanceName,
    item.serviceName,
    item.vendor,
    item.normalizedVendor,
    item.version,
    item.databaseClassName,
    ...(item.linkedApplications || []).flatMap((app) => [app.name, app.acronym, app.correlationId]),
  ]
    .map((value) => normalizeText(value).toLowerCase())
    .filter(Boolean);
  return fields.some((value) => value.includes(q));
}

function matchesCorrelationId(item, correlationId) {
  const target = toComparableToken(correlationId);
  if (!target) return true;
  return (item.linkedApplications || []).some((app) => toComparableToken(app.correlationId) === target);
}

function matchesAcronym(item, applicationName) {
  const query = normalizeText(applicationName).toLowerCase();
  if (!query) return true;
  return (item.linkedApplications || []).some((app) => normalizeText(app.acronym).toLowerCase().includes(query));
}

async function loadDatabasesFromIndex(req) {
  const requestedNeighborhood = getNeighborhoodName(req);
  const primaryDocs = await DataSearchIndex.find(
    {
      neighborhoodName: requestedNeighborhood,
      componentName: DATABASE_COMPONENT_REGEX,
    },
    {
      rowName: 1,
      rowId: 1,
      componentId: 1,
      fieldByValue: 1,
      updatedAt: 1,
      neighborhoodName: 1,
    }
  ).lean();

  if (primaryDocs.length || requestedNeighborhood === SYSTEM_COMPONENTS_NEIGHBORHOOD) {
    return { items: primaryDocs.map(mapIndexDocToDatabaseItem), scopeUsed: requestedNeighborhood, fallbackUsed: false };
  }

  const fallbackDocs = await DataSearchIndex.find(
    {
      neighborhoodName: SYSTEM_COMPONENTS_NEIGHBORHOOD,
      componentName: DATABASE_COMPONENT_REGEX,
    },
    {
      rowName: 1,
      rowId: 1,
      componentId: 1,
      fieldByValue: 1,
      updatedAt: 1,
      neighborhoodName: 1,
    }
  ).lean();

  return {
    items: fallbackDocs.map(mapIndexDocToDatabaseItem),
    scopeUsed: SYSTEM_COMPONENTS_NEIGHBORHOOD,
    fallbackUsed: true,
    requestedNeighborhood,
  };
}

router.get('/', async (req, res) => {
  try {
    const requestedNeighborhood = getNeighborhoodName(req);
    console.log('[databases:index] request', {
      neighborhood: requestedNeighborhood,
      applicationCorrelationId: req.query.applicationCorrelationId || null,
      applicationName: req.query.applicationName || null,
      search: req.query.search || null,
    });
    const loaded = await loadDatabasesFromIndex(req);
    let items = loaded.items;
    const beforeFilterCount = items.length;

    if (req.query.applicationCorrelationId) {
      items = items.filter((item) => matchesCorrelationId(item, req.query.applicationCorrelationId));
    }

    if (req.query.applicationName) {
      items = items.filter((item) => matchesAcronym(item, req.query.applicationName));
    }

    if (req.query.search) {
      items = items.filter((item) => matchesSearch(item, req.query.search));
    }

    items.sort((a, b) => a.name.localeCompare(b.name));
    console.log('[databases:index] response', {
      requestedNeighborhood,
      scopeUsed: loaded.scopeUsed,
      fallbackUsed: loaded.fallbackUsed,
      beforeFilterCount,
      afterFilterCount: items.length,
    });
    res.json(items);
  } catch (err) {
    console.error('[databases:index] error', err);
    res.status(500).json({ error: err.message });
  }
});

router.get('/by-application/:correlationId', async (req, res) => {
  try {
    const correlationId = normalizeText(req.params.correlationId);
    if (!correlationId) return res.status(400).json({ error: 'correlationId is required' });
    const requestedNeighborhood = getNeighborhoodName(req);

    console.log('[databases:by-application] request', {
      neighborhood: requestedNeighborhood,
      correlationId,
    });

    const loaded = await loadDatabasesFromIndex(req);
    const items = loaded.items
      .filter((item) => matchesCorrelationId(item, correlationId))
      .sort((a, b) => a.name.localeCompare(b.name));

    console.log('[databases:by-application] response', {
      requestedNeighborhood,
      scopeUsed: loaded.scopeUsed,
      fallbackUsed: loaded.fallbackUsed,
      correlationId,
      matchCount: items.length,
      sampleNames: items.slice(0, 5).map((item) => item.name),
    });

    res.json(items);
  } catch (err) {
    console.error('[databases:by-application] error', err);
    res.status(500).json({ error: err.message });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const id = normalizeText(req.params.id);
    const loaded = await loadDatabasesFromIndex(req);
    const item = loaded.items.find((row) => normalizeText(row._id) === id || normalizeText(row.sourceKey) === id);
    if (!item) return res.status(404).json({ error: 'Database not found' });
    res.json(item);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/:id', async (_req, res) => {
  res.status(405).json({ error: 'Delete is not supported for index-backed database data' });
});

module.exports = router;
