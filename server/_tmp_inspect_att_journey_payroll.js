require('dotenv').config({ path: 'server/.env' });
const mongoose = require('mongoose');
const Diagram = require('./models/Diagram');
const CanonicalComponent = require('./models/CanonicalComponent');

async function main() {
  await mongoose.connect(process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/bpmn_iq');

  const flowNames = [
    'Process Payroll',
    'Process Payroll test',
    'Manage Time',
    'Pay Inputs',
    'Calculate Payroll in Workday',
    'Post Payroll to GL',
    'Process Disbursement',
    'Onboard New Hire to Payroll',
  ];

  const diagrams = await Diagram.find(
    { neighborhoodName: 'AT&T Journey', name: { $in: flowNames } },
    { name: 1, businessFlow: 1, lineOfBusiness: 1, channel: 1, product: 1, domain: 1, subdomain: 1, valueStream: 1, journey: 1, businessCapability: 1 }
  ).lean();

  const canonicals = await CanonicalComponent.find(
    { neighborhoodName: 'AT&T Journey', primaryKey: { $in: flowNames.concat(['Manage Financial Resources', 'Payroll']) } },
    { primaryKey: 1, componentType: 1, parentRefs: 1, childrenRefs: 1 }
  ).lean();

  const canonicalById = new Map(canonicals.map((doc) => [String(doc._id), doc]));

  const expanded = [];
  for (const doc of canonicals) {
    const parents = (doc.parentRefs || []).map((id) => {
      const parent = canonicalById.get(String(id));
      return parent ? { id: String(parent._id), primaryKey: parent.primaryKey, componentType: parent.componentType } : { id: String(id) };
    });
    expanded.push({
      id: String(doc._id),
      primaryKey: doc.primaryKey,
      componentType: doc.componentType,
      parents,
      parentRefs: (doc.parentRefs || []).map(String),
      childRefs: (doc.childrenRefs || []).map(String),
    });
  }

  console.log(JSON.stringify({ diagrams, canonicals: expanded }, null, 2));
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
