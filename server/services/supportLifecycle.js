/**
 * Vendor support lifecycle: when hardware, operating systems and software
 * stop being supported by their vendor, rolled up to the business flow.
 *
 * Dates:
 *   hardware  the model's vendor end of support: an estimate from its server
 *             generation (hardwareLifecycle.js) unless overridden in the
 *             register. A unit whose SUPPORT_CONTRACT is "Expired" is
 *             unsupported now. WARRANTY_EXPIRY is reported separately (out of
 *             warranty is not unsupported: support contracts carry on past it).
 *   os        Servers  OS_EOL_DATE          end of life of the server's OS version
 *   software  Software END_OF_SUPPORT_DATE  vendor end of support for that install
 * Catalog dates are Excel serials; "N/A" or blank = unknown. A register
 * override (endOfSupportOverride) replaces the date for every install of
 * that product.
 *
 * An item is unsupported at date T when its end date is on or before T.
 * Flows reach infrastructure through the applications their tasks use:
 * diagram task application (acronym) → Applications APP_ID → Servers and
 * Software rows whose FK_…[Applications].APP_ID is that id.
 *
 * Every computation also syncs the product register (VendorSupportProduct):
 * one row per hardware model / OS version / software product+version, with
 * the date range seen and a history of date changes.
 */
const CanonicalData = require('../models/CanonicalData');
const Diagram = require('../models/Diagram');
const VendorSupportProduct = require('../models/VendorSupportProduct');
const { estimateHardwareEndOfSupport } = require('./hardwareLifecycle');

const SC = 'System Components';
const FLOW_NEIGHBORHOOD = 'LLM AMI';
const MS_DAY = 86400000;
const CACHE_TTL_MS = 10 * 60 * 1000;
const SYNC_MIN_INTERVAL_MS = 60 * 60 * 1000;
const KINDS = ['hardware', 'os', 'software'];

