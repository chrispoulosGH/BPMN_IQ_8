#!/usr/bin/env node
/**
 * Backfill explicit API relationship columns: provider → API → consumer, plus
 * the server that hosts the API.
 *
 * Before this, an API row's only link was
 *   FK_System Component[Applications].APP_ID   (the provider / owning app)
 * and the consumer app existed only as text in the description
 * ("…exchanging process data from DEALER-NET to SALES-CONFIG."). No API → server
 * link existed at all.
 *
 * Adds three columns to every API row, in BOTH places they live:
 *   - dataBatches (APIs)       the source of truth; rematerialize rebuilds from it
 *   - canonicaldata (APIs)     updated in place, so soxControlIds etc. survive
 *
 *   FK_System Components[Applications].APP_ID (Consumer)
 *       Cross-application APIs: the "to <ACRONYM>" app in the description.
 *       Internal APIs: the provider app itself (internal = same app on both ends),
 *       left blank when the provider is not a catalog app ("UNASSIGNED").
 *   FK_System Components[Servers].SERVER_ID (Host)
 *       DERIVED, not sourced: one of the provider app's own servers, preferring
 *       role API Gateway > Integration Server > Application Server >
 *       Web Server/Web Application Server > any. Picked deterministically by a
 *       hash of the API ID, so APIs spread across an app's gateways and re-runs
 *       are stable.
 *   Relationship Basis Qualifier
 *       Says where the consumer came from and how the host was chosen, so the
 *       derived host is never mistaken for inventory fact. Five app acronyms
 *       are shared by two app IDs; a consumer named by one of those resolves to
 *       the ID that actually provides APIs, else is left blank as ambiguous.
 *
 * The "(Role)" suffix is an extension of the FK_<Tab>[<Subtab>].<Column>
 * convention (see services/FK-MAPPING-GUIDE.js): parsers strip it, so the
 * target column is still APP_ID / SERVER_ID; the role only keeps two links to
 * the same target type apart.
 *
 * Canonical primaryKey is recomputed with materializer.primaryKeyFromRow(),
 * because it folds every FK_ value into the key — leaving the old key would
 * make a later rematerialize disagree with these docs.
 *
 * Idempotent: re-running recomputes the same values.
 *
 * Usage:
 *   node scripts/backfill_api_relationships.js [--dry-run]
 */
const path = require('path');
const dotenv = require('dotenv');
dotenv.config({ path: path.join(__dirname, '..', '.env') });
const mongoose = require('mongoose');
const { primaryKeyFromRow } = require('../lib/materializer');

const NEIGHBORHOOD = 'System Components';
const DRY_RUN = process.argv.includes('--dry-run');

const PROVIDER_KEYS = ['FK_System Component[Applications].APP_ID', 'FK_System Components[Applications].APP_ID'];
const CONSUMER_KEY = 'FK_System Components[Applications].APP_ID (Consumer)';
const HOST_KEY = 'FK_System Components[Servers].SERVER_ID (Host)';
const BASIS_KEY = 'Relationship Basis Qualifier';
const NEW_COLUMNS = [CONSUMER_KEY, HOST_KEY, BASIS_KEY];

const HOST_ROLE_PREFERENCE = [
  ['API Gateway'],
  ['Integration Server'],
  ['Application Server'],
  ['Web Server', 'Web Application Server'],
];

