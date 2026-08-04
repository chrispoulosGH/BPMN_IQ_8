const DataSearchIndex = require('../models/DataSearchIndex');
const Data = require('../models/Data');
const CanonicalData = require('../models/CanonicalData');

const APPLICATION_ALIASES = ['application', 'applications'];
const APPLICATION_REGEX = new RegExp(`^(?:${APPLICATION_ALIASES.map(escapeRegex).join('|')})$`, 'i');

// Raw-column-name aliases for each canonical Application field. Shared by
// buildApplicationItem() (building an Application's own record) and
// classifyApplicationFieldAlias() (interpreting what an FK_ column's target
// field name refers to) — see server/services/FK-MAPPING-GUIDE.js.
const APPLICATION_NAME_ALIASES = [
  'name',
  'application',
  'applications',
  'application component',
  'application name',
  'application_name',
  'app name',
  'app_name',
];
const APPLICATION_CORRELATION_ID_ALIASES = [
  'correlationId',
  'correlation_id',
  'correlation_id qualifier',
  'application correlation id',
  'app correlation id',
  'app_id',
  'app id',
  'app_id qualifier',
  'application id',
  'application_id',
];
const APPLICATION_ACRONYM_ALIASES = [
  'acronym',
  'application acronym',
  'app acronym',
  'x_att2_itap_u_appl_acron_nm qualifier',
];

// FK_<TargetTab>[<TargetSubtab>].<ColumnName> — same convention parsed in
// server/routes/customFactories.js and client/src/utils/fkValidation.ts.
const FK_COLUMN_HEADER_REGEX = /^FK_([^\[]+)\[([^\]]+)\]\.(.+)$/i;

// Parses any FK_ header style into { targetScope, columnName }, or null if the
// key isn't an FK_ column at all. Two shapes are observed in the wild:
//   - Bracket form:  FK_<Tab>[<Subtab>].<Column>
//   - Dot form:      FK_<Subtab>.<Column>  or  FK_<Tab>.<Subtab>.<Column>
//     (any number of leading dot segments before the target — the column is
//     always the LAST segment and the subtab is always the SECOND-TO-LAST,
//     so this doesn't need a separate hardcoded pattern per segment count.)
function parseFkColumnKey(key) {
  const trimmed = normalizeValue(key);
  const bracketMatch = trimmed.match(FK_COLUMN_HEADER_REGEX);
  if (bracketMatch) return { targetScope: bracketMatch[2].trim(), columnName: bracketMatch[3].trim() };

  if (!/^FK_/i.test(trimmed)) return null;
  const parts = trimmed.slice(3).split('.').map((part) => part.trim()).filter(Boolean);
  if (parts.length < 2) return null;
  return { targetScope: parts[parts.length - 2], columnName: parts[parts.length - 1] };
}

