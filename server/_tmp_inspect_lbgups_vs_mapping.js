require('dotenv').config();
const mongoose = require('mongoose');
const Diagram = require('./models/Diagram');
const Model = require('./models/Model');

(async () => {
  await mongoose.connect(process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/bpmn_iq');
  const model = await Model.findOne({ name: 'LBGUPS' }).lean();
  const diagrams = await Diagram.find({ neighborhoodName: 'LBGUPS' }, { valueStream: 1 }).lean();
  const vs = [...new Set(diagrams.map((d) => String(d.valueStream || '').trim()).filter(Boolean))];

  const rows = model.modelCatalogRows || [];
  const l0 = [...new Set(rows.map((r) => String(r.values?.['L0 Component'] || '').trim()).filter(Boolean))];
  const l1 = [...new Set(rows.map((r) => String(r.values?.['L1 Component'] || '').trim()).filter(Boolean))];
  const l2 = [...new Set(rows.map((r) => String(r.values?.['L2 Capability  Component'] || '').trim()).filter(Boolean))];

  const overlap = (a, b) => a.filter((x) => b.includes(x));

  console.log('L0 count:', l0.length, 'sample:', l0.slice(0, 10));
  console.log('L1 count:', l1.length, 'sample:', l1.slice(0, 10));
  console.log('L2 count:', l2.length, 'sample:', l2.slice(0, 10));
  console.log('VS count:', vs.length, 'sample:', vs);
  console.log('overlap VS vs L0:', overlap(vs, l0));
  console.log('overlap VS vs L1:', overlap(vs, l1));
  console.log('overlap VS vs L2:', overlap(vs, l2));

  // If value stream matches L1, find corresponding L0 (domain) and L1 (subdomain) for each vs
  if (overlap(vs, l1).length) {
    const sampleMatches = vs.map((name) => {
      const row = rows.find((r) => String(r.values?.['L1 Component'] || '').trim() === name);
      return { valueStream: name, l0: row?.values?.['L0 Component'], l1: row?.values?.['L1 Component'] };
    });
    console.log('VS->L0/L1 mapping:', JSON.stringify(sampleMatches, null, 2));
  }
  if (overlap(vs, l2).length) {
    const sampleMatches = vs.map((name) => {
      const row = rows.find((r) => String(r.values?.['L2 Capability  Component'] || '').trim() === name);
      return { valueStream: name, l0: row?.values?.['L0 Component'], l1: row?.values?.['L1 Component'], l2: row?.values?.['L2 Capability  Component'] };
    });
    console.log('VS->L0/L1/L2 mapping:', JSON.stringify(sampleMatches, null, 2));
  }

  await mongoose.disconnect();
})().catch((e) => { console.error(e); process.exit(1); });
