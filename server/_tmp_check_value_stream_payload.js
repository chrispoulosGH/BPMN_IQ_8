require('dotenv').config({ path: 'server/.env' });
const mongoose = require('mongoose');
const Model = require('./models/Model');
const Diagram = require('./models/Diagram');

function getRowValues(values) {
  if (!values) return {};
  if (values instanceof Map) return Object.fromEntries(values.entries());
  return { ...values };
}

function normalizeValue(value, fallback = '') {
  const normalized = String(value || '').trim();
  return normalized || fallback;
}

async function main() {
  const neighborhoodName = process.argv[2] || 'AT&T Journey';
  await mongoose.connect(process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/bpmn_iq');

  const model = await Model.findOne({ name: neighborhoodName }, { modelCatalogRows: 1 }).lean();
  const valueStreamRows = new Map();
  const capabilityCounts = new Map();
  const linkCounts = new Map();
  const rows = (model?.modelCatalogRows || []).map((row) => getRowValues(row.values));
  const hasModelValueStreamData = rows.some((row) => String(row?.['Value Stream Component'] || '').trim());

  if (hasModelValueStreamData) {
    for (const row of rows) {
      const valueStream = String(row['Value Stream Component'] || '').trim();
      if (!valueStream) continue;
      const domain = normalizeValue(row['domain Component'], 'Unspecified Domain');
      const subdomain = normalizeValue(row['subdomain Component'], 'Unspecified Subdomain');
      const capability = String(row['Business Capability Component'] || '').trim();
      const key = `${valueStream}|||${domain} | ${subdomain}`;
      valueStreamRows.set(key, {
        key,
        name: valueStream,
        domain,
        subdomain,
        rollupLabel: `${domain} | ${subdomain}`,
        count: (valueStreamRows.get(key)?.count || 0) + 1,
      });
      if (capability) {
        capabilityCounts.set(capability, (capabilityCounts.get(capability) || 0) + 1);
        const linkKey = `${capability}|||${key}`;
        linkCounts.set(linkKey, (linkCounts.get(linkKey) || 0) + 1);
      }
    }
  } else {
    const diagrams = await Diagram.find({ neighborhoodName }, { valueStream: 1, domain: 1, subdomain: 1, businessCapability: 1 }).lean();
    for (const row of diagrams) {
      const valueStream = String(row.valueStream || '').trim();
      if (!valueStream) continue;
      const domain = normalizeValue(row.domain, 'Unspecified Domain');
      const subdomain = normalizeValue(row.subdomain, 'Unspecified Subdomain');
      const capability = String(row.businessCapability || '').trim();
      const key = `${valueStream}|||${domain} | ${subdomain}`;
      valueStreamRows.set(key, {
        key,
        name: valueStream,
        domain,
        subdomain,
        rollupLabel: `${domain} | ${subdomain}`,
        count: (valueStreamRows.get(key)?.count || 0) + 1,
      });
      if (capability) {
        capabilityCounts.set(capability, (capabilityCounts.get(capability) || 0) + 1);
        const linkKey = `${capability}|||${key}`;
        linkCounts.set(linkKey, (linkCounts.get(linkKey) || 0) + 1);
      }
    }
  }

  const matches = Array.from(valueStreamRows.values()).filter((row) => row.domain === 'Manage Financial Resources' || row.subdomain === 'Manage Financial Resources' || row.name === 'Manage Financial Resources');

  console.log(JSON.stringify({
    neighborhoodName,
    source: hasModelValueStreamData ? 'modelCatalogRows' : 'diagrams',
    totalRows: valueStreamRows.size,
    matches,
    samplePayrollRows: Array.from(valueStreamRows.values()).filter((row) => row.subdomain === 'Payroll' || row.domain === 'Manage Financial Resources' || row.name === 'Payroll').slice(0, 20),
  }, null, 2));

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
