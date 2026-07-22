require('dotenv').config();
const mongoose = require('mongoose');
const Model = require('./models/Model');
const Diagram = require('./models/Diagram');

function normalizeValue(value, fallback) {
  const trimmed = String(value || '').trim();
  return trimmed || fallback;
}

async function main() {
  const neighborhoodName = 'AT&T Journey';
  await mongoose.connect(process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/bpmn_iq', { serverSelectionTimeoutMS: 8000 });

  const model = await Model.findOne({ name: neighborhoodName }, { modelCatalogRows: 1 }).lean();
  console.log('Model found:', !!model, 'modelCatalogRows length:', model?.modelCatalogRows?.length);

  const toPlain = (v) => (v instanceof Map ? Object.fromEntries(v.entries()) : (v?.toObject ? v.toObject() : v));
  const modelRows = (model?.modelCatalogRows || []).map((r) => toPlain(r.values));
  const hasModelValueStreamData = modelRows.some((row) => String(row?.['Value Stream Component'] || '').trim());
  console.log('hasModelValueStreamData:', hasModelValueStreamData);

  const diagrams = await Diagram.find({ neighborhoodName }, { name: 1, businessCapability: 1, valueStream: 1, domain: 1, subdomain: 1, capabilities: 1 }).lean();
  console.log('Total diagrams:', diagrams.length);

  const comboKey = (capability, valueStream, domain, subdomain) => [capability, valueStream, domain, subdomain]
    .map((v) => String(v || '').trim().toLowerCase())
    .join('\u001F');

  const sequenceByCombo = new Map();
  for (const row of modelRows) {
    const key = comboKey(row['Business Capability Component'], row['Value Stream Component'], row['domain Component'], row['subdomain Component']);
    if (!sequenceByCombo.has(key)) sequenceByCombo.set(key, true);
  }
  console.log('Distinct combos from model rows:', sequenceByCombo.size);

  const flowRows = diagrams.filter((d) => sequenceByCombo.has(comboKey(d.businessCapability, d.valueStream, d.domain, d.subdomain)));
  console.log('Matching diagrams (full loop):', flowRows.length, 'of', diagrams.length);

  // Show a few UNMATCHED diagrams to see why they fail to match any model row combo
  const unmatched = diagrams.filter((d) => !sequenceByCombo.has(comboKey(d.businessCapability, d.valueStream, d.domain, d.subdomain)));
  console.log('\nUnmatched diagrams sample:');
  console.log(JSON.stringify(unmatched.slice(0, 5).map((d) => ({ name: d.name, businessCapability: d.businessCapability, valueStream: d.valueStream, domain: d.domain, subdomain: d.subdomain })), null, 2));

  await mongoose.disconnect();
}

main().catch((err) => { console.error(err); process.exit(1); });
