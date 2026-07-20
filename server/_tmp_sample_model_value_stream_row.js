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
  await mongoose.connect(process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/bpmn_iq');
  const model = await Model.findOne({ name: neighborhoodName }, { modelCatalogRows: { $slice: 20 } }).lean();
  const rows = (model?.modelCatalogRows || []).map((row) => toPlain(row.values));
  const sample = rows.find((row) => String(row['domain Component'] || '').trim() === 'Manage Financial Resources') || rows[0] || null;
  console.log(JSON.stringify(sample, null, 2));
  await mongoose.disconnect();
}

main().catch((err) => { console.error(err); process.exit(1); });
