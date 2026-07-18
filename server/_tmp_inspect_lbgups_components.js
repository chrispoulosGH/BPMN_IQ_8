require('dotenv').config();
const mongoose = require('mongoose');
const Component = require('./models/Component');
const ComponentSearchIndex = require('./models/ComponentSearchIndex');

(async () => {
  await mongoose.connect(process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/bpmn_iq');

  const componentNames = await Component.distinct('name', { neighborhoodName: 'LBGUPS' });
  console.log('Component.distinct(name) for LBGUPS:', JSON.stringify(componentNames, null, 2));

  const indexNames = await ComponentSearchIndex.distinct('componentName', { neighborhoodName: 'LBGUPS' });
  console.log('ComponentSearchIndex.distinct(componentName) for LBGUPS:', JSON.stringify(indexNames, null, 2));

  // Sample a Value Stream entry's hierarchy if it exists
  const vsEntry = await ComponentSearchIndex.findOne({ neighborhoodName: 'LBGUPS', componentName: /value\s*stream/i }).lean();
  if (vsEntry) {
    console.log('\nSample Value Stream entry rowName:', vsEntry.rowName);
    console.log('cachedHierarchies:', JSON.stringify(vsEntry.cachedHierarchies, null, 2));
  } else {
    console.log('\nNo Value Stream componentName entry found in ComponentSearchIndex for LBGUPS');
  }

  await mongoose.disconnect();
})().catch((e) => { console.error(e); process.exit(1); });
