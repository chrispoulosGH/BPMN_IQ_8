const mongoose = require('mongoose');
const CanonicalComponent = require('../models/CanonicalComponent');

function primaryKeyFromRow(row) {
  if (!row) return null;
  const values = row.values && typeof row.values === 'object' ? row.values : row;
  if (values.name || values.Name) return values.name || values.Name;
  const componentKey = Object.keys(values).find((key) => /(?:^|\s)component$/i.test(String(key).trim()));
  if (componentKey && String(values[componentKey] || '').trim()) return String(values[componentKey]).trim();
  if (values.application || values.Application) return values.application || values.Application;
  if (row.name || row.Name) return row.name || row.Name;
  for (const key of Object.keys(values)) {
    const value = values[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

/**
 * Resolve and persist parent/child relationships on canonical components.
 *
 * Source of truth for parent relationships is `dataComponentBatches`:
 *   - each row has `parentName` (the parent's primaryKey, may be pipe-delimited for multi-parent)
 *   - each row/batch has `parentFactoryName` (the parent's componentType)
 *
 * For each canonical doc we resolve parentRefs (ObjectId links to parent canonical docs)
 * and the reverse childrenRefs. Matching is done on:
 *   { neighborhoodName, componentType = parentFactoryName, primaryKey = parentName }
 *
 * @param {Object} opts
 * @param {string} opts.neighborhoodName - required neighborhood scope
 * @returns {Promise<{updatedParents:number, updatedChildren:number, unresolved:number}>}
 */
async function resolveParentRefs({ neighborhoodName, batchCollectionName = 'dataComponentBatches', CanonicalModel = CanonicalComponent } = {}) {
  if (!neighborhoodName) {
    throw new Error('resolveParentRefs requires neighborhoodName');
  }

  if (mongoose.connection.readyState === 0) {
    const MONGO_URI = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/bpmn_iq';
    await mongoose.connect(MONGO_URI);
  }

  const db = mongoose.connection.db;

  const norm = (s) => String(s || '').trim().toLowerCase();
  const keyFor = (compType, primaryKey) => `${norm(compType)}||${norm(primaryKey)}`;

  // 1) Load all canonical docs for this neighborhood and index by (componentType, primaryKey)
  const docs = await CanonicalModel.find({ neighborhoodName }).lean();
  const idByKey = new Map();
  const keyById = new Map();
  for (const d of docs) {
    const k = keyFor(d.componentType, d.primaryKey);
    idByKey.set(k, String(d._id));
    keyById.set(String(d._id), k);
  }

  // Also index by primaryKey alone as a fallback (when parentFactoryName is missing/wrong)
  const idsByPrimaryKey = new Map();
  for (const d of docs) {
    const pk = norm(d.primaryKey);
    if (!idsByPrimaryKey.has(pk)) idsByPrimaryKey.set(pk, []);
    idsByPrimaryKey.get(pk).push(String(d._id));
  }

  // 2) Walk all batches, accumulate parentRefs/childrenRefs sets keyed by canonical _id
  const parentRefsById = new Map(); // childId -> Set(parentId)
  const childrenRefsById = new Map(); // parentId -> Set(childId)
  let unresolved = 0;

  const addParent = (childId, parentId) => {
    if (!childId || !parentId || childId === parentId) return;
    if (!parentRefsById.has(childId)) parentRefsById.set(childId, new Set());
    parentRefsById.get(childId).add(parentId);
    if (!childrenRefsById.has(parentId)) childrenRefsById.set(parentId, new Set());
    childrenRefsById.get(parentId).add(childId);
  };

  const cursor = db.collection(batchCollectionName).find({ neighborhoodName }).batchSize(200);
  while (await cursor.hasNext()) {
    const batch = await cursor.next();
    if (!batch || !Array.isArray(batch.rows)) continue;

    const batchComponentType = batch.componentType || batch.name || '';
    const batchParentFactory = batch.parentFactoryName || '';

    for (const row of batch.rows) {
      const childPrimaryKey = primaryKeyFromRow(row);
      if (!childPrimaryKey) continue;

      const childComponentType = row.componentType || row.component_type || batchComponentType;
      const childId = idByKey.get(keyFor(childComponentType, childPrimaryKey));
      if (!childId) continue; // child not materialized (shouldn't happen after full materialization)

      const parentFactory = (row.parentFactoryName && String(row.parentFactoryName).trim()) || batchParentFactory;
      const parentNameRaw = row.parentName != null ? String(row.parentName) : '';
      if (!parentNameRaw.trim()) continue; // no parent -> root node

      const parentNames = parentNameRaw.split('|').map((p) => p.trim()).filter(Boolean);
      for (const pName of parentNames) {
        // Primary match: componentType (parentFactory) + primaryKey (pName)
        let parentId = parentFactory ? idByKey.get(keyFor(parentFactory, pName)) : null;

        // Fallback: match by primaryKey alone if unambiguous
        if (!parentId) {
          const candidates = idsByPrimaryKey.get(norm(pName)) || [];
          if (candidates.length === 1) {
            parentId = candidates[0];
          }
        }

        if (parentId) {
          addParent(childId, parentId);
        } else {
          unresolved++;
        }
      }
    }
  }

  // 3) Build bulk updates
  const ops = [];
  const allIds = new Set([...parentRefsById.keys(), ...childrenRefsById.keys()]);
  for (const id of allIds) {
    const parents = parentRefsById.has(id)
      ? Array.from(parentRefsById.get(id)).map((x) => new mongoose.Types.ObjectId(x))
      : [];
    const children = childrenRefsById.has(id)
      ? Array.from(childrenRefsById.get(id)).map((x) => new mongoose.Types.ObjectId(x))
      : [];

    const setDoc = {};
    if (parents.length) setDoc.parentRefs = parents;
    if (children.length) setDoc.childrenRefs = children;
    if (Object.keys(setDoc).length === 0) continue;

    ops.push({ updateOne: { filter: { _id: new mongoose.Types.ObjectId(id) }, update: { $set: setDoc } } });
  }

  let updatedParents = 0;
  let updatedChildren = 0;
  if (ops.length) {
    const chunkSize = 500;
    for (let i = 0; i < ops.length; i += chunkSize) {
      const chunk = ops.slice(i, i + chunkSize);
      await CanonicalModel.bulkWrite(chunk, { ordered: false });
    }
    updatedParents = parentRefsById.size;
    updatedChildren = childrenRefsById.size;
  }

  console.log(`[PARENT_REFS] neighborhood="${neighborhoodName}" docsWithParents=${updatedParents} docsWithChildren=${updatedChildren} unresolvedParentRefs=${unresolved}`);
  return { updatedParents, updatedChildren, unresolved };
}

module.exports = { resolveParentRefs };
