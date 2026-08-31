'use strict';

// Seeds the applicationFeatureDevCosts collection: for every Application
// component row (real parentRefs walked up to Task -> Business Process Flow
// -> Subdomain -> Domain), creates one "combined key" document per distinct
// lineage occurrence, each holding 5 years of realistic feature-development
// funding entries (jiraFeatureKey, name, description, cost, quarter, year).
//
// Idempotent: re-running upserts by the combined key and skips any
// jiraFeatureKey that already exists, so it's safe to run more than once.
//
// Usage:
//   node scripts/seed_application_feature_dev_costs.js [neighborhoodName] [--dry-run] [--max-contexts-per-app=N]

const mongoose = require('mongoose');
const path = require('path');
const dotenv = require('dotenv');
const CanonicalComponent = require('../models/CanonicalComponent');
const ApplicationFeatureDevCost = require('../models/ApplicationFeatureDevCost');

dotenv.config({ path: path.join(__dirname, '..', '.env') });

const MONGO_URI = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/bpmn_iq';
const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const neighborhoodName = args.find((a) => !a.startsWith('--')) || 'LLM AMI';
const maxContextsPerAppArg = args.find((a) => a.startsWith('--max-contexts-per-app='));
const MAX_CONTEXTS_PER_APP = maxContextsPerAppArg ? Number(maxContextsPerAppArg.split('=')[1]) : 5;

// Last 5 fiscal years — matches the recent end of the range already used by
// scripts/seed_component_application_costs.js (2016-2025) for consistency
// across the app's cost-related seed data.
const YEARS = [2021, 2022, 2023, 2024, 2025];
const QUARTERS = ['Q1', 'Q2', 'Q3', 'Q4'];

// ─── Deterministic RNG (same approach as seed_component_application_costs.js) ───
function hashStr(input) {
  let hash = 2166136261;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = (hash * 16777619) >>> 0;
  }
  return hash;
}
function seededRng(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };
}
function randBetween(rng, min, max) {
  return rng() * (max - min) + min;
}
function randInt(rng, min, max) {
  return Math.floor(randBetween(rng, min, max + 1));
}
function pick(rng, list) {
  return list[Math.floor(rng() * list.length)];
}

