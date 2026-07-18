require('dotenv').config();
const mongoose = require('mongoose');
const Diagram = require('./models/Diagram');
const Model = require('./models/Model');

function getRowValues(values) {
  if (!values) return {};
  if (values instanceof Map) return Object.fromEntries(values.entries());
  return { ...values };
}

(async () => {
  await mongoose.connect(process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/bpmn_iq');
  const model = await Model.findOne({ name: 'LBGUPS' }).lean();
  const diagrams = await Diagram.find({ neighborhoodName: 'LBGUPS' }, { name: 1, valueStream: 1, domain: 1, subdomain: 1 }).lean();
  const valueStreams = [...new Set(diagrams.map((d) => String(d.valueStream || '').trim()).filter(Boolean))];

  const rows = (model.modelCatalogRows || []).map((r) => getRowValues(r.values));

  const l0Set = new Set(rows.map((r) => String(r['L0 Component'] || '').trim()).filter(Boolean));
  const l1Set = new Set(rows.map((r) => String(r['L1 Component'] || '').trim()).filter(Boolean));
  const l2Set = new Set(rows.map((r) => String(r['L2 Capability  Component'] || '').trim()).filter(Boolean));

  console.log('Total L0 distinct:', l0Set.size, [...l0Set].slice(0, 10));
  console.log('Total L1 distinct:', l1Set.size, [...l1Set].slice(0, 10));
  console.log('Total L2 distinct:', l2Set.size, [...l2Set].slice(0, 10));

  for (const vs of valueStreams) {
    const inL0 = l0Set.has(vs);
    const inL1 = l1Set.has(vs);
    const inL2 = l2Set.has(vs);
    console.log(`VS="${vs}" -> L0:${inL0} L1:${inL1} L2:${inL2}`);
    if (inL1) {
      const match = rows.find((r) => String(r['L1 Component'] || '').trim() === vs);
      console.log('   L0 parent:', match?.['L0 Component']);
    }
    if (inL2) {
      const match = rows.find((r) => String(r['L2 Capability  Component'] || '').trim() === vs);
      console.log('   L0 parent:', match?.['L0 Component'], ' L1 parent:', match?.['L1 Component']);
    }
  }

  await mongoose.disconnect();
})().catch((e) => { console.error(e); process.exit(1); });
