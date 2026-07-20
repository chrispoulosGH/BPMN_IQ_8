require('dotenv').config({ path: 'server/.env' });
const mongoose = require('mongoose');
const Diagram = require('./models/Diagram');
const CanonicalComponent = require('./models/CanonicalComponent');
const { generateFlowDiagramsForNeighborhood } = require('./lib/generateFlowDiagrams');

async function main() {
  const neighborhoodName = process.argv[2] || 'LBGUPS';
  await mongoose.connect(process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/bpmn_iq');

  const before = await Diagram.find(
    {
      neighborhoodName,
      $or: [
        { domain: 'Manage Financial Resources' },
        { subdomain: 'Manage Financial Resources' },
        { valueStream: 'Manage Financial Resources' },
        { name: /Manage Financial Resources/i },
        { businessFlow: /Manage Financial Resources/i },
      ],
    },
    { name: 1, businessFlow: 1, valueStream: 1, domain: 1, subdomain: 1, businessCapability: 1 }
  ).lean();

  const canonical = await CanonicalComponent.find(
    { neighborhoodName, primaryKey: 'Manage Financial Resources' },
    { componentType: 1, primaryKey: 1, parentRefs: 1, childrenRefs: 1 }
  ).lean();

  const multiParentFlows = await CanonicalComponent.find(
    { neighborhoodName, componentType: /business\s*process\s*flow/i, parentRefs: { $exists: true, $ne: [] } },
    { primaryKey: 1, parentRefs: 1 }
  ).lean();

  const result = await generateFlowDiagramsForNeighborhood({ neighborhoodName });

  const after = await Diagram.find(
    {
      neighborhoodName,
      $or: [
        { domain: 'Manage Financial Resources' },
        { subdomain: 'Manage Financial Resources' },
        { valueStream: 'Manage Financial Resources' },
        { name: /Manage Financial Resources/i },
        { businessFlow: /Manage Financial Resources/i },
      ],
    },
    { name: 1, businessFlow: 1, valueStream: 1, domain: 1, subdomain: 1, businessCapability: 1 }
  ).lean();

  const sampleMultiParent = multiParentFlows.filter((doc) => Array.isArray(doc.parentRefs) && doc.parentRefs.length > 1).slice(0, 10);

  console.log(JSON.stringify({
    neighborhoodName,
    beforeCount: before.length,
    before: before.slice(0, 20),
    canonicalCount: canonical.length,
    canonical,
    multiParentFlowCount: multiParentFlows.filter((doc) => Array.isArray(doc.parentRefs) && doc.parentRefs.length > 1).length,
    sampleMultiParent,
    regenerationResult: result,
    afterCount: after.length,
    after: after.slice(0, 20),
  }, null, 2));

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
