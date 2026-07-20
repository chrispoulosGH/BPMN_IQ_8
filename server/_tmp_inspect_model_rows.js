require('dotenv').config({ path: 'server/.env' });
const mongoose = require('mongoose');
const Model = require('./models/Model');

function toPlain(values) {
  if (!values) return {};
  if (values instanceof Map) return Object.fromEntries(values.entries());
  if (typeof values.toObject === 'function') return values.toObject();
  return { ...values };
}

async function main() {
  const neighborhoodName = process.argv[2] || 'AT&T Journey';
  const flowNames = process.argv.slice(3).length ? process.argv.slice(3) : ['Process Payroll', 'Manage Time'];
  await mongoose.connect(process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/bpmn_iq');
  const model = await Model.findOne({ name: neighborhoodName }, { modelCatalogRows: 1, modelCatalogColumns: 1 }).lean();
  const rows = (model?.modelCatalogRows || []).map((row) => toPlain(row.values));
  const matches = rows.filter((row) => flowNames.includes(String(row['Business Process Flow Component'] || row['Business Process Flow'] || row['Business Flow'] || '').trim()));
  console.log(JSON.stringify({ count: matches.length, sampleKeys: matches[0] ? Object.keys(matches[0]) : [], matches: matches.slice(0, 20) }, null, 2));
  await mongoose.disconnect();
}

main().catch((err) => { console.error(err); process.exit(1); });
