require('dotenv').config();
const mongoose = require('mongoose');
const ComponentSearchIndex = require('./models/ComponentSearchIndex');

(async () => {
  await mongoose.connect(process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/bpmn_iq');

  const appEntry = await ComponentSearchIndex.findOne({ neighborhoodName: 'LBGUPS', componentName: 'Application' }).lean();
  if (!appEntry) {
    console.log('No Application entry found');
    await mongoose.disconnect();
    return;
  }

  console.log('Application rowName:', appEntry.rowName);
  console.log('Number of cachedHierarchies paths:', (appEntry.cachedHierarchies || []).length);
  for (const [i, path] of (appEntry.cachedHierarchies || []).slice(0, 3).entries()) {
    console.log(`\nPath ${i}:`);
    for (const node of path) {
      console.log(`  ${node.componentName}: ${node.rowName}`);
    }
  }

  await mongoose.disconnect();
})().catch((e) => { console.error(e); process.exit(1); });