// ─── Realistic feature archetypes ───────────────────────────────────────
// Generic enough to apply to any enterprise application, specific enough to
// read as real funded work rather than filler text. {app} gets substituted
// with the application's own descriptive name (falling back to its code).
const FEATURE_TEMPLATES = [
  { name: 'Single Sign-On (SSO) Integration', description: 'Integrate {app} with the corporate SAML/OIDC identity provider to eliminate standalone credentials and enforce centralized access policy.' },
  { name: 'Multi-Factor Authentication Rollout', description: 'Add MFA enforcement to {app} login flows for all privileged and dealer-facing accounts.' },
  { name: 'Role-Based Access Control Refactor', description: 'Replace {app}’s flat permission model with granular, role-based access control aligned to job function.' },
  { name: 'Mobile Responsive UI Redesign', description: 'Rebuild the {app} interface with a responsive layout so field and dealer staff can use it on tablets and phones.' },
  { name: 'Real-Time Inventory Sync', description: 'Add a real-time sync service so {app} inventory counts stay consistent with the source-of-record system.' },
  { name: 'Third-Party Payment Gateway Integration', description: 'Connect {app} to the new payment processor for faster settlement and reduced transaction fees.' },
  { name: 'API Rate Limiting & Throttling', description: 'Introduce rate limiting on {app}’s public API endpoints to protect against abuse and traffic spikes.' },
  { name: 'Webhook Notification System', description: 'Build outbound webhook support so downstream systems can subscribe to {app} events instead of polling.' },
  { name: 'Predictive Analytics Dashboard', description: 'Add a forecasting dashboard to {app} using historical trend data to support planning decisions.' },
  { name: 'Automated Regression Test Suite', description: 'Stand up an automated regression suite for {app} to reduce manual QA time ahead of releases.' },
  { name: 'Cloud Migration — Phase 2', description: 'Migrate the remaining {app} on-prem services to the cloud platform, completing the lift-and-shift effort.' },
  { name: 'Data Warehouse ETL Pipeline Upgrade', description: 'Rebuild the nightly ETL job that feeds {app} data into the enterprise warehouse for faster, more reliable loads.' },
  { name: 'GDPR/CCPA Compliance Audit Trail', description: 'Add immutable audit logging to {app} to satisfy data-privacy compliance requirements.' },
  { name: 'Customer Self-Service Portal', description: 'Extend {app} with a self-service portal so customers can complete common tasks without contacting support.' },
  { name: 'Batch Processing Performance Optimization', description: 'Rework {app}’s overnight batch jobs to cut processing time and reduce infrastructure cost.' },
  { name: 'Search Relevance Improvements', description: 'Tune {app}’s search indexing and ranking to surface more relevant results for common queries.' },
  { name: 'Legacy Database Decommission', description: 'Retire {app}’s legacy database in favor of the modernized schema, including a full data migration.' },
  { name: 'Accessibility (WCAG 2.1) Remediation', description: 'Remediate {app} screens to meet WCAG 2.1 AA accessibility standards.' },
  { name: 'Automated Deployment Pipeline (CI/CD)', description: 'Build a CI/CD pipeline for {app} to replace manual release steps with automated build, test, and deploy.' },
  { name: 'In-App Chat Support Integration', description: 'Embed live chat support into {app} to reduce support ticket volume for common questions.' },
  { name: 'Bulk Import/Export Tooling', description: 'Add bulk CSV import/export capability to {app} for high-volume data operations.' },
  { name: 'Offline Mode Support', description: 'Add offline data capture and sync-on-reconnect support to {app} for use in low-connectivity locations.' },
  { name: 'Audit & Approval Workflow Engine', description: 'Introduce a configurable approval workflow to {app} for actions that require manager sign-off.' },
  { name: 'Dashboard Widget Customization', description: 'Let users customize their {app} dashboard layout and choose which KPIs are shown.' },
  { name: 'Legacy API Versioning & Deprecation', description: 'Introduce API versioning in {app} and formally deprecate the v1 endpoints on a published timeline.' },
  { name: 'Automated Anomaly Detection Alerts', description: 'Add automated alerting to {app} when key metrics deviate from expected ranges.' },
  { name: 'Document Generation & E-Signature', description: 'Add templated document generation and e-signature capture to {app} for paperwork-heavy workflows.' },
  { name: 'Data Retention Policy Automation', description: 'Automate {app}’s data retention/purge policy to align with the updated records-management standard.' },
  { name: 'Localization for International Markets', description: 'Add multi-language and multi-currency support to {app} ahead of the international rollout.' },
  { name: 'Performance Tuning — Database Indexing', description: 'Review and rebuild {app}’s database indexes to resolve slow-query performance issues reported by users.' },
  { name: 'Push Notification Service', description: 'Add push notification support to {app} for time-sensitive alerts to mobile users.' },
  { name: 'Vendor API Contract Renegotiation Support', description: 'Update {app} integrations to support the renegotiated data-sharing contract terms with the external vendor.' },
  { name: 'Single Customer View Consolidation', description: 'Consolidate duplicate customer records surfaced through {app} into a single unified profile.' },
  { name: 'Automated Reconciliation Reporting', description: 'Add automated daily reconciliation reports to {app} to flag discrepancies before month-end close.' },
  { name: 'Disaster Recovery Failover Testing', description: 'Implement and test an automated failover path for {app} to meet the updated RTO/RPO targets.' },
  { name: 'Embedded Analytics for End Users', description: 'Embed self-service analytics directly into {app} so business users can build their own reports.' },
  { name: 'Contract Renewal Automation', description: 'Automate contract renewal reminders and workflows within {app} to reduce missed renewal windows.' },
  { name: 'Fraud Detection Rules Engine', description: 'Add a configurable rules engine to {app} to flag potentially fraudulent transactions in real time.' },
  { name: 'Voice Assistant Integration', description: 'Integrate {app} with the internal voice-assistant platform for hands-free field use.' },
  { name: 'Unified Notification Preferences Center', description: 'Add a preferences center to {app} so users can manage email/SMS/push notification settings in one place.' },
];

function normalizeText(value) {
  return String(value || '').trim();
}

function resolveDisplayName(appValues) {
  const qualifier = normalizeText(appValues?.app_name_qualifier);
  return qualifier || normalizeText(appValues?.name) || 'the application';
}

function projectKeyFromAppName(appName) {
  const cleaned = String(appName || 'APP').toUpperCase().replace(/[^A-Z0-9]+/g, '');
  return (cleaned || 'APP').slice(0, 10);
}

function generateFeatures(seedKey, projectKeyBase, usedJiraKeys) {
  const rng = seededRng(hashStr(seedKey));
  const features = [];
  let sequence = randInt(rng, 100, 900);

  for (const year of YEARS) {
    const featureCount = randInt(rng, 1, 3); // 1-3 features funded that year (multiple can land in the same quarter)
    for (let i = 0; i < featureCount; i += 1) {
      const quarter = pick(rng, QUARTERS);
      const template = pick(rng, FEATURE_TEMPLATES);
      const appLabel = seedKey.split('|||')[0];

      sequence += randInt(rng, 1, 7);
      let jiraFeatureKey = `${projectKeyBase}-${sequence}`;
      while (usedJiraKeys.has(jiraFeatureKey)) {
        sequence += 1;
        jiraFeatureKey = `${projectKeyBase}-${sequence}`;
      }
      usedJiraKeys.add(jiraFeatureKey);

      features.push({
        jiraFeatureKey,
        featureName: template.name,
        featureDescription: template.description.replace(/\{app\}/g, appLabel),
        devCost: Math.round(randBetween(rng, 15000, 320000) / 500) * 500,
        quarter,
        year,
      });
    }
  }
  return features;
}

async function loadParent(cache, id) {
  const key = String(id || '');
  if (!key) return null;
  if (!cache.has(key)) {
    cache.set(key, await CanonicalComponent.findById(key, { componentType: 1, primaryKey: 1, parentRefs: 1 }).lean());
  }
  return cache.get(key);
}

