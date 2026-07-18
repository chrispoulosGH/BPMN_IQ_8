require('dotenv').config();
const mongoose = require('mongoose');
const Diagram = require('./models/Diagram');
const Model = require('./models/Model');

(async () => {
  await mongoose.connect(process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/bpmn_iq');
  const model = await Model.findOne({ name: 'LBGUPS' }).lean();
  if (!model) {
    console.log('No LBGUPS model found');
    await mongoose.disconnect();
    return;
  }

  console.log('modelCatalogColumns:', JSON.stringify(model.modelCatalogColumns, null, 2));
  console.log('tupleType:', JSON.stringify(model.tupleType, null, 2));
  console.log('schemaFactories:', JSON.stringify((model.schemaFactories || []).map(f => ({ name: f.name, sourceColumnName: f.sourceColumnName, parentFactoryName: f.parentFactoryName, level: f.level })), null, 2));

  const firstRow = model.modelCatalogRows?.[0];
  console.log('firstRow keys:', firstRow ? Object.keys(firstRow.values || {}) : 'none');

  const diagrams = await Diagram.find({ neighborhoodName: 'LBGUPS' }, { valueStream: 1, domain: 1, subdomain: 1 }).lean();
  const vs = [...new Set(diagrams.map((d) => String(d.valueStream || '').trim()).filter(Boolean))];
  console.log('diagram valueStream sample:', vs.slice(0, 20));
  console.log('diagram count:', diagrams.length, 'with valueStream:', diagrams.filter(d => d.valueStream).length);

  await mongoose.disconnect();
})().catch((e) => { console.error(e); process.exit(1); });
