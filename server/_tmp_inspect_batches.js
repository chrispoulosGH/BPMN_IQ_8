require('dotenv').config();
const mongoose = require('mongoose');

(async () => {
  await mongoose.connect(process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/bpmn_iq');
  const db = mongoose.connection.db;

  const batch = await db.collection('dataComponentBatches').findOne({ neighborhoodName: 'LBGUPS' });
  console.log('Sample batch doc keys:', batch ? Object.keys(batch) : 'NONE FOUND');
  if (batch) {
    console.log(JSON.stringify(batch, null, 2).substring(0, 3000));
  }

  const count = await db.collection('dataComponentBatches').countDocuments({ neighborhoodName: 'LBGUPS' });
  console.log('\nTotal batch docs for LBGUPS:', count);

  await mongoose.disconnect();
})().catch((e) => { console.error(e); process.exit(1); });
