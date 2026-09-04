// One-time import of the project's real server inventory
// (data/LLM AMI Servers.csv) into the legacy `servers` collection that the
// US Server Map / dashboard server-location endpoints read from.
//
// This data was never migrated into the dedicated Server model in this
// environment (the collection was empty) — `reseed-servers.js` targets an
// older CSV (ITAP_SRV_BRD_...) that no longer exists in this checkout, so it
// can't be used to backfill from the current data file. This script reads
// the CSV's actual "generic canonical component" column shape
// (`FIELD_NAME Qualifier/Aggregate/...`) instead.
//
// Usage: node scripts/import_llm_ami_servers.js
require('dotenv').config();
const path = require('path');
const mongoose = require('mongoose');
const XLSX = require('xlsx');

const Server = require('../models/Server');

const CSV_PATH = path.resolve(__dirname, '../../data/LLM AMI Servers.csv');
const MONGO_URI = process.env.MONGO_URI || process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/bpmn_iq';

function clean(value) {
  if (value === undefined || value === null) return null;
  const text = String(value).replace(/ /g, ' ').trim();
  return text || null;
}

function cleanNumber(value) {
  const text = clean(value);
  if (!text) return null;
  const numeric = Number(String(text).replace(/,/g, ''));
  return Number.isFinite(numeric) ? numeric : null;
}

// The CSV was read as plain CSV text (no real Excel date typing), so date
// columns come through as raw Excel serial-day numbers — convert those back
// to real dates for the EOL/vulnerability-scan health-note logic below.
function excelSerialToDate(serial) {
  const numeric = cleanNumber(serial);
  if (!numeric) return null;
  const utcDays = Math.floor(numeric - 25569); // Excel epoch -> Unix epoch, in days
  const utcMs = utcDays * 86400 * 1000;
  const date = new Date(utcMs);
  return Number.isNaN(date.getTime()) ? null : date;
}

function buildHealthNotes(row) {
  const notes = [];
  const criticalVulns = cleanNumber(row['CRITICAL_VULNS Qualifier']) || 0;
  const highVulns = cleanNumber(row['HIGH_VULNS Qualifier']) || 0;
  const osEolDate = excelSerialToDate(row['OS_EOL_DATE Qualifier']);
  const now = new Date();

  if (criticalVulns > 0) {
    notes.push({
      label: 'EXPOSURE_CRITICAL',
      severity: 'critical',
      note: `${criticalVulns} critical vulnerabilit${criticalVulns === 1 ? 'y' : 'ies'} detected on last scan.`,
    });
  } else if (highVulns > 0) {
    notes.push({
      label: 'KNOWN_OS_VULNERABILITIES',
      severity: 'high',
      note: `${highVulns} high-severity vulnerabilit${highVulns === 1 ? 'y' : 'ies'} detected on last scan.`,
    });
  }

  if (osEolDate && osEolDate < now) {
    notes.push({
      label: 'OS_EOL',
      severity: 'high',
      note: `OS reached end-of-life on ${osEolDate.toISOString().slice(0, 10)}.`,
    });
  }

  return notes;
}

function buildLinkedApplications(row) {
  const appId = clean(row['FK_System Components[Applications].APP_ID']);
  if (!appId) return [];
  return [{ correlationId: appId, name: null, acronym: null }];
}

async function run() {
  await mongoose.connect(MONGO_URI);
  console.log('Connected to MongoDB:', MONGO_URI.replace(/\/\/[^@]*@/, '//***:***@'));

  const existing = await Server.countDocuments();
  if (existing > 0) {
    console.log(`servers collection already has ${existing} documents — aborting so nothing is duplicated. Delete them first if you want to re-import.`);
    await mongoose.disconnect();
    return;
  }

  const workbook = XLSX.readFile(CSV_PATH, { raw: false });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(sheet, { defval: '' });
  console.log(`Read ${rows.length} rows from ${CSV_PATH}`);

  const docs = [];
  const seenKeys = new Set();
  let skipped = 0;

  for (const row of rows) {
    const sourceKey = clean(row['SERVER_ID Qualifier']) || clean(row['SERVER_NAME Component']);
    const name = clean(row['SERVER_NAME Component']) || sourceKey;
    if (!sourceKey || !name || seenKeys.has(sourceKey)) {
      skipped += 1;
      continue;
    }
    seenKeys.add(sourceKey);

    const city = clean(row['LOCATION_CITY Aggregate']);
    const country = clean(row['LOCATION_COUNTRY Aggregate']);
    const location = [city, country].filter(Boolean).join(', ') || null;

    docs.push({
      sourceKey,
      name,
      hostName: name,
      ipAddress: clean(row['IP_ADDRESS Qualifier']),
      environment: clean(row['NETWORK_ZONE Aggregate']),
      operationalStatus: clean(row['PATCHING_STATUS Qualifier']) ? 'Active' : null,
      internetFacing: clean(row['NETWORK_ZONE Aggregate']) === 'DMZ' ? 'Yes' : 'No',
      os: clean(row['OS_NAME Aggregate']),
      osVersion: clean(row['OS_VERSION Aggregate']),
      vendorName: clean(row['VENDOR Aggregate']),
      modelNumber: clean(row['MODEL Aggregate']),
      serialNumber: clean(row['SERIAL_NUMBER Qualifier']),
      cpuCount: cleanNumber(row['PROCESSOR_COUNT Qualifier']),
      cpuName: clean(row['PROCESSOR_TYPE Aggregate']),
      ram: cleanNumber(row['RAM_GB Qualifier']),
      location,
      virtualized: /vmware|hyper-v|kvm/i.test(clean(row['VIRTUALIZATION Aggregate']) || '') ? true : null,
      className: clean(row['SERVER_ROLE Aggregate']),
      linkedApplications: buildLinkedApplications(row),
      healthNotes: buildHealthNotes(row),
    });
  }

  console.log(`Inserting ${docs.length} servers (skipped ${skipped} rows with no usable id/name)...`);
  const BATCH_SIZE = 500;
  for (let i = 0; i < docs.length; i += BATCH_SIZE) {
    await Server.insertMany(docs.slice(i, i + BATCH_SIZE), { ordered: false });
    console.log(`  inserted ${Math.min(i + BATCH_SIZE, docs.length)}/${docs.length}`);
  }

  const finalCount = await Server.countDocuments();
  console.log(`Done. servers collection now has ${finalCount} documents.`);
  await mongoose.disconnect();
}

run().catch((err) => {
  console.error('Import failed:', err);
  process.exit(1);
});
