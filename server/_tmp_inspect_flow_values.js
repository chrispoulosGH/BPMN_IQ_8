require('dotenv').config({ path: 'server/.env' });
const mongoose = require('mongoose');
const CanonicalComponent = require('./models/CanonicalComponent');

async function main() {
  const neighborhoodName = process.argv[2] || 'AT&T Journey';
  const names = process.argv.slice(3).length
    ? process.argv.slice(3)
    : ['Process Payroll', 'Manage Time', 'Calculate Payroll in Workday', 'Onboard New Hire to Payroll'];

  await mongoose.connect(process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/bpmn_iq');

  const docs = await CanonicalComponent.find(
    { neighborhoodName, primaryKey: { $in: names } },
    { primaryKey: 1, componentType: 1, values: 1, parentRefs: 1 }
  ).lean();

  console.log(JSON.stringify(docs, null, 2));
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