const clean = (v) => String(v ?? '').replace(/&amp;/g, '&').replace(/&#38;/g, '&').trim();
const norm = (v) => clean(v).toLowerCase();
const iso = (d) => (d ? new Date(d).toISOString().slice(0, 10) : null);

function excelDate(serial) {
  const n = Number(serial);
  if (!Number.isFinite(n) || n < 20000) return null; // blank, "N/A", or not a plausible date
  return new Date(Math.floor(n - 25569) * MS_DAY);
}

const field = (name) => ({ $getField: { field: name, input: '$values' } });
const fkApp = { $ifNull: [field('FK_System Components[Applications].APP_ID'), field('FK_System Component[Applications].APP_ID')] };

// ── catalog load (projected server-side; the full rows are large) ────────

async function loadCatalog() {
  const [apps, servers, software, overrideRows] = await Promise.all([
    CanonicalData.aggregate([
      { $match: { neighborhoodName: SC, componentType: 'Applications' } },
      { $project: { _id: 0, appId: field('APP_ID Qualifier'), acronym: field('APP_ACRONYM Component'), name: field('APP_NAME Qualifier'), criticality: field('BUSINESS_CRITICALITY Aggregator') } },
    ]),
    CanonicalData.aggregate([
      { $match: { neighborhoodName: SC, componentType: 'Servers' } },
      { $project: {
        _id: 0, appId: fkApp, serverId: field('SERVER_ID Qualifier'), name: field('SERVER_NAME Component'),
        vendor: field('VENDOR Aggregate'), model: field('MODEL Aggregate'), role: field('SERVER_ROLE Aggregate'),
        osName: field('OS_NAME Aggregate'), osVersion: field('OS_VERSION Aggregate'), osEol: field('OS_EOL_DATE Qualifier'),
        warranty: field('WARRANTY_EXPIRY Qualifier'), contract: field('SUPPORT_CONTRACT Qualifier'),
        datacenter: field('LOCATION_DATACENTER Qualifier'), zone: field('NETWORK_ZONE Aggregate'),
      } },
    ]),
    CanonicalData.aggregate([
      { $match: { neighborhoodName: SC, componentType: 'Software' } },
      { $project: {
        _id: 0, appId: fkApp, serverId: field('FK_System Components[Servers].SERVER_ID'), softwareId: field('SOFTWARE_ID Qualifier'),
        name: field('SOFTWARE_NAME Component'), vendor: field('VENDOR Aggregate'), version: field('VERSION Qualifier'),
        eos: field('END_OF_SUPPORT_DATE Qualifier'), criticality: field('CRITICALITY Aggregator'),
      } },
    ]),
    VendorSupportProduct.find({ endOfSupportOverride: { $ne: null } }, { key: 1, endOfSupportOverride: 1 }).lean(),
  ]);
  const overrides = new Map(overrideRows.map((r) => [r.key, new Date(r.endOfSupportOverride)]));

  const items = []; // one per supportable thing
  for (const s of servers) {
    const appId = clean(s.appId);
    const expired = /^expired$/i.test(clean(s.contract));
    const estimate = estimateHardwareEndOfSupport(canonicalModel(s.model));
    items.push({
      kind: 'hardware', appId, serverId: clean(s.serverId), assetName: clean(s.name),
      vendor: clean(s.vendor), product: canonicalModel(s.model), version: '',
      endDate: estimate ? estimate.date : null, dateBasis: estimate ? estimate.basis : 'Model not recognised: no estimate',
      warrantyEnd: excelDate(s.warranty), contractExpired: expired, contract: clean(s.contract), role: clean(s.role),
    });
    items.push({
      kind: 'os', appId, serverId: clean(s.serverId), assetName: clean(s.name),
      vendor: osVendor(s.osName), product: clean(s.osName), version: clean(s.osVersion),
      endDate: excelDate(s.osEol), dateBasis: 'Catalog OS_EOL_DATE',
    });
  }
  for (const w of software) {
    items.push({
      kind: 'software', appId: clean(w.appId), serverId: clean(w.serverId), softwareId: clean(w.softwareId), assetName: clean(w.name),
      vendor: clean(w.vendor), product: clean(w.name), version: clean(w.version),
      endDate: excelDate(w.eos), dateBasis: 'Catalog END_OF_SUPPORT_DATE', criticality: clean(w.criticality),
    });
  }
  for (const it of items) {
    it.productKey = `${it.kind}|${norm(it.vendor)}|${norm(it.product)}|${norm(it.version)}`;
    if (overrides.has(it.productKey)) { it.endDate = overrides.get(it.productKey); it.dateBasis = 'Register override'; }
    it.endTime = it.endDate ? it.endDate.getTime() : null;
    it.warrantyTime = it.warrantyEnd ? it.warrantyEnd.getTime() : null;
  }

  const appById = new Map();
  const idsByAcronym = new Map();
  for (const a of apps) {
    const appId = clean(a.appId);
    if (!appId) continue;
    appById.set(appId, { appId, acronym: clean(a.acronym), name: clean(a.name) || clean(a.acronym), criticality: clean(a.criticality) });
    const key = norm(a.acronym);
    if (!idsByAcronym.has(key)) idsByAcronym.set(key, []);
    idsByAcronym.get(key).push(appId);
  }
  const itemsByApp = new Map();
  for (const it of items) {
    if (!itemsByApp.has(it.appId)) itemsByApp.set(it.appId, []);
    itemsByApp.get(it.appId).push(it);
  }
  return { items, appById, idsByAcronym, itemsByApp, counts: { applications: apps.length, servers: servers.length, software: software.length } };
}

// The catalog spells some models two ways ("Gen10+" and "Gen10 Plus").
const canonicalModel = (model) => clean(model).replace(/\bGen10\+/i, 'Gen10 Plus');

function osVendor(osName) {
  const n = norm(osName);
  if (n.startsWith('windows')) return 'Microsoft';
  if (n.startsWith('rhel') || n.includes('red hat')) return 'Red Hat';
  if (n.startsWith('ubuntu')) return 'Canonical';
  if (n.startsWith('suse') || n.startsWith('sles')) return 'SUSE';
  return clean(osName).split(/\s+/)[0] || 'Unknown';
}

async function loadFlows() {
  const diagrams = await Diagram.find({ neighborhoodName: FLOW_NEIGHBORHOOD }, { name: 1, businessFlow: 1, domain: 1, subdomain: 1, 'tasks.name': 1, 'tasks.applications.name': 1 }).lean();
  return diagrams.map((d) => ({
    diagramId: String(d._id),
    name: clean(d.businessFlow || d.name),
    domain: clean(d.domain) || 'Unassigned',
    acronyms: [...new Set((d.tasks || []).flatMap((t) => (t.applications || []).map((a) => clean(a.name))).filter(Boolean))],
  }));
}

let cache = { at: 0, promise: null };
function getBase({ fresh = false } = {}) {
  if (!cache.promise || fresh || Date.now() - cache.at > CACHE_TTL_MS) {
    const promise = Promise.all([loadCatalog(), loadFlows()]).then(([catalog, flows]) => ({ catalog, flows, loadedAt: new Date() }));
    cache = { at: Date.now(), promise };
    promise.catch(() => { if (cache.promise === promise) cache = { at: 0, promise: null }; });
    promise.then((base) => syncRegister(base.catalog.items).catch((err) => console.warn('[supportLifecycle] register sync failed:', err.message)));
  }
  return cache.promise;
}

// ── status at a date ─────────────────────────────────────────────────────

const unsupportedAt = (it, t) => (it.kind === 'hardware' && it.contractExpired) || (it.endTime !== null && it.endTime <= t);

function addMonths(date, months) {
  const d = new Date(date);
  d.setUTCMonth(d.getUTCMonth() + months);
  return d;
}

function checkpoints(asOf, years) {
  const list = [{ label: 'Now', date: asOf }];
  for (let y = 1; y <= years; y += 1) list.push({ label: `+${y} year${y > 1 ? 's' : ''}`, date: addMonths(asOf, 12 * y) });
  return list;
}

function quarterSeries(asOf, years) {
  const out = [];
  for (let q = 0; q <= years * 4; q += 1) out.push(addMonths(asOf, 3 * q));
  return out;
}

/** Counts for one set of items at time t. */
function countAt(items, t, totals) {
  const c = { hardware: 0, os: 0, software: 0 };
  const servers = new Set();
  const apps = new Set();
  let outOfWarranty = 0;
  for (const it of items) {
    if (it.kind === 'hardware' && it.warrantyTime !== null && it.warrantyTime <= t) outOfWarranty += 1;
    if (!unsupportedAt(it, t)) continue;
    c[it.kind] += 1;
    if (it.kind !== 'software') servers.add(it.serverId);
    apps.add(it.appId);
  }
  return {
    hardware: c.hardware,
    os: c.os,
    software: c.software,
    serversAffected: servers.size,
    serversPct: totals.servers ? Math.round((servers.size / totals.servers) * 1000) / 10 : 0,
    softwarePct: totals.software ? Math.round((c.software / totals.software) * 1000) / 10 : 0,
    appsAffected: apps.size,
    outOfWarranty,
  };
}

/** Rating for a flow's current and 12-month position (documented in the UI). */
function rate(now, in12) {
  if (now.serversPct >= 25 || now.softwarePct >= 10) return 'red';
  if (now.serversPct > 0 || now.software > 0 || in12.serversPct >= 25 || in12.softwarePct >= 10) return 'amber';
  return 'green';
}

/** Products in `items` that are or become unsupported by `horizon`, most installs first. */
function drivers(items, horizonTime, asOfTime, limit = 10) {
  const byKey = new Map();
  for (const it of items) {
    const gone = unsupportedAt(it, horizonTime);
    if (!gone) continue;
    const e = byKey.get(it.productKey) || {
      kind: it.kind, vendor: it.vendor, product: it.product, version: it.version,
      installs: 0, unsupportedNow: 0, earliest: null, latest: null, contractExpired: 0, apps: new Set(),
    };
    e.installs += 1;
    if (unsupportedAt(it, asOfTime)) e.unsupportedNow += 1;
    if (it.contractExpired) e.contractExpired += 1;
    if (it.endTime !== null) {
      if (e.earliest === null || it.endTime < e.earliest) e.earliest = it.endTime;
      if (e.latest === null || it.endTime > e.latest) e.latest = it.endTime;
    }
    e.apps.add(it.appId);
    byKey.set(it.productKey, e);
  }
  return [...byKey.values()]
    .sort((a, b) => b.installs - a.installs || (a.earliest ?? 0) - (b.earliest ?? 0))
    .slice(0, limit)
    .map((e) => ({ ...e, earliest: iso(e.earliest), latest: iso(e.latest), apps: [...e.apps] }));
}

function resolveFlowItems(flow, catalog) {
  const appIds = new Set();
  const uncatalogued = [];
  for (const acr of flow.acronyms) {
    const ids = catalog.idsByAcronym.get(norm(acr));
    if (!ids) { uncatalogued.push(acr); continue; }
    // A few acronyms are shared by two app ids; use the ones that have infrastructure.
    const withAssets = ids.filter((id) => catalog.itemsByApp.has(id));
    (withAssets.length ? withAssets : ids).forEach((id) => appIds.add(id));
  }
  const items = [...appIds].flatMap((id) => catalog.itemsByApp.get(id) || []);
  return { appIds: [...appIds], uncatalogued, items };
}

function totalsOf(items) {
  return {
    servers: new Set(items.filter((i) => i.kind === 'hardware').map((i) => i.serverId)).size,
    software: items.filter((i) => i.kind === 'software').length,
    unknownDates: items.filter((i) => i.endTime === null && !i.contractExpired).length,
  };
}

/**
 * The flow rollup. options: asOf (Date, default today), years (1–3, default 3),
 * diagramId, flow, domain, application (acronym), includeDrivers.
 */
async function computeFlowSupport(options = {}) {
  const base = await getBase({ fresh: options.fresh });
  const asOf = options.asOf ? new Date(options.asOf) : new Date();
  const years = Math.max(1, Math.min(Number(options.years) || 3, 3));
  const points = checkpoints(asOf, years);
  const quarters = quarterSeries(asOf, years);
  const in12 = addMonths(asOf, 12).getTime();
  const horizonTime = points[points.length - 1].date.getTime();

  let flows = base.flows;
  if (options.diagramId) flows = flows.filter((f) => f.diagramId === String(options.diagramId));
  if (options.flow) flows = flows.filter((f) => norm(f.name).includes(norm(options.flow)));
  if (options.domain) flows = flows.filter((f) => norm(f.domain).includes(norm(options.domain)));
  if (options.application) flows = flows.filter((f) => f.acronyms.some((a) => norm(a) === norm(options.application)));

  const allItems = new Map(); // de-duplicated across flows for the landscape view
  const out = flows.map((flow) => {
    const { appIds, uncatalogued, items } = resolveFlowItems(flow, base.catalog);
    items.forEach((it) => allItems.set(`${it.kind}|${it.serverId}|${it.softwareId || ''}`, it));
    const totals = totalsOf(items);
    const atPoints = points.map((p) => ({ label: p.label, date: iso(p.date), ...countAt(items, p.date.getTime(), totals) }));
    const next = items.filter((it) => !unsupportedAt(it, asOf.getTime()) && it.endTime !== null).sort((a, b) => a.endTime - b.endTime)[0];
    const result = {
      diagramId: flow.diagramId,
      name: flow.name,
      domain: flow.domain,
      applications: appIds.map((id) => base.catalog.appById.get(id)?.acronym || id),
      uncataloguedApplications: uncatalogued,
      totals,
      checkpoints: atPoints,
      rating: items.length ? rate(atPoints[0], countAt(items, in12, totals)) : 'no data',
      nextLoss: next ? { date: iso(next.endTime), kind: next.kind, vendor: next.vendor, product: next.product, version: next.version, asset: next.assetName } : null,
      timeline: quarters.map((q) => ({ date: iso(q), ...pick(countAt(items, q.getTime(), totals), ['hardware', 'os', 'software', 'serversAffected']) })),
    };
    if (options.includeDrivers) result.drivers = drivers(items, horizonTime, asOf.getTime());
    return result;
  });

  const landscapeItems = options.diagramId || options.flow || options.domain || options.application
    ? [...allItems.values()]
    : base.catalog.items; // unfiltered: the whole estate, including infrastructure no flow uses
  const lt = totalsOf(landscapeItems);
  const landscape = {
    scope: options.diagramId || options.flow || options.domain || options.application ? 'matching flows' : 'whole estate',
    totals: lt,
    checkpoints: points.map((p) => ({ label: p.label, date: iso(p.date), ...countAt(landscapeItems, p.date.getTime(), lt) })),
    timeline: quarters.map((q) => ({ date: iso(q), ...pick(countAt(landscapeItems, q.getTime(), lt), ['hardware', 'os', 'software', 'serversAffected']) })),
    drivers: drivers(landscapeItems, horizonTime, asOf.getTime(), 15),
    ratings: ratingCounts(out),
  };

  const byDomain = [...groupBy(out, (f) => f.domain).entries()].map(([domain, list]) => ({
    domain,
    flows: list.length,
    ratings: ratingCounts(list),
  })).sort((a, b) => b.ratings.red - a.ratings.red || b.ratings.amber - a.ratings.amber);

  return {
    asOf: iso(asOf),
    years,
    catalogLoadedAt: base.loadedAt.toISOString(),
    sources: {
      hardware: 'Model end of vendor support, estimated as the server generation release + 8 years unless an administrator entered the vendor date; a unit whose SUPPORT_CONTRACT is "Expired" is unsupported now. Out of warranty (WARRANTY_EXPIRY) is reported separately and not counted as unsupported.',
      os: 'Servers OS_EOL_DATE',
      software: 'Software END_OF_SUPPORT_DATE ("N/A" = unknown)',
    },
    ratingRule: 'Red: ≥25% of the flow’s servers or ≥10% of its software unsupported now. Amber: anything unsupported now, or red levels reached within 12 months. Green: otherwise. No data: none of the flow’s applications has catalogued servers or software.',
    landscape,
    byDomain,
    flows: out,
  };
}

/** Every unsupported-or-soon item for one flow, for drill-down. */
async function flowAssets(diagramId, { asOf, years = 3 } = {}) {
  const base = await getBase();
  const flow = base.flows.find((f) => f.diagramId === String(diagramId));
  if (!flow) return null;
  const at = asOf ? new Date(asOf) : new Date();
  const horizon = addMonths(at, 12 * Math.max(1, Math.min(Number(years) || 3, 3))).getTime();
  const { items } = resolveFlowItems(flow, base.catalog);
  const rows = items
    .filter((it) => unsupportedAt(it, horizon))
    .map((it) => ({
      kind: it.kind, asset: it.assetName, serverId: it.serverId, softwareId: it.softwareId || null,
      application: base.catalog.appById.get(it.appId)?.acronym || it.appId,
      vendor: it.vendor, product: it.product, version: it.version,
      endDate: iso(it.endTime), dateBasis: it.dateBasis, contract: it.contract || null, warrantyEnd: iso(it.warrantyTime),
      status: unsupportedAt(it, at.getTime()) ? 'unsupported' : 'upcoming',
    }))
    .sort((a, b) => (a.endDate || '').localeCompare(b.endDate || ''));
  return { diagramId: flow.diagramId, name: flow.name, asOf: iso(at), horizon: iso(horizon), count: rows.length, assets: rows };
}

// ── product register ─────────────────────────────────────────────────────

let lastSyncAt = 0;
let syncing = null;
/** Throttled to once an hour unless forced; concurrent callers share one run. */
function syncRegister(items, { force = false } = {}) {
  if (syncing) return syncing;
  if (!force && Date.now() - lastSyncAt < SYNC_MIN_INTERVAL_MS) return Promise.resolve({ skipped: true });
  lastSyncAt = Date.now();
  syncing = doSync(items).finally(() => { syncing = null; });
  return syncing;
}

async function doSync(items) {
  const byKey = new Map();
  for (const it of items) {
    const e = byKey.get(it.productKey) || {
      key: it.productKey, kind: it.kind, vendor: it.vendor, product: it.product, version: it.version,
      earliest: null, latest: null, installs: 0, unknownDates: 0, contractExpired: 0, apps: new Set(), basis: it.dateBasis,
    };
    e.installs += 1;
    if (it.contractExpired) e.contractExpired += 1;
    if (it.endTime === null) e.unknownDates += 1;
    else {
      if (e.earliest === null || it.endTime < e.earliest) e.earliest = it.endTime;
      if (e.latest === null || it.endTime > e.latest) e.latest = it.endTime;
    }
    e.apps.add(it.appId);
    byKey.set(it.productKey, e);
  }
  const existing = new Map((await VendorSupportProduct.find({}, { key: 1, endOfSupportEarliest: 1, endOfSupportLatest: 1 }).lean()).map((r) => [r.key, r]));
  const now = new Date();
  const ops = [];
  for (const e of byKey.values()) {
    const prev = existing.get(e.key);
    const earliest = e.earliest === null ? null : new Date(e.earliest);
    const latest = e.latest === null ? null : new Date(e.latest);
    const changes = [];
    if (prev) {
      if (iso(prev.endOfSupportEarliest) !== iso(earliest)) changes.push({ at: now, field: 'endOfSupportEarliest', from: iso(prev.endOfSupportEarliest), to: iso(earliest) });
      if (iso(prev.endOfSupportLatest) !== iso(latest)) changes.push({ at: now, field: 'endOfSupportLatest', from: iso(prev.endOfSupportLatest), to: iso(latest) });
    }
    ops.push({
      updateOne: {
        filter: { key: e.key },
        update: {
          $set: {
            kind: e.kind, vendor: e.vendor, product: e.product, version: e.version,
            endOfSupportEarliest: earliest, endOfSupportLatest: latest,
            installs: e.installs, unknownDates: e.unknownDates, contractExpired: e.contractExpired,
            applicationCount: e.apps.size, source: e.kind === 'hardware' ? 'estimate' : 'catalog', dateBasis: e.basis,
            lastSyncedAt: now, retired: false,
          },
          $setOnInsert: { firstSeenAt: now },
          ...(changes.length ? { $push: { history: { $each: changes, $slice: -50 } } } : {}),
        },
        upsert: true,
      },
    });
  }
  // Products no longer in the catalog are kept (for history) but marked retired.
  const gone = [...existing.keys()].filter((k) => !byKey.has(k));
  if (gone.length) ops.push({ updateMany: { filter: { key: { $in: gone } }, update: { $set: { retired: true, lastSyncedAt: now } } } });
  if (ops.length) await VendorSupportProduct.bulkWrite(ops, { ordered: false });
  return { products: byKey.size, retired: gone.length };
}

async function listProducts({ kind, query, asOf, withinYears } = {}) {
  const base = await getBase();
  await syncRegister(base.catalog.items); // waits for a sync in progress; otherwise throttled
  const filter = { retired: { $ne: true } };
  if (KINDS.includes(kind)) filter.kind = kind;
  let rows = await VendorSupportProduct.find(filter).sort({ endOfSupportEarliest: 1 }).lean();
  if (query) rows = rows.filter((r) => `${r.vendor} ${r.product} ${r.version}`.toLowerCase().includes(norm(query)));
  const at = asOf ? new Date(asOf) : new Date();
  if (withinYears) {
    const limit = addMonths(at, 12 * Number(withinYears)).getTime();
    rows = rows.filter((r) => r.contractExpired > 0 || (r.endOfSupportEarliest && new Date(r.endOfSupportEarliest).getTime() <= limit));
  }
  return rows.map((r) => ({
    key: r.key, kind: r.kind, vendor: r.vendor, product: r.product, version: r.version,
    endOfSupportEarliest: iso(r.endOfSupportEarliest), endOfSupportLatest: iso(r.endOfSupportLatest),
    installs: r.installs, unknownDates: r.unknownDates, contractExpired: r.contractExpired, applicationCount: r.applicationCount,
    status: statusOf(r, at),
    dateBasis: r.dateBasis || null,
    override: r.endOfSupportOverride ? { date: iso(r.endOfSupportOverride), note: r.overrideNote || null, by: r.overrideBy || null, at: r.overrideAt || null } : null,
    firstSeenAt: r.firstSeenAt, lastSyncedAt: r.lastSyncedAt, history: (r.history || []).slice(-10),
  }));
}

/** Set (date) or clear (null) the vendor date for one product; applies to every install. */
async function setOverride(key, { date, note, userId }) {
  const row = await VendorSupportProduct.findOne({ key });
  if (!row) return null;
  const before = row.endOfSupportOverride ? iso(row.endOfSupportOverride) : null;
  const after = date ? iso(new Date(date)) : null;
  row.endOfSupportOverride = date ? new Date(date) : null;
  row.overrideNote = date ? String(note || '').slice(0, 500) : null;
  row.overrideBy = userId || null;
  row.overrideAt = new Date();
  row.history.push({ at: new Date(), field: 'endOfSupportOverride', from: before, to: after, by: userId || null, note: String(note || '').slice(0, 200) || null });
  await row.save();
  cache = { at: 0, promise: null }; // recompute with the new date
  lastSyncAt = 0;
  return row.toObject();
}

function statusOf(r, at) {
  const t = at.getTime();
  const e = r.endOfSupportEarliest ? new Date(r.endOfSupportEarliest).getTime() : null;
  const l = r.endOfSupportLatest ? new Date(r.endOfSupportLatest).getTime() : null;
  if (l !== null && l <= t) return 'unsupported';
  if ((e !== null && e <= t) || r.contractExpired) return 'partly unsupported';
  if (e !== null && e <= addMonths(at, 12).getTime()) return 'within 12 months';
  if (e === null) return 'unknown';
  return 'supported';
}

function ratingCounts(list) {
  const c = { red: 0, amber: 0, green: 0, 'no data': 0 };
  list.forEach((f) => { c[f.rating] += 1; });
  return c;
}
function pick(obj, keys) { return Object.fromEntries(keys.map((k) => [k, obj[k]])); }
function groupBy(list, fn) {
  const m = new Map();
  for (const x of list) { const k = fn(x); if (!m.has(k)) m.set(k, []); m.get(k).push(x); }
  return m;
}

module.exports = { computeFlowSupport, flowAssets, listProducts, syncRegister, getBase, setOverride, unsupportedAt };