// Walks Application -> Task -> Business Process Flow -> Subdomain -> Domain
// via real parentRefs (the same authoritative graph the search index uses),
// taking the first not-yet-visited parent at each level.
async function walkLineage(cache, startRef) {
  const chain = { task: null, businessFlow: null, subdomain: null, domain: null };
  const refs = { taskRef: null, businessFlowRef: null, subdomainRef: null, domainRef: null };
  let current = await loadParent(cache, startRef);
  const seen = new Set();

  while (current) {
    const type = String(current.componentType || '').toLowerCase();
    if (/^task$/.test(type) && !chain.task) { chain.task = current.primaryKey; refs.taskRef = current._id; }
    else if (/^business\s*(process\s*)?flow$/.test(type) && !chain.businessFlow) { chain.businessFlow = current.primaryKey; refs.businessFlowRef = current._id; }
    else if (/^subdomain$/.test(type) && !chain.subdomain) { chain.subdomain = current.primaryKey; refs.subdomainRef = current._id; }
    else if (/^domain$/.test(type) && !chain.domain) { chain.domain = current.primaryKey; refs.domainRef = current._id; }

    const nextId = (current.parentRefs || []).map(String).find((id) => id && !seen.has(id));
    if (!nextId) break;
    seen.add(nextId);
    current = await loadParent(cache, nextId);
  }

  return { chain, refs };
}

async function run() {
  await mongoose.connect(MONGO_URI);
  console.log(`Seeding applicationFeatureDevCosts for neighborhood "${neighborhoodName}"${dryRun ? ' (DRY RUN)' : ''}...`);

  const apps = await CanonicalComponent.find(
    { neighborhoodName, componentType: { $regex: /^application$/i } },
    { primaryKey: 1, values: 1, parentRefs: 1 }
  ).lean();

  if (!apps.length) {
    console.log('No Application components found. Nothing to seed.');
    await mongoose.disconnect();
    return;
  }

  const parentCache = new Map();
  const usedJiraKeys = new Set();
  // Pre-load any jiraFeatureKey already in the collection so re-runs never collide.
  const existingKeys = await ApplicationFeatureDevCost.distinct('features.jiraFeatureKey');
  existingKeys.forEach((k) => usedJiraKeys.add(k));

  let combinedKeysCreated = 0;
  let combinedKeysSkipped = 0;
  let featuresCreated = 0;
  let appsProcessed = 0;
  let appsWithNoLineage = 0;

  for (const app of apps) {
    appsProcessed += 1;
    const appName = app.primaryKey;
    const displayName = resolveDisplayName(app.values);
    const projectKeyBase = projectKeyFromAppName(appName);
    const parentRefs = (app.parentRefs || []).slice(0, MAX_CONTEXTS_PER_APP);

    if (!parentRefs.length) {
      appsWithNoLineage += 1;
      continue;
    }

    for (const parentRef of parentRefs) {
      const { chain, refs } = await walkLineage(parentCache, parentRef);
      if (!chain.task || !chain.businessFlow || !chain.subdomain || !chain.domain) {
        appsWithNoLineage += 1;
        continue;
      }

      const existing = await ApplicationFeatureDevCost.findOne({
        neighborhoodName,
        domain: chain.domain,
        subdomain: chain.subdomain,
        businessFlow: chain.businessFlow,
        task: chain.task,
        application: appName,
      }, { _id: 1 }).lean();

      if (existing) {
        combinedKeysSkipped += 1;
        continue;
      }

      const seedKey = `${displayName}|||${chain.domain}|||${chain.subdomain}|||${chain.businessFlow}|||${chain.task}|||${appName}`;
      const features = generateFeatures(seedKey, projectKeyBase, usedJiraKeys);

      combinedKeysCreated += 1;
      featuresCreated += features.length;

      if (!dryRun) {
        await ApplicationFeatureDevCost.create({
          neighborhoodName,
          domain: chain.domain,
          subdomain: chain.subdomain,
          businessFlow: chain.businessFlow,
          task: chain.task,
          application: appName,
          applicationRef: app._id,
          taskRef: refs.taskRef,
          businessFlowRef: refs.businessFlowRef,
          subdomainRef: refs.subdomainRef,
          domainRef: refs.domainRef,
          features,
        });
      }
    }
  }

  console.log(dryRun ? 'DRY RUN COMPLETE' : 'SEED COMPLETE');
  console.log(`Applications processed: ${appsProcessed}`);
  console.log(`Applications with no resolvable lineage (skipped): ${appsWithNoLineage}`);
  console.log(`Combined-key documents created: ${combinedKeysCreated}`);
  console.log(`Combined-key documents already existing (skipped): ${combinedKeysSkipped}`);
  console.log(`Feature entries created: ${featuresCreated}`);

  await mongoose.disconnect();
}

run().catch(async (error) => {
  console.error(error && error.stack ? error.stack : error);
  try { await mongoose.disconnect(); } catch {}
  process.exit(1);
});
