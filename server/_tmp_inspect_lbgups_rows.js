require('dotenv').config();
const mongoose = require('mongoose');
const Model = require('./models/Model');

(async () => {
  await mongoose.connect(process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/bpmn_iq');
  const model = await Model.findOne({ name: 'LBGUPS' }).lean();
  if (!model) {
    console.log('No LBGUPS model found');
    await mongoose.disconnect();
    return;
  }

  const pairs = new Map();
  for (const row of model.modelCatalogRows || []) {
    const values = row.values instanceof Map ? Object.fromEntries(row.values) : row.values || {};
    const l0 = String(values['L0 Component'] || '').trim();
    const l1 = String(values['L1 Component'] || '').trim();
    if (!l1) continue;
    if (!pairs.has(l1)) pairs.set(l1, l0);
  }

  console.log('Unique L1 -> L0 pairs:');
  for (const [l1, l0] of pairs.entries()) {
    console.log(`  L1="${l1}"  ->  L0="${l0}"`);
  }

  await mongoose.disconnect();
})().catch((e) => { console.error(e); process.exit(1); });
