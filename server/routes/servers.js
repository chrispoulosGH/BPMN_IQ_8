const express = require('express');
const DataSearchIndex = require('../models/DataSearchIndex');
const { getNeighborhoodName } = require('../utils/neighborhoodScope');

const router = express.Router();
const SYSTEM_COMPONENTS_NEIGHBORHOOD = 'System Components';

const SERVER_COMPONENT_REGEX = /server/i;
const APP_FK_FIELDS = [
  'FK_DATA[Applications].correlation_id',
  'FK_Data[Applications].CORRELATION_ID',
  'FK_DATA[Application].correlation_id',
  'FK_Data[Application].CORRELATION_ID',
  'fk_data_applications_correlation_id',
  'app_correlation_id',
  'application_correlation_id',
];

const APP_ACRONYM_FIELDS = [
  'FK_DATA[Applications].application_acronym',
  'FK_Data[Applications].X_ATT2_ITAP_U_APPL_ACRON_NM_Qualifier',
  'APP_ACRON_NM Qualifier',
  'app_x_att2_itap_u_appl_acron_nm Qualifier',
  'application_acronym',
  'app_acronym',
];

const APP_NAME_FIELDS = [
  'FK_DATA[Applications].application_component',
  'FK_Data[Applications].Application Component',
  'APP_NM Aggregate',
  'app_name Aggregate',
  'application_name',
  'app_name',
];

const SERVER_NAME_FIELDS = [
  'SRV_NM Component',
  'server_name',
  'name',
];

const SERVER_HOST_FIELDS = ['host_name', 'hostname', 'host'];
const SERVER_FQDN_FIELDS = ['fqdn', 'fully_qualified_domain_name'];
const SERVER_IP_FIELDS = ['ip_address', 'ip'];
const SERVER_ENV_FIELDS = ['environment', 'env'];
const SERVER_OS_FIELDS = ['operating_system', 'os'];
const SERVER_SUPPORT_FIELDS = ['support_group', 'managed_by_group'];

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
  const correlationId = valueFromFieldByValue(fieldByValue, APP_FK_FIELDS);
  const acronym = valueFromFieldByValue(fieldByValue, APP_ACRONYM_FIELDS);
  const name = valueFromFieldByValue(fieldByValue, APP_NAME_FIELDS);

  if (!correlationId && !acronym && !name) return [];
  return [{ correlationId: correlationId || null, acronym: acronym || null, name: name || null }];
}

function mapIndexDocToServerItem(doc) {
  const fieldByValue = doc.fieldByValue && typeof doc.fieldByValue === 'object' ? doc.fieldByValue : {};
  const linkedApplications = linkedApplicationsFromFieldByValue(fieldByValue);

  const _id = normalizeText(doc._id) || `${doc.componentId || 'server'}:${doc.rowId || doc.rowName}`;
  const name = normalizeText(doc.rowName) || valueFromFieldByValue(fieldByValue, SERVER_NAME_FIELDS) || 'Unknown Server';

  return {
    _id,
    sourceKey: normalizeText(doc.rowId) || _id,
    name,
    hostName: valueFromFieldByValue(fieldByValue, SERVER_HOST_FIELDS),
    fqdn: valueFromFieldByValue(fieldByValue, SERVER_FQDN_FIELDS),
    ipAddress: valueFromFieldByValue(fieldByValue, SERVER_IP_FIELDS),
    environment: valueFromFieldByValue(fieldByValue, SERVER_ENV_FIELDS),
    os: valueFromFieldByValue(fieldByValue, SERVER_OS_FIELDS),
    supportGroup: valueFromFieldByValue(fieldByValue, SERVER_SUPPORT_FIELDS),
    linkedApplications,
    healthNotes: [],
  };
}

function matchesSearch(item, search) {
  const q = normalizeText(search).toLowerCase();
  if (!q) return true;
  const fields = [
    item.name,
    item.hostName,
    item.fqdn,
    item.ipAddress,
    item.environment,
    item.os,
    item.supportGroup,
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

async function loadServersFromIndex(req) {
  const requestedNeighborhood = getNeighborhoodName(req);
  const primaryDocs = await DataSearchIndex.find(
    {
      neighborhoodName: requestedNeighborhood,
      componentName: SERVER_COMPONENT_REGEX,
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
    return { items: primaryDocs.map(mapIndexDocToServerItem), scopeUsed: requestedNeighborhood, fallbackUsed: false };
  }

  const fallbackDocs = await DataSearchIndex.find(
    {
      neighborhoodName: SYSTEM_COMPONENTS_NEIGHBORHOOD,
      componentName: SERVER_COMPONENT_REGEX,
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
    items: fallbackDocs.map(mapIndexDocToServerItem),
    scopeUsed: SYSTEM_COMPONENTS_NEIGHBORHOOD,
    fallbackUsed: true,
    requestedNeighborhood,
  };
}

router.get('/', async (req, res) => {
  try {
    const requestedNeighborhood = getNeighborhoodName(req);
    console.log('[servers:index] request', {
      neighborhood: requestedNeighborhood,
      applicationCorrelationId: req.query.applicationCorrelationId || null,
      applicationName: req.query.applicationName || null,
      search: req.query.search || null,
    });
    const loaded = await loadServersFromIndex(req);
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
    console.log('[servers:index] response', {
      requestedNeighborhood,
      scopeUsed: loaded.scopeUsed,
      fallbackUsed: loaded.fallbackUsed,
      beforeFilterCount,
      afterFilterCount: items.length,
    });
    res.json(items);
  } catch (err) {
    console.error('[servers:index] error', err);
    res.status(500).json({ error: err.message });
  }
});

router.get('/by-application/:correlationId', async (req, res) => {
  try {
    const correlationId = normalizeText(req.params.correlationId);
    if (!correlationId) return res.status(400).json({ error: 'correlationId is required' });
    const requestedNeighborhood = getNeighborhoodName(req);

    console.log('[servers:by-application] request', {
      neighborhood: requestedNeighborhood,
      correlationId,
    });

    const loaded = await loadServersFromIndex(req);
    const items = loaded.items
      .filter((item) => matchesCorrelationId(item, correlationId))
      .sort((a, b) => a.name.localeCompare(b.name));

    console.log('[servers:by-application] response', {
      requestedNeighborhood,
      scopeUsed: loaded.scopeUsed,
      fallbackUsed: loaded.fallbackUsed,
      correlationId,
      matchCount: items.length,
      sampleNames: items.slice(0, 5).map((item) => item.name),
    });

    res.json(items);
  } catch (err) {
    console.error('[servers:by-application] error', err);
    res.status(500).json({ error: err.message });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const id = normalizeText(req.params.id);
    const loaded = await loadServersFromIndex(req);
    const item = loaded.items.find((row) => normalizeText(row._id) === id || normalizeText(row.sourceKey) === id);
    if (!item) return res.status(404).json({ error: 'Server not found' });
    res.json(item);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/:id', async (_req, res) => {
  res.status(405).json({ error: 'Delete is not supported for index-backed server data' });
});

module.exports = router;
