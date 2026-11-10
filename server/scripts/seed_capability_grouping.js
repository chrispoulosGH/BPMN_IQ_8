'use strict';

// Seeds the capabilitygroupings collection from the reviewed proposal in
// docs/capability-map-proposal.json: each of today's Business Capabilities
// gets a parent capability group (L2) and capability area (L1).
//
// Additive only. No capability is renamed, merged, split or deleted, and no
// other collection is written. Re-runnable: rows are upserted on
// (neighborhood, capability, qualifier subdomain), and rows for this
// neighborhood that are no longer in the file are removed.
//
// Usage:
//   node scripts/seed_capability_grouping.js [--dry-run] [--neighborhood="LLM AMI"] [--file=../docs/capability-map-proposal.json]

const fs = require('fs');
const mongoose = require('mongoose');
const path = require('path');
const dotenv = require('dotenv');
const CapabilityGrouping = require('../models/CapabilityGrouping');

dotenv.config({ path: path.join(__dirname, '..', '.env') });

const MONGO_URI = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/bpmn_iq';
const args = process.argv.slice(2);
const argValue = (name, fallback) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3).replace(/^"|"$/g, '') : fallback;
};
const dryRun = args.includes('--dry-run');
const NEIGHBORHOOD = argValue('neighborhood', 'LLM AMI');
const FILE = path.resolve(__dirname, argValue('file', '../../docs/capability-map-proposal.json'));

async function main() {
  const rows = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  const docs = rows.map((row) => ({
    neighborhoodName: NEIGHBORHOOD,
    capabilityName: String(row.l3 || '').trim(),
    qualifierSubdomain: row.qualifierSubdomain ? String(row.qualifierSubdomain).trim() : null,
    capabilityGroup: String(row.l2 || '').trim(),
    capabilityArea: String(row.l1 || '').trim(),
  }));

  const bad = docs.filter((d) => !d.capabilityName || !d.capabilityGroup || !d.capabilityArea);
  if (bad.length) throw new Error(`${bad.length} row(s) missing a capability, group or area`);
  const keys = new Set();
  for (const d of docs) {
    const key = `${d.capabilityName}|${d.qualifierSubdomain || ''}`;
    if (keys.has(key)) throw new Error(`duplicate mapping for ${key}`);
    keys.add(key);
  }

  const groups = new Set(docs.map((d) => `${d.capabilityArea} › ${d.capabilityGroup}`));
  const areas = new Set(docs.map((d) => d.capabilityArea));
  console.log(`${FILE}`);
  console.log(`neighborhood "${NEIGHBORHOOD}": ${docs.length} capabilities → ${groups.size} groups → ${areas.size} areas`);
  if (dryRun) {
    console.log('dry run: nothing written');
    return;
  }

  await mongoose.connect(MONGO_URI);
  try {
    const ops = docs.map((d) => ({
      updateOne: {
        filter: { neighborhoodName: d.neighborhoodName, capabilityName: d.capabilityName, qualifierSubdomain: d.qualifierSubdomain },
        update: { $set: { ...d, source: path.relative(path.join(__dirname, '..', '..'), FILE).replace(/\\/g, '/') } },
        upsert: true,
      },
    }));
    const result = await CapabilityGrouping.bulkWrite(ops, { ordered: false });
    const existing = await CapabilityGrouping.find({ neighborhoodName: NEIGHBORHOOD }, { capabilityName: 1, qualifierSubdomain: 1 }).lean();
    const stale = existing.filter((row) => !keys.has(`${row.capabilityName}|${row.qualifierSubdomain || ''}`));
    if (stale.length) await CapabilityGrouping.deleteMany({ _id: { $in: stale.map((row) => row._id) } });
    console.log(`upserted ${result.upsertedCount}, updated ${result.modifiedCount}, unchanged ${docs.length - result.upsertedCount - result.modifiedCount}, removed stale ${stale.length}`);
  } finally {
    await mongoose.disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
