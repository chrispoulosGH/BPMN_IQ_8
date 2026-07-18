require('dotenv').config();
const mongoose = require('mongoose');
const Component = require('./models/Component');
const CanonicalComponent = require('./models/CanonicalComponent');

(async () => {
  await mongoose.connect(process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/bpmn_iq');

  console.log('=== Component collection (legacy) ===');
  const comps = await Component.find({ neighborhoodName: 'LBGUPS' }, { name: 1, rows: 1 }).lean();
  for (const c of comps) {
    const sources = new Set((c.rows || []).map((r) => r.sourcedFrom).filter(Boolean));
    console.log(`  ${c.name}: ${c.rows?.length || 0} rows, sources=${[...sources].join(' | ')}`);
  }

  console.log('\n=== CanonicalComponent collection ===');
  const canonicalTypes = await CanonicalComponent.aggregate([
    { $match: { neighborhoodName: 'LBGUPS' } },
    { $group: { _id: '$componentType', count: { $sum: 1 }, withParentRefs: { $sum: { $cond: [{ $gt: [{ $size: { $ifNull: ['$parentRefs', []] } }, 0] }, 1, 0] } } } },
  ]);
  for (const t of canonicalTypes) {
    console.log(`  ${t._id}: ${t.count} docs, withParentRefs=${t.withParentRefs}`);
  }

  console.log('\n=== dataComponentBatches sources ===');
  const db = mongoose.connection.db;
  const batches = await db.collection('dataComponentBatches').find({ neighborhoodName: 'LBGUPS' }, { projection: { name: 1, componentType: 1, sourceFileName: 1, rows: { $slice: 1 } } }).toArray();
  const bySource = new Map();
  for (const b of batches) {
    const key = `${b.componentType || b.name}::${b.sourceFileName}`;
    bySource.set(key, (bySource.get(key) || 0) + 1);
  }
  for (const [key, count] of bySource.entries()) {
    console.log(`  ${key} -> ${count} batch docs`);
  }

  await mongoose.disconnect();
})().catch((e) => { console.error(e); process.exit(1); });
