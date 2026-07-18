require('dotenv').config();
const mongoose = require('mongoose');
const Model = require('./models/Model');

(async () => {
  await mongoose.connect(process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/bpmn_iq');
  const models = await Model.find({}, { name: 1, schemaFactories: 1, tupleType: 1 }).lean();
  for (const m of models) {
    console.log(`\n=== Model: ${m.name} ===`);
    console.log('tupleType:', JSON.stringify(m.tupleType));
    console.log('schemaFactories:', JSON.stringify((m.schemaFactories || []).map(f => ({ name: f.name, sourceColumnName: f.sourceColumnName, level: f.level, parent: f.parentFactoryName }))));
  }
  await mongoose.disconnect();
})().catch((e) => { console.error(e); process.exit(1); });
