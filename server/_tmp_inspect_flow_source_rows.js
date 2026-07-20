require('dotenv').config({ path: 'server/.env' });
const mongoose = require('mongoose');
const CanonicalComponent = require('./models/CanonicalComponent');

async function main() {
  const neighborhoodName = process.argv[2] || 'AT&T Journey';
  const names = process.argv.slice(3).length ? process.argv.slice(3) : ['Process Payroll', 'Manage Time'];
  await mongoose.connect(process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/bpmn_iq');
  const db = mongoose.connection.db;

  const docs = await CanonicalComponent.find(
    { neighborhoodName, primaryKey: { $in: names } },
    { primaryKey: 1, componentType: 1, sourceBatches: 1, values: 1 }
  ).lean();

  const output = [];
  for (const doc of docs) {
    const sources = [];
    for (const source of doc.sourceBatches || []) {
      const collectionName = source.batchCollectionName || 'dataComponentBatches';
      const batch = await db.collection(collectionName).findOne(
        { _id: new mongoose.Types.ObjectId(source.batchId) },
        { projection: { name: 1, componentType: 1, parentFactoryName: 1, rows: { $slice: [source.rowIndex, 1] } } }
      );
      sources.push({
        source,
        batchName: batch?.name,
        batchComponentType: batch?.componentType,
        batchParentFactoryName: batch?.parentFactoryName,
        row: batch?.rows?.[0] || null,
      });
    }
    output.push({
      primaryKey: doc.primaryKey,
      componentType: doc.componentType,
      values: doc.values,
      sources,
    });
  }

  console.log(JSON.stringify(output, null, 2));
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
