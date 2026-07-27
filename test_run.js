const { MongoClient } = require('mongodb');
async function main() {
  const client = new MongoClient('mongodb://127.0.0.1:27018');
  await client.connect();
  const db = client.db('bpmn_iq');

  console.log('--- 1. componentsearchindex ---');
  const coll1 = db.collection('componentsearchindex');
  const query1 = {
    $or: [
      { rowName: 'CCSF' },
      { cachedLineagePaths: 'CCSF' }
    ]
  };
  const count1 = await coll1.countDocuments(query1);
  console.log('Count:', count1);
  const docs1 = await coll1.find(query1).limit(3).toArray();
  docs1.forEach(d => {
    console.log({
      componentName: d.componentName,
      rowName: d.rowName,
      cachedLineagePaths: d.cachedLineagePaths ? d.cachedLineagePaths.slice(0, 3) : []
    });
  });

  await client.close();
}
main().catch(console.error);