function escapeRegex(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeValue(value) {
  return String(value || '').trim();
}

function normalizeKey(value) {
  return normalizeValue(value).toLowerCase().replace(/[^a-z0-9]+/g, '');
}

// Column-name matching, not data-value matching: strips the trailing CSV
// convention suffix (" Component" / " Qualifier" / " Aggregate") that this
// codebase's uploaded sheets use before comparing against an alias list, so
// aliases don't need a separate hardcoded entry per suffix style. Same suffix
// set primaryKeyFromRow() (materializer.js) and targetColumnNameBase
// (customFactories.js) already strip for the same reason.
function normalizeColumnAlias(value) {
  return normalizeKey(normalizeValue(value).replace(/\s+(component|qualifier|aggregate)$/i, ''));
}

function toPlainObject(value) {
  if (!value || typeof value !== 'object') return {};
  if (value instanceof Map) return Object.fromEntries(value.entries());
  return Array.isArray(value) ? {} : value;
}

function getFieldValue(source, aliases) {
  const normalizedAliases = aliases.map((alias) => normalizeColumnAlias(alias));
  const values = toPlainObject(source);
  for (const [key, rawValue] of Object.entries(values)) {
    if (!normalizedAliases.includes(normalizeColumnAlias(key))) continue;
    const value = normalizeValue(rawValue);
    if (value) return value;
  }
  return '';
}

function buildApplicationItem(source, fallbackId, neighborhoodName = '') {
  const values = toPlainObject(source);
  const name = getFieldValue(values, APPLICATION_NAME_ALIASES) || normalizeValue(values.rowName) || normalizeValue(values.name);
  const correlationId = getFieldValue(values, APPLICATION_CORRELATION_ID_ALIASES);
  const acronym = getFieldValue(values, APPLICATION_ACRONYM_ALIASES);

  if (!name && !correlationId && !acronym) return null;

  return {
    _id: String(fallbackId || correlationId || acronym || name || `${neighborhoodName}:application`),
    neighborhoodName: normalizeValue(neighborhoodName),
    name,
    acronym,
    correlationId,
    shortDescription: getFieldValue(values, ['shortDescription', 'short_description', 'description']),
    applicationType: getFieldValue(values, ['applicationType', 'application_type', 'type']),
    businessCriticality: getFieldValue(values, ['businessCriticality', 'business_criticality', 'criticality']),
    discoverySource: getFieldValue(values, ['discoverySource', 'discovery_source']),
    installType: getFieldValue(values, ['installType', 'install_type']),
    cpniIndicator: getFieldValue(values, ['cpniIndicator', 'cpni_indicator']),
    customerFacing: getFieldValue(values, ['customerFacing', 'customer_facing']),
    handleSpi: getFieldValue(values, ['handleSpi', 'handle_spi']),
    internetFacing: getFieldValue(values, ['internetFacing', 'internet_facing']),
    pciData: getFieldValue(values, ['pciData', 'pci_data']),
    soxFsa: getFieldValue(values, ['soxFsa', 'sox_fsa']),
    storeSpi: getFieldValue(values, ['storeSpi', 'store_spi']),
    applPurpose: getFieldValue(values, ['applPurpose', 'applicationPurpose', 'application_purpose']),
    lifecycle: getFieldValue(values, ['lifecycle']),
    lifecycleStatus: getFieldValue(values, ['lifecycleStatus', 'lifecycle_status']),
    businessPurpose: getFieldValue(values, ['businessPurpose', 'business_purpose']),
    pciDataStored: getFieldValue(values, ['pciDataStored', 'pci_data_stored']),
    userInterface: getFieldValue(values, ['userInterface', 'user_interface']),
    owner: getFieldValue(values, ['owner']),
    state: getFieldValue(values, ['state']) || 'draft',
  };
}

function dedupeAndSortApplicationItems(items) {
  const seen = new Set();
  const uniqueItems = [];

  for (const item of items) {
    if (!item) continue;
    const key = normalizeKey(item.correlationId || item.acronym || item.name || item._id);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    uniqueItems.push(item);
  }

  return uniqueItems.sort((left, right) => {
    const leftName = normalizeValue(left.name).toLowerCase();
    const rightName = normalizeValue(right.name).toLowerCase();
    if (leftName !== rightName) return leftName.localeCompare(rightName);
    return normalizeValue(left.correlationId).localeCompare(normalizeValue(right.correlationId));
  });
}

function isValidApplicationName(value) {
  const name = normalizeValue(value);
  if (!name) return false;
  // Filter obvious non-app placeholders (internal IDs / usernames)
  if (/^cp\d+$/i.test(name)) return false;
  return true;
}

async function loadApplicationReferencesFromSearchIndex(neighborhoodName) {
  const docs = await DataSearchIndex.find(
    {
      neighborhoodName: normalizeValue(neighborhoodName),
      $or: [
        { dataType: APPLICATION_REGEX },
        { componentName: APPLICATION_REGEX },
      ],
    },
    {
      rowName: 1,
      fieldByValue: 1,
      dataType: 1,
      componentName: 1,
    }
  ).sort({ rowName: 1, _id: 1 }).lean();

  return dedupeAndSortApplicationItems(
    docs.map((doc) => buildApplicationItem({ ...(doc.fieldByValue || {}), rowName: doc.rowName, dataType: doc.dataType, componentName: doc.componentName }, doc._id, neighborhoodName)).filter(Boolean)
  );
}

async function loadApplicationReferencesFromCanonicalData(neighborhoodName) {
  const docs = await CanonicalData.find(
    {
      neighborhoodName: normalizeValue(neighborhoodName),
      $or: [
        { componentType: APPLICATION_REGEX },
        { dataType: APPLICATION_REGEX },
        { primaryKey: APPLICATION_REGEX },
      ],
    },
    {
      primaryKey: 1,
      values: 1,
      componentType: 1,
      dataType: 1,
    }
  ).sort({ primaryKey: 1, _id: 1 }).lean();

  return dedupeAndSortApplicationItems(
    docs.map((doc) => buildApplicationItem({ ...(doc.values || {}), rowName: doc.primaryKey, dataType: doc.dataType, componentName: doc.componentType }, doc._id, neighborhoodName)).filter(Boolean)
  );
}

async function loadApplicationReferencesFromData(neighborhoodName) {
  const docs = await Data.find(
    {
      neighborhoodName: normalizeValue(neighborhoodName),
      $or: [
        { dataType: APPLICATION_REGEX },
        { componentType: APPLICATION_REGEX },
        { name: APPLICATION_REGEX },
      ],
    },
    {
      name: 1,
      dataType: 1,
      componentType: 1,
      rows: 1,
    }
  ).lean();

  const items = [];

  for (const doc of docs) {
    const rows = Array.isArray(doc.rows) ? doc.rows : [];
    for (const [index, row] of rows.entries()) {
      const values = row && typeof row.values === 'object' ? toPlainObject(row.values) : toPlainObject(row);
      const item = buildApplicationItem(
        {
          ...values,
          rowName: values.name || doc.name || row?.tuple || '',
          dataType: doc.dataType,
          componentName: doc.componentType || doc.name,
        },
        row?._id || `${doc._id}:${index}`,
        neighborhoodName
      );
      if (item) items.push(item);
    }
  }

  return dedupeAndSortApplicationItems(items);
}

async function listApplicationReferences(neighborhoodName) {
  const normalizedNeighborhoodName = normalizeValue(neighborhoodName);
  const fromCanonical = (await loadApplicationReferencesFromCanonicalData(normalizedNeighborhoodName)).filter((item) => isValidApplicationName(item?.name));
  if (fromCanonical.length) return fromCanonical;

  const fromIndex = (await loadApplicationReferencesFromSearchIndex(normalizedNeighborhoodName)).filter((item) => isValidApplicationName(item?.name));
  if (fromIndex.length) return fromIndex;
  const fromData = await loadApplicationReferencesFromData(normalizedNeighborhoodName);
  return fromData.filter((item) => isValidApplicationName(item?.name));
}

async function findApplicationReferenceByField(neighborhoodName, fieldName, value) {
  const normalizedValue = normalizeKey(value);
  if (!normalizedValue) return null;
  const items = await listApplicationReferences(neighborhoodName);
  return items.find((item) => normalizeKey(item[fieldName]) === normalizedValue) || null;
}

async function findApplicationByCorrelationId(neighborhoodName, correlationId) {
  return findApplicationReferenceByField(neighborhoodName, 'correlationId', correlationId);
}

async function findApplicationByAcronym(neighborhoodName, acronym) {
  return findApplicationReferenceByField(neighborhoodName, 'acronym', acronym);
}

// Looked up from tree/diagram labels, which may display an app's name,
// acronym, or correlationId depending on context — match whichever field
// actually identifies the record instead of requiring an exact name match.
async function findApplicationByName(neighborhoodName, name) {
  const normalizedValue = normalizeKey(name);
  if (!normalizedValue) return null;
  const items = await listApplicationReferences(neighborhoodName);
  return items.find((item) => [item.name, item.acronym, item.correlationId]
    .some((candidate) => normalizeKey(candidate) === normalizedValue)) || null;
}

// Does this FK column's target subtab refer to an Applications-type target?
// Deliberately checks only the subtab (targetScope), not the tab (targetGroup),
// so it works regardless of which tab the reference was written under
// (e.g. legacy "FK_Data[Applications]..." and current
// "FK_System Components[Applications]..." both resolve the same way).
function isApplicationTargetScope(targetScope) {
  return APPLICATION_REGEX.test(normalizeValue(targetScope));
}

// Classifies a target column name (e.g. "APP_ID", "correlation_id qualifier")
// against the same alias lists buildApplicationItem() uses, so a column name
// means the same thing whether it's feeding an Application's own record or
// being referenced by an FK_ column elsewhere.
function classifyApplicationFieldAlias(columnName) {
  const key = normalizeColumnAlias(columnName);
  if (!key) return null;
  if (APPLICATION_CORRELATION_ID_ALIASES.some((alias) => normalizeColumnAlias(alias) === key)) return 'correlationId';
  if (APPLICATION_ACRONYM_ALIASES.some((alias) => normalizeColumnAlias(alias) === key)) return 'acronym';
  if (APPLICATION_NAME_ALIASES.some((alias) => normalizeColumnAlias(alias) === key)) return 'name';
  return null;
}

// Generic replacement for the hardcoded APP_FK_FIELDS/APP_ACRONYM_FIELDS/
// APP_NAME_FIELDS whitelists that used to live separately in
// server/routes/servers.js and server/routes/databases.js. Scans a row's
// fieldByValue for either:
//   - an FK_<Tab>[<Applications-like subtab>].<Column> header (generic FK
//     convention — Column is classified via the same aliases as above), or
//   - a plain column whose name directly matches one of those aliases
//     (backward-compatible with data uploaded without the FK_ convention).
function findLinkedApplicationsFromFieldByValue(fieldByValue) {
  const source = toPlainObject(fieldByValue);
  const result = { correlationId: null, acronym: null, name: null };
  let found = false;

  for (const [key, rawValue] of Object.entries(source)) {
    const value = normalizeValue(rawValue);
    if (!value) continue;

    const fk = parseFkColumnKey(key);
    let candidateColumnName = normalizeValue(key);
    if (fk) {
      if (!isApplicationTargetScope(fk.targetScope)) continue; // FK column, but points at a different target
      candidateColumnName = fk.columnName;
    }

    const fieldKey = classifyApplicationFieldAlias(candidateColumnName);
    if (!fieldKey || result[fieldKey]) continue;
    result[fieldKey] = value;
    found = true;
  }

  return found ? [result] : [];
}

// Derives a human-readable name for a canonical row from its own values —
// deliberately NOT from primaryKey, which may be a composite
// ("name|fk1|fk2|...") when the row's identity depends on what it links to
// (see materializer.js primaryKeyFromRow). Mirrors getRowName() in
// searchIndexBuilder.js so display names stay consistent across the app.
function deriveDisplayName(values) {
  const plain = toPlainObject(values);
  if (plain.name) return String(plain.name).trim();
  const componentKey = Object.keys(plain).find((key) => /(?:^|\s)component$/i.test(String(key).trim()));
  if (componentKey && String(plain[componentKey] || '').trim()) return String(plain[componentKey]).trim();
  return 'Unnamed';
}

// Which component/data types under `neighborhoodName` have at least one row
// with an FK_ column pointing at a subtab matching `targetScopeName` (e.g.
// "Applications")? This is what drives the diagram app right-click menu —
// entirely data-driven: a brand-new uploaded type with its own FK_ column
// shows up automatically, no code change needed. Sampling a handful of rows
// per type (rather than every row) keeps this cheap; uploaded sheets have a
// uniform column structure within a type, so a sample is representative.
async function discoverComponentTypesLinkedToTarget(neighborhoodName, targetScopeName, sampleSize = 5) {
  const targetRegex = new RegExp(`^(?:${escapeRegex(targetScopeName)}s?)$`, 'i');
  const isTargetScope = (scope) => targetRegex.test(normalizeValue(scope));

  const componentTypes = await CanonicalData.distinct('componentType', { neighborhoodName });
  const linkedTypes = [];

  for (const componentType of componentTypes) {
    if (isTargetScope(componentType)) continue; // don't report a type as linked to itself
    const samples = await CanonicalData.find({ neighborhoodName, componentType }, { values: 1 }).limit(sampleSize).lean();
    const hasLink = samples.some((doc) => Object.keys(toPlainObject(doc.values)).some((key) => {
      const fk = parseFkColumnKey(key);
      return fk && isTargetScope(fk.targetScope);
    }));
    if (hasLink) linkedTypes.push(componentType);
  }

  return linkedTypes.sort((a, b) => a.localeCompare(b));
}

// All rows of `componentType` under `neighborhoodName` whose FK_ column(s)
// pointing at Applications resolve to `correlationId`. Generic across any
// componentType — Servers, Software, or any future type — via the same
// findLinkedApplicationsFromFieldByValue() used to build that FK in the
// first place, so "what links here" and "what's linked to this app" always
// agree by construction.
async function findRecordsLinkedToApplication(neighborhoodName, componentType, correlationId) {
  const normalizedCorrelationId = normalizeValue(correlationId);
  if (!normalizedCorrelationId) return [];

  const docs = await CanonicalData.find({ neighborhoodName, componentType }, { primaryKey: 1, values: 1 }).lean();
  const matches = docs
    .filter((doc) => findLinkedApplicationsFromFieldByValue(doc.values).some((link) => link.correlationId === normalizedCorrelationId))
    .map((doc) => ({
      id: String(doc._id),
      name: deriveDisplayName(doc.values),
      values: toPlainObject(doc.values),
    }));

  // Dedupe by display name: a composite primary key (see materializer.js
  // primaryKeyFromRow) keeps each install instance as its own row, which is
  // correct for storage but not for a "what's linked to this app" list —
  // e.g. one software title installed on 15 different servers is one
  // meaningful answer, not 15. A no-op for types that don't repeat names
  // (Servers, etc.), since dedupe key = name there is already unique.
  const seen = new Set();
  const deduped = [];
  for (const match of matches.sort((a, b) => a.name.localeCompare(b.name))) {
    const key = normalizeKey(match.name);
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(match);
  }
  return deduped;
}

module.exports = {
  APPLICATION_ALIASES,
  APPLICATION_REGEX,
  buildApplicationItem,
  classifyApplicationFieldAlias,
  dedupeAndSortApplicationItems,
  deriveDisplayName,
  discoverComponentTypesLinkedToTarget,
  findApplicationByAcronym,
  findApplicationByCorrelationId,
  findApplicationByName,
  findLinkedApplicationsFromFieldByValue,
  findRecordsLinkedToApplication,
  listApplicationReferences,
};