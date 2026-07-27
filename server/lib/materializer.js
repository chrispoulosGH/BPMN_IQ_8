const mongoose = require('mongoose');
const CanonicalComponent = require('../models/CanonicalComponent');
const CanonicalData = require('../models/CanonicalData');
const Data = require('../models/Data');
const DataSearchIndex = require('../models/DataSearchIndex');
const { populateComponentsFromBatches } = require('./populateComponentsFromBatches');
const { resolveParentRefs } = require('./resolveParentRefs');
const { rebuildSearchIndex } = require('../utils/searchIndexBuilder');
const { generateFlowDiagramsForNeighborhood } = require('./generateFlowDiagrams');

const MONGO_URI = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/bpmn_iq';

function primaryKeyFromRow(row) {
  if (!row) return null;
  const values = row.values && typeof row.values === 'object' ? row.values : row;
  // Support multiple possible shapes: { values: { name } } or { name }
  if (values.name || values.Name) return values.name || values.Name;
  const componentKey = Object.keys(values).find((key) => /(?:^|\s)component$/i.test(String(key).trim()));
  if (componentKey && String(values[componentKey] || '').trim()) return String(values[componentKey]).trim();
  if (row.name || row.Name) return row.name || row.Name;
  // Fall back to row data before wrapper metadata such as owner/state.
  for (const k of Object.keys(values)) {
    const v = values[k];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return null;
}

function componentTypeFromRow(row, batch) {
  if (!row && !batch) return 'unknown';
  if (row && (row.componentType || row.component_type)) return row.componentType || row.component_type;
  if (batch && batch.componentType) return batch.componentType;
  if (row && row.values && (row.values.componentType || row.values.component_type)) return row.values.componentType || row.values.component_type;
  return 'unknown';
}

function normalizeLooseKey(value) {
  return String(value || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function toPlainObject(value) {
  if (!value || typeof value !== 'object') return {};
  if (value instanceof Map) return Object.fromEntries(value.entries());
  return Array.isArray(value) ? {} : { ...value };
}

function mergeLineageVariants(existingValues, nextValues) {
  const mergedValues = { ...existingValues, ...nextValues };
  const variants = [];
  const pushVariant = (variant) => {
    if (!variant || typeof variant !== 'object') return;
    variants.push(variant);
  };

  if (existingValues.__lineage && typeof existingValues.__lineage === 'object') pushVariant(existingValues.__lineage);
  if (Array.isArray(existingValues.__lineageVariants)) existingValues.__lineageVariants.forEach(pushVariant);
  if (nextValues.__lineage && typeof nextValues.__lineage === 'object') pushVariant(nextValues.__lineage);
  if (Array.isArray(nextValues.__lineageVariants)) nextValues.__lineageVariants.forEach(pushVariant);

  const deduped = [];
  const seen = new Set();
  for (const variant of variants) {
    const key = JSON.stringify(variant);
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(variant);
  }

  if (deduped.length) {
    mergedValues.__lineage = deduped[0];
    mergedValues.__lineageVariants = deduped;
  }

  return mergedValues;
}

function getMaterializationConfig(domain = 'component') {
  if (domain === 'data') {
    return {
      domain,
      batchCollectionName: 'dataBatches',
      batchCollectionNames: ['dataBatches'],
      CanonicalModel: CanonicalData,
      ComponentModel: Data,
      SearchIndexModel: DataSearchIndex,
      indexLabel: 'DataSearchIndex',
      legacyLabel: 'POPULATE_DATA',
    };
  }

  return {
    domain: 'component',
    batchCollectionName: 'dataComponentBatches',
    CanonicalModel: CanonicalComponent,
    ComponentModel: require('../models/Component'),
    SearchIndexModel: undefined,
    indexLabel: 'ComponentSearchIndex',
    legacyLabel: 'POPULATE_COMPONENTS',
  };
}

async function materializeFromBatches({ neighborhoodName, batchIds = null, batchSize = 500, domain = 'component' } = {}) {
  if (mongoose.connection.readyState === 0) {
    await mongoose.connect(MONGO_URI, { useNewUrlParser: true, useUnifiedTopology: true });
  }

  const db = mongoose.connection.db;
  const config = getMaterializationConfig(domain);
  const query = {};
  if (neighborhoodName) query.neighborhoodName = neighborhoodName;
  if (Array.isArray(batchIds) && batchIds.length) query._id = { $in: batchIds.map(id => (typeof id === 'string' ? new mongoose.Types.ObjectId(id) : id)) };

  // Component/data load should reflect current spreadsheet truth for the neighborhood.
  // Clear canonical docs in-scope before re-materializing from selected batch rows.
  if (neighborhoodName) {
    try {
      const deleted = await config.CanonicalModel.deleteMany({ neighborhoodName });
      console.log(`[MATERIALIZER TRACE] Cleared canonical ${config.domain} docs before rematerialize`, { neighborhoodName, deleted: deleted?.deletedCount || 0 });
    } catch (err) {
      console.error('[MATERIALIZER] Failed clearing canonical docs before rematerialize:', err && err.message);
      throw err;
    }
  }

  let totalProcessed = 0;
  const batchCollectionNames = Array.isArray(config.batchCollectionNames) && config.batchCollectionNames.length
    ? config.batchCollectionNames
    : [config.batchCollectionName];

  const matStart = Date.now();
  let batchDocCount = 0;
  for (const batchCollectionName of batchCollectionNames) {
    console.log(`[MATERIALIZER TRACE] Scanning collection ${batchCollectionName} query=${JSON.stringify(query)}`);
    const cursor = db.collection(batchCollectionName).find(query).batchSize(batchSize);
    while (await cursor.hasNext()) {
      const batch = await cursor.next();
      if (!batch || !Array.isArray(batch.rows)) continue;
      batchDocCount++;
      if (batchDocCount % 100 === 0) console.log(`[MATERIALIZER TRACE] ...processed ${batchDocCount} batch docs, ${totalProcessed} rows so far (${Date.now() - matStart}ms)`);

      const ops = [];
      for (let i = 0; i < batch.rows.length; i++) {
        const row = batch.rows[i];
        const primaryKey = primaryKeyFromRow(row);
        const componentType = componentTypeFromRow(row, batch);
        if (!primaryKey) continue;

        const rowValues = (row.values && Object.assign({}, row.values)) || row;
        const filter = { neighborhoodName: batch.neighborhoodName || neighborhoodName || '', componentType, primaryKey };
        const existingDoc = await config.CanonicalModel.findOne(filter, { values: 1 }).lean();
        const mergedValues = existingDoc
          ? mergeLineageVariants(toPlainObject(existingDoc.values), toPlainObject(rowValues))
          : toPlainObject(rowValues);

        const update = {
          $set: { values: mergedValues, neighborhoodName: batch.neighborhoodName || neighborhoodName || '', componentType, dataType: batch.dataType || '', primaryKey },
          $addToSet: { sourceBatches: { batchId: String(batch._id), rowIndex: i, batchCollectionName } },
        };
        ops.push({ updateOne: { filter, update, upsert: true } });
      }

      if (ops.length) {
        // execute bulk in chunks to avoid very large ops
        const chunkSize = 500;
        for (let i = 0; i < ops.length; i += chunkSize) {
          const chunk = ops.slice(i, i + chunkSize);
          await config.CanonicalModel.bulkWrite(chunk, { ordered: false });
        }
        totalProcessed += ops.length;
      }

    }
  }

  console.log(`[MATERIALIZER TRACE] bulkWrite phase done: ${batchDocCount} batch docs, ${totalProcessed} rows in ${Date.now() - matStart}ms`);
  const result = { processed: totalProcessed };

  // Automatically run postProcess (rebuild ComponentSearchIndex) when neighborhoodName provided
  try {
    console.log('[MATERIALIZER TRACE] Starting automatic postProcess...');
    const ppStart = Date.now();
    await materializeFromBatches.postProcess({ neighborhoodName, domain });
    console.log(`[MATERIALIZER TRACE] Automatic postProcess done in ${Date.now() - ppStart}ms`);
  } catch (err) {
    console.error('[MATERIALIZER] automatic postProcess failed:', err && err.message);
  }

  return result;
}

// After materialization, if neighborhoodName provided, rebuild the ComponentSearchIndex
// so the Component Model search index is ready when load completes.
materializeFromBatches.postProcess = async function({ neighborhoodName, domain = 'component' } = {}) {
  if (!neighborhoodName) return;
  const config = getMaterializationConfig(domain);
  const batchCollectionNames = Array.isArray(config.batchCollectionNames) && config.batchCollectionNames.length
    ? config.batchCollectionNames
    : [config.batchCollectionName];
  const ppTotal = Date.now();
  try {
    console.log(`[MATERIALIZER] Post-process: populating legacy ${config.domain} docs for`, neighborhoodName);
    const legacyStart = Date.now();
    // Populate legacy `components` collection from canonical so the search index builder has source data
    try {
      for (const batchCollectionName of batchCollectionNames) {
        await populateComponentsFromBatches({
          neighborhoodName,
          batchCollectionName,
          ComponentModel: config.ComponentModel,
          logPrefix: config.legacyLabel,
        });
      }
      console.log(`[MATERIALIZER] Post-process: legacy ${config.domain} docs populated for`, neighborhoodName, `in ${Date.now() - legacyStart}ms`);
    } catch (err) {
      console.error('[MATERIALIZER] Post-process populateComponentsFromBatches failed:', err && err.message);
    }

    // Resolve parent/child relationships on canonical docs BEFORE rebuilding the index,
    // so the index builder can walk parentRefs to produce full lineage paths.
    try {
      console.log('[MATERIALIZER] Post-process: resolving parentRefs on canonical docs for', neighborhoodName);
      const refsStart = Date.now();
      let refResult = null;
      for (const batchCollectionName of batchCollectionNames) {
        // Merge parent refs from every batch source for the same domain.
        // Later sources can augment earlier ones without needing a separate migration step.
        refResult = await resolveParentRefs({
          neighborhoodName,
          batchCollectionName,
          CanonicalModel: config.CanonicalModel,
        });
      }
      console.log('[MATERIALIZER] Post-process: parentRefs resolved for', neighborhoodName, refResult, `in ${Date.now() - refsStart}ms`);
    } catch (err) {
      console.error('[MATERIALIZER] Post-process resolveParentRefs failed:', err && err.message);
    }

    // Auto-generate BPMN 2.0 diagrams from Business Process Flow / Task / Application
    // components (Model Components domain only — not System Components/'data' uploads).
    if (config.domain === 'component') {
      try {
        console.log('[MATERIALIZER] Post-process: generating flow diagrams for', neighborhoodName);
        const diagStart = Date.now();
        const diagResult = await generateFlowDiagramsForNeighborhood({ neighborhoodName });
        console.log('[MATERIALIZER] Post-process: flow diagram generation done for', neighborhoodName, diagResult, `in ${Date.now() - diagStart}ms`);
      } catch (err) {
        console.error('[MATERIALIZER] Post-process generateFlowDiagramsForNeighborhood failed:', err && err.message);
      }
    }

    console.log(`[MATERIALIZER] Post-process: rebuilding ${config.indexLabel} for`, neighborhoodName);
    const idxStart = Date.now();
    await rebuildSearchIndex(neighborhoodName, {
      CanonicalModel: config.CanonicalModel,
      SearchIndexModel: config.SearchIndexModel,
      indexLabel: config.indexLabel,
    });
    console.log(`[MATERIALIZER] Post-process: ${config.indexLabel} rebuilt for`, neighborhoodName, `in ${Date.now() - idxStart}ms`);
    console.log(`[MATERIALIZER] Post-process TOTAL for ${neighborhoodName}: ${Date.now() - ppTotal}ms`);
  } catch (err) {
    console.error('[MATERIALIZER] Post-process rebuildSearchIndex failed:', err && err.message);
  }
};

module.exports = { materializeFromBatches };

// After materialization completes, also populate legacy `components` collection
// when called directly via scripts or routes. This helper is invoked by callers
// of materializeFromBatches when they want the legacy view to be available.
materializeFromBatches.populateLegacyComponents = async function(opts) {
  try {
    const neighborhoodName = opts && opts.neighborhoodName;
    const config = getMaterializationConfig(opts && opts.domain);
    const r = await populateComponentsFromBatches({
      neighborhoodName,
      batchCollectionName: config.batchCollectionName,
      ComponentModel: config.ComponentModel,
      logPrefix: config.legacyLabel,
    });
    return r;
  } catch (err) {
    console.error('[MATERIALIZER] populateLegacyComponents failed', err && err.message);
    throw err;
  }
};
