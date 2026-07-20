require('dotenv').config({ path: 'server/.env' });
const mongoose = require('mongoose');
const CanonicalComponent = require('./models/CanonicalComponent');

async function loadById(id) {
  return CanonicalComponent.findById(id, { primaryKey: 1, componentType: 1, parentRefs: 1, childrenRefs: 1 }).lean();
}

async function expandAllPaths(doc, seen = new Set(), depth = 0) {
  const docId = String(doc._id);
  if (seen.has(docId) || depth > 12) {
    return [[{ id: docId, primaryKey: doc.primaryKey, componentType: doc.componentType }]];
  }

  const nextSeen = new Set(seen);
  nextSeen.add(docId);

  const parents = Array.isArray(doc.parentRefs) ? doc.parentRefs.map(String).filter(Boolean) : [];
  if (!parents.length) {
    return [[{ id: docId, primaryKey: doc.primaryKey, componentType: doc.componentType }]];
  }

  const results = [];
  for (const parentId of parents) {
    const parent = await loadById(parentId);
    if (!parent) {
      results.push([{ id: docId, primaryKey: doc.primaryKey, componentType: doc.componentType }, { id: parentId, missing: true }]);
      continue;
    }
    const parentPaths = await expandAllPaths(parent, nextSeen, depth + 1);
    for (const parentPath of parentPaths) {
      results.push([{ id: docId, primaryKey: doc.primaryKey, componentType: doc.componentType }, ...parentPath]);
    }
  }
  return results;
}

async function main() {
  const neighborhoodName = process.argv[2] || 'AT&T Journey';
  const flowNames = process.argv.slice(3);
  const names = flowNames.length ? flowNames : ['Process Payroll', 'Manage Time', 'Calculate Payroll in Workday', 'Onboard New Hire to Payroll'];

  await mongoose.connect(process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/bpmn_iq');
  const docs = await CanonicalComponent.find(
    { neighborhoodName, primaryKey: { $in: names } },
    { primaryKey: 1, componentType: 1, parentRefs: 1, childrenRefs: 1 }
  ).lean();

  const output = [];
  for (const doc of docs) {
    const paths = await expandAllPaths(doc);
    output.push({
      flow: doc.primaryKey,
      componentType: doc.componentType,
      pathCount: paths.length,
      paths,
    });
  }

  console.log(JSON.stringify({ neighborhoodName, output }, null, 2));
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