function hashString(text) {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function decodeEntities(text) {
  return String(text || '').replace(/&amp;/g, '&');
}

function getProviderAppId(values) {
  for (const key of PROVIDER_KEYS) {
    const value = String(values?.[key] || '').trim();
    if (value) return value;
  }
  return '';
}

async function main() {
  await mongoose.connect(process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/bpmn_iq');
  const db = mongoose.connection.db;
  const canonical = db.collection('canonicaldata');

  // ── Reference data: applications and servers ──
  // Applications are read from the batches, not canonical: canonical keys apps
  // by acronym, and 5 acronyms are shared by two app IDs (e.g. SERVICE-HUB =
  // LLM-029 and LLM-063), so canonical holds only 95 of the 100 apps.
  const appBatches = await db.collection('dataBatches')
    .find({ neighborhoodName: NEIGHBORHOOD, dataType: 'Applications' }, { projection: { rows: 1 } })
    .toArray();
  const appIdsByAcronym = new Map();
  const knownAppIds = new Set();
  for (const batch of appBatches) {
    for (const row of batch.rows || []) {
      const acronym = String(row.values?.['APP_ACRONYM Component'] || '').trim().toUpperCase();
      const appId = String(row.values?.['APP_ID Qualifier'] || '').trim();
      if (!appId) continue;
      knownAppIds.add(appId);
      if (!acronym) continue;
      if (!appIdsByAcronym.has(acronym)) appIdsByAcronym.set(acronym, new Set());
      appIdsByAcronym.get(acronym).add(appId);
    }
  }

  const batches = await db.collection('dataBatches').find({ neighborhoodName: NEIGHBORHOOD, dataType: 'APIs' }).toArray();
  // App IDs that actually provide APIs — the tie-breaker for a shared acronym.
  const providerAppIds = new Set(batches.flatMap((batch) => (batch.rows || []).map((row) => getProviderAppId(row.values))));

  // Returns { appId, note } for a consumer acronym from a description.
  function resolveConsumerAcronym(acronym) {
    const ids = [...(appIdsByAcronym.get(acronym) || [])].sort();
    if (ids.length === 1) return { appId: ids[0], note: '' };
    if (!ids.length) return { appId: '', note: `not in application catalog` };
    const providing = ids.filter((id) => providerAppIds.has(id));
    if (providing.length === 1) {
      return { appId: providing[0], note: `acronym shared by ${ids.join('/')}; chose ${providing[0]}, the one that provides APIs` };
    }
    return { appId: '', note: `ambiguous: acronym shared by ${ids.join('/')}` };
  }

  const serverDocs = await canonical.aggregate([
    { $match: { neighborhoodName: NEIGHBORHOOD, componentType: 'Servers' } },
    {
      $project: {
        _id: 0,
        appId: { $ifNull: [
          { $getField: { field: 'FK_System Components[Applications].APP_ID', input: '$values' } },
          { $getField: { field: 'FK_System Component[Applications].APP_ID', input: '$values' } },
        ] },
        serverId: '$values.SERVER_ID Qualifier',
        role: '$values.SERVER_ROLE Aggregate',
      },
    },
  ]).toArray();
  const serversByAppId = new Map();
  for (const server of serverDocs) {
    const appId = String(server.appId || '').trim();
    const serverId = String(server.serverId || '').trim();
    if (!appId || !serverId) continue;
    if (!serversByAppId.has(appId)) serversByAppId.set(appId, []);
    serversByAppId.get(appId).push({ serverId, role: String(server.role || '').trim() });
  }
  for (const list of serversByAppId.values()) list.sort((a, b) => a.serverId.localeCompare(b.serverId));

  console.log(`[api-rel] ${knownAppIds.size} applications (${appIdsByAcronym.size} acronyms), ${serverDocs.length} servers across ${serversByAppId.size} apps`);

  // ── The relationship rule, applied identically to batch rows and canonical docs ──
  const stats = { rows: 0, crossApp: 0, internal: 0, consumerUnresolved: 0, hostByRole: {}, noHost: 0 };
  const unresolvedConsumers = new Map();

  function computeRelationships(values) {
    const providerAppId = getProviderAppId(values);
    const apiId = String(values?.['API ID Qualifier'] || values?.['API Name Component'] || '');
    const description = decodeEntities(values?.['Description Qualifier']);
    const scope = String(values?.['Interaction Scope Aggregate'] || '').trim();

    const providerKnown = knownAppIds.has(providerAppId);
    let consumerAppId = '';
    let consumerBasis = '';
    const toMatch = /\bfrom\s+(\S+)\s+to\s+(\S+?)\.?\s*$/i.exec(description);
    if (toMatch) {
      const consumerAcronym = toMatch[2].toUpperCase();
      const resolved = resolveConsumerAcronym(consumerAcronym);
      consumerAppId = resolved.appId;
      consumerBasis = consumerAppId
        ? `Consumer: "to ${consumerAcronym}" in description${resolved.note ? ` (${resolved.note})` : ''}.`
        : `Consumer: unresolved "to ${consumerAcronym}" (${resolved.note}).`;
      if (!consumerAppId) unresolvedConsumers.set(consumerAcronym, (unresolvedConsumers.get(consumerAcronym) || 0) + 1);
    } else if (/^internal$/i.test(scope) && providerKnown) {
      consumerAppId = providerAppId;
      consumerBasis = 'Consumer: internal API, same app as provider.';
    } else if (/^internal$/i.test(scope)) {
      consumerBasis = `Consumer: none, internal API whose provider "${providerAppId || '(blank)'}" is not a catalog app.`;
    } else {
      consumerBasis = 'Consumer: not stated in description.';
    }

    const candidates = providerKnown ? (serversByAppId.get(providerAppId) || []) : [];
    let hostServerId = '';
    let hostBasis = '';
    for (const roles of HOST_ROLE_PREFERENCE) {
      const pool = candidates.filter((server) => roles.includes(server.role));
      if (pool.length) {
        hostServerId = pool[hashString(apiId) % pool.length].serverId;
        hostBasis = `Host: derived, one of the provider's ${pool.length} ${roles[0]} server(s).`;
        break;
      }
    }
    if (!hostServerId && candidates.length) {
      hostServerId = candidates[hashString(apiId) % candidates.length].serverId;
      hostBasis = `Host: derived, one of the provider's ${candidates.length} server(s) (none with a gateway/integration/app/web role).`;
    }
    if (!hostServerId) {
      hostBasis = providerKnown
        ? 'Host: none, provider app has no servers.'
        : `Host: none, provider "${providerAppId || '(blank)'}" is not a catalog app.`;
    }

    return {
      providerAppId, consumerAppId, hostServerId,
      basis: `${consumerBasis} ${hostBasis}`,
      hostRoleBasis: hostBasis,
      scope, hadFromTo: Boolean(toMatch),
    };
  }

  function applyTo(values) {
    const rel = computeRelationships(values);
    return {
      ...values,
      [CONSUMER_KEY]: rel.consumerAppId,
      [HOST_KEY]: rel.hostServerId,
      [BASIS_KEY]: rel.basis,
      __rel: rel, // stripped before writing
    };
  }

  // ── 1. dataBatches (source of truth; `batches` loaded above) ──
  const batchOps = [];
  for (const batch of batches) {
    const rows = (batch.rows || []).map((row) => {
      const next = applyTo(row.values || {});
      const rel = next.__rel;
      delete next.__rel;
      stats.rows++;
      if (rel.hadFromTo) stats.crossApp++; else if (/^internal$/i.test(rel.scope)) stats.internal++;
      if (!rel.consumerAppId) stats.consumerUnresolved++;
      if (rel.hostServerId) {
        const key = rel.hostRoleBasis.replace(/\d+ /, '');
        stats.hostByRole[key] = (stats.hostByRole[key] || 0) + 1;
      } else stats.noHost++;
      return { ...row, values: next };
    });
    const columns = [...(batch.columns || [])];
    for (const column of NEW_COLUMNS) if (!columns.includes(column)) columns.push(column);
    batchOps.push({ updateOne: { filter: { _id: batch._id }, update: { $set: { rows, columns } } } });
  }

  // ── 2. canonicaldata (in place; recompute primaryKey) ──
  const apiDocs = await canonical.find({ neighborhoodName: NEIGHBORHOOD, componentType: 'APIs' }, { projection: { values: 1, primaryKey: 1 } }).toArray();
  const canonicalOps = [];
  let keyChanges = 0;
  for (const doc of apiDocs) {
    const next = applyTo(doc.values || {});
    delete next.__rel;
    const primaryKey = primaryKeyFromRow({ values: next });
    if (primaryKey !== doc.primaryKey) keyChanges++;
    canonicalOps.push({ updateOne: { filter: { _id: doc._id }, update: { $set: { values: next, primaryKey } } } });
  }

  console.log(`[api-rel] batch rows: ${stats.rows} in ${batches.length} batches`);
  console.log(`[api-rel]   cross-application (consumer from description): ${stats.crossApp}`);
  console.log(`[api-rel]   internal (consumer = provider): ${stats.internal}`);
  console.log(`[api-rel]   consumer unresolved: ${stats.consumerUnresolved}`, unresolvedConsumers.size ? Object.fromEntries(unresolvedConsumers) : '');
  console.log('[api-rel]   host assignment:', stats.hostByRole, `none: ${stats.noHost}`);
  console.log(`[api-rel] canonical API docs: ${apiDocs.length} (${keyChanges} primary keys change)`);
  const sample = batchOps[0]?.updateOne.update.$set.rows[0]?.values;
  if (sample) {
    console.log('[api-rel] sample row:', JSON.stringify({
      api: sample['API ID Qualifier'],
      description: sample['Description Qualifier'],
      provider: getProviderAppId(sample),
      consumer: sample[CONSUMER_KEY],
      host: sample[HOST_KEY],
      basis: sample[BASIS_KEY],
    }, null, 2));
  }

  if (DRY_RUN) {
    console.log('[api-rel] --dry-run: nothing written.');
  } else {
    if (batchOps.length) await db.collection('dataBatches').bulkWrite(batchOps, { ordered: true });
    for (let i = 0; i < canonicalOps.length; i += 500) {
      await canonical.bulkWrite(canonicalOps.slice(i, i + 500), { ordered: false });
    }
    console.log(`[api-rel] wrote ${batchOps.length} batches and ${canonicalOps.length} canonical docs.`);
  }

  await mongoose.disconnect();
}

main().catch(async (error) => {
  console.error('[api-rel] failed:', error);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
