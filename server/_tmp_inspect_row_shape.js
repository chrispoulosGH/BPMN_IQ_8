require('dotenv').config();
const mongoose = require('mongoose');
const Component = require('./models/Component');

(async () => {
  await mongoose.connect(process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/bpmn_iq');

  for (const name of ['L1', 'Value Stream']) {
    const comp = await Component.findOne({ neighborhoodName: 'LBGUPS', name }).lean();
    console.log(`\n=== ${name} sample rows (first 3) ===`);
    for (const row of (comp.rows || []).slice(0, 3)) {
      console.log(JSON.stringify(row, null, 2));
    }
  }

  await mongoose.disconnect();
})().catch((e) => { console.error(e); process.exit(1); });
