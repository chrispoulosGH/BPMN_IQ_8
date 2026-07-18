require('dotenv').config();
const mongoose = require('mongoose');
const Component = require('./models/Component');

(async () => {
  await mongoose.connect(process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/bpmn_iq');

  for (const name of ['L0', 'L1', 'Value Stream', 'Application']) {
    const comp = await Component.findOne({ neighborhoodName: 'LBGUPS', name }).lean();
    if (!comp) {
      console.log(`\n=== ${name}: NOT FOUND ===`);
      continue;
    }
    console.log(`\n=== ${name} ===`);
    console.log('columns:', JSON.stringify(comp.columns));
    console.log('parentFactoryName:', comp.parentFactoryName);
    console.log('foreignKeyColumns:', JSON.stringify(comp.foreignKeyColumns));
    console.log('qualifierColumns:', JSON.stringify(comp.qualifierColumns));
    console.log('rowCount:', (comp.rows || []).length);
    if ((comp.rows || []).length) {
      const r0 = comp.rows[0];
      const values = r0.values instanceof Map ? Object.fromEntries(r0.values) : r0.values;
      console.log('sample row values:', JSON.stringify(values));
    }
  }

  await mongoose.disconnect();
})().catch((e) => { console.error(e); process.exit(1); });
