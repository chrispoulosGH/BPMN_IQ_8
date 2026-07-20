require('dotenv').config({ path: 'server/.env' });
const mongoose = require('mongoose');
const Model = require('./models/Model');

async function main() {
  const neighborhoodName = process.argv[2] || 'AT&T Journey';
  await mongoose.connect(process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/bpmn_iq');
  const model = await Model.findOne({ name: neighborhoodName }, { modelCatalogColumns: 1, modelCatalogRows: { $slice: 1 } }).lean();
  const firstRow = model?.modelCatalogRows?.[0]?.values;
  const firstRowKeys = firstRow instanceof Map ? Array.from(firstRow.keys()) : Object.keys(firstRow || {});
  console.log(JSON.stringify({ columns: model?.modelCatalogColumns || [], firstRowKeys }, null, 2));
  await mongoose.disconnect();
}

main().catch((err) => { console.error(err); process.exit(1); });
