'use strict';

// Seeds the efficiencyfindings collection with three categories of
// randomized-but-grounded inefficiency findings, generated against the real
// CanonicalData/Diagram records already in the database:
//
//   1. duplicate_functionality  — pairs of APIs, in different applications,
//      that sit in the same business domain and expose the same API type
//      (Task Support vs System Service) — a real, queryable overlap signal
//      in the imported API catalog, not a hand-picked list. Target: 107.
//   2. redundant_process_step   — one task per selected business-flow
//      diagram flagged as an eliminable/duplicate step. Target: 27 flows.
//   3. server_consolidation     — the lowest-utilization 17% of all Server
//      CanonicalData rows (by avg of CPU_UTIL_AVG_PCT/MEMORY_UTIL_AVG_PCT),
//      each paired with a same-role survivor its workload could move to.
//
// Clears any findings this script previously generated before re-seeding
// (pass --no-clear to append instead) — the collection has no other writer
// yet, so "re-run to get a fresh random batch" is the expected workflow.
//
// Usage:
//   node scripts/seed_efficiency_findings.js [--dry-run] [--no-clear] [--seed=<string>]

const mongoose = require('mongoose');
const path = require('path');
const dotenv = require('dotenv');
const crypto = require('crypto');
const CanonicalData = require('../models/CanonicalData');
const Diagram = require('../models/Diagram');
const EfficiencyFinding = require('../models/EfficiencyFinding');

dotenv.config({ path: path.join(__dirname, '..', '.env') });

const MONGO_URI = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/bpmn_iq';
const NEIGHBORHOOD = 'System Components';
const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const noClear = args.includes('--no-clear');
const seedArg = args.find((a) => a.startsWith('--seed='));
const RUN_SEED = seedArg ? seedArg.split('=')[1] : String(Date.now());

const DUPLICATE_FUNCTIONALITY_TARGET = 107;
const REDUNDANT_PROCESS_STEP_TARGET = 27;
const SERVER_UNDERUTILIZED_FRACTION = 0.17;

// Same FK-key shape used by server/routes/dashboard.js — the imported data
// spells this key inconsistently ("Component" vs "Components") depending on
// which sheet it came from, so match either.
const FK_APPLICATION_ID_KEY_REGEX = /^FK_System Components?\[Applications\]\.APP_ID$/i;
function getFkApplicationId(values) {
  for (const key of Object.keys(values || {})) {
    if (FK_APPLICATION_ID_KEY_REGEX.test(key)) return String(values[key] || '').trim();
  }
  return '';
}

// ─── Deterministic RNG (same approach as scripts/seed_application_feature_dev_costs.js) ───
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
function randBetween(rng, min, max) { return rng() * (max - min) + min; }
function randInt(rng, min, max) { return Math.floor(randBetween(rng, min, max + 1)); }
function pick(rng, list) { return list[Math.floor(rng() * list.length)]; }
function pickIndex(rng, n) { return Math.floor(rng() * n); }
function roundTo(value, nearest) { return Math.round(value / nearest) * nearest; }

// Fisher-Yates using the seeded RNG so the whole run is reproducible from --seed.
function shuffle(rng, list) {
  const arr = list.slice();
  for (let i = arr.length - 1; i > 0; i -= 1) {
    const j = pickIndex(rng, i + 1);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function titleCase(slug) {
  return String(slug || '')
    .split('-')
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(' ');
}

const rng = seededRng(hashStr(`efficiency-findings|||${RUN_SEED}`));

// ─── Category 1: duplicate functionality (APIs across applications) ───────
function buildDuplicateFunctionalityFindings(apis, appsById, batchId) {
  // Group by (business domain, API type) — same domain + same API-type
  // category, exposed independently by 2+ applications, is a real overlap
  // signal already present in the imported endpoint catalog.
  const groups = new Map(); // key -> Map<appId, apiDoc[]>
  for (const doc of apis) {
    const v = doc.values || {};
    const endpoint = String(v['Endpoint Qualifier'] || '');
    const segs = endpoint.split('/').filter(Boolean);
    const domainSlug = segs[2] || ''; // .../api/v1/<domain>/...
    const apiType = String(v['API Type Aggregate'] || '').trim();
    const appId = getFkApplicationId(v);
    if (!domainSlug || !apiType || !appId || !appsById.has(appId)) continue;
    const key = `${domainSlug}::${apiType}`;
    if (!groups.has(key)) groups.set(key, new Map());
    const byApp = groups.get(key);
    if (!byApp.has(appId)) byApp.set(appId, []);
    byApp.get(appId).push(doc);
  }

  const eligibleGroups = [...groups.entries()]
    .map(([key, byApp]) => ({ key, domainSlug: key.split('::')[0], apiType: key.split('::')[1], byApp }))
    .filter((g) => g.byApp.size >= 2);

  if (!eligibleGroups.length) return [];

  const findings = [];
  const usedApiPairs = new Set();
  let attempts = 0;
  const maxAttempts = DUPLICATE_FUNCTIONALITY_TARGET * 40;

  while (findings.length < DUPLICATE_FUNCTIONALITY_TARGET && attempts < maxAttempts) {
    attempts += 1;
    const group = pick(rng, eligibleGroups);
    const appIds = shuffle(rng, [...group.byApp.keys()]).slice(0, 2);
    if (appIds.length < 2) continue;
    const [appIdA, appIdB] = appIds;
    const apiA = pick(rng, group.byApp.get(appIdA));
    const apiB = pick(rng, group.byApp.get(appIdB));
    const pairKey = [String(apiA._id), String(apiB._id)].sort().join('|');
    if (usedApiPairs.has(pairKey)) continue;
    usedApiPairs.add(pairKey);

    const appA = appsById.get(appIdA);
    const appB = appsById.get(appIdB);
    const domainLabel = titleCase(group.domainSlug);
    const savings = roundTo(randBetween(rng, 60000, 180000), 1000);

    findings.push({
      category: 'duplicate_functionality',
      title: `Duplicate ${group.apiType.toLowerCase()} capability in ${domainLabel}`,
      description:
        `${appA.name} (${appA.acronym}) and ${appB.name} (${appB.acronym}) each independently expose a ${group.apiType} ` +
        `in the ${domainLabel} domain — "${apiA.values['API Name Component']}" and "${apiB.values['API Name Component']}". ` +
        `Candidate for consolidation into a single shared service.`,
      estimatedAnnualSavingsUsd: savings,
      status: 'identified',
      batchId,
      details: {
        functionalArea: domainLabel,
        apiType: group.apiType,
        apis: [apiA, apiB].map((doc, i) => ({
          apiId: doc.values['API ID Qualifier'] || doc.primaryKey,
          apiName: doc.values['API Name Component'],
          endpoint: doc.values['Endpoint Qualifier'],
          applicationId: i === 0 ? appIdA : appIdB,
          applicationAcronym: (i === 0 ? appA : appB).acronym,
          applicationName: (i === 0 ? appA : appB).name,
        })),
      },
    });
  }
  return findings;
}

// ─── Category 2: redundant process steps (business-flow tasks) ────────────
const REDUNDANT_STEP_REASON_TEMPLATES = [
  ({ taskName, actor, otherTaskName }) =>
    `"${taskName}" (performed by ${actor}) duplicates a check already made earlier in the flow by "${otherTaskName}" — no distinct outcome depends on repeating it.`,
  ({ taskName, actor }) =>
    `"${taskName}" is a manual hand-off to ${actor} that exists only to re-confirm data the upstream system already validated automatically.`,
  ({ taskName, actor, otherTaskName }) =>
    `"${taskName}" and "${otherTaskName}" are both owned by ${actor} and perform the same verification against the same source record — one is redundant.`,
  ({ taskName }) =>
    `"${taskName}" was added for a compliance requirement that has since been retired; the step still runs but nothing downstream consumes its output.`,
  ({ taskName, actor }) =>
    `"${taskName}" routes back to ${actor} for a sign-off the system already enforces via a status gate — the manual approval adds latency with no added control.`,
];

function buildRedundantProcessStepFindings(diagrams, batchId) {
  const eligible = diagrams.filter((d) => Array.isArray(d.tasks) && d.tasks.length >= 2);
  const selected = shuffle(rng, eligible).slice(0, REDUNDANT_PROCESS_STEP_TARGET);

  return selected.map((diagram) => {
    const tasks = diagram.tasks;
    const taskIndex = pickIndex(rng, tasks.length);
    const task = tasks[taskIndex];
    const otherCandidates = tasks.filter((_, i) => i !== taskIndex);
    const otherTask = otherCandidates.length ? pick(rng, otherCandidates) : null;
    const actor = task.actor || 'the process owner';
    const template = pick(rng, REDUNDANT_STEP_REASON_TEMPLATES);
    const reason = template({ taskName: task.name, actor, otherTaskName: otherTask ? otherTask.name : task.name });
    const savings = roundTo(randBetween(rng, 15000, 65000), 500);

    return {
      category: 'redundant_process_step',
      title: `Eliminable step in "${diagram.name}"`,
      description: reason,
      estimatedAnnualSavingsUsd: savings,
      status: 'identified',
      batchId,
      details: {
        diagramId: diagram._id,
        diagramName: diagram.name,
        businessFlow: diagram.businessFlow,
        domain: diagram.domain,
        taskId: task._id,
        taskName: task.name,
        actor,
        relatedTaskId: otherTask ? otherTask._id : null,
        relatedTaskName: otherTask ? otherTask.name : null,
        reason,
      },
    };
  });
}

// ─── Category 3: server consolidation (underutilized servers) ─────────────
function buildServerConsolidationFindings(servers, appsById, batchId) {
  const withUtil = servers
    .map((doc) => {
      const v = doc.values || {};
      const cpu = Number(v['CPU_UTIL_AVG_PCT Qualifier']);
      const mem = Number(v['MEMORY_UTIL_AVG_PCT Qualifier']);
      if (!Number.isFinite(cpu) || !Number.isFinite(mem)) return null;
      return { doc, cpu, mem, avgUtil: (cpu + mem) / 2 };
    })
    .filter(Boolean);

  const retireCount = Math.round(withUtil.length * SERVER_UNDERUTILIZED_FRACTION);
  const sorted = [...withUtil].sort((a, b) => a.avgUtil - b.avgUtil);
  const retiring = sorted.slice(0, retireCount);
  const retiringIds = new Set(retiring.map((r) => String(r.doc._id)));
  const survivors = withUtil.filter((r) => !retiringIds.has(String(r.doc._id)));

  const survivorsByRole = new Map();
  for (const s of survivors) {
    const role = s.doc.values['SERVER_ROLE Aggregate'] || 'Unknown';
    if (!survivorsByRole.has(role)) survivorsByRole.set(role, []);
    survivorsByRole.get(role).push(s);
  }

  return retiring.map((r) => {
    const v = r.doc.values;
    const role = v['SERVER_ROLE Aggregate'] || 'Unknown';
    const roleSurvivors = survivorsByRole.get(role);
    const sameRoleTarget = !!(roleSurvivors && roleSurvivors.length);
    const target = sameRoleTarget ? pick(rng, roleSurvivors) : (survivors.length ? pick(rng, survivors) : null);
    const appId = getFkApplicationId(v);
    const app = appsById.get(appId);
    const monthlyCost = Number(v['MONTHLY_COST_USD cost_grp_1']) || 0;
    const targetApp = target ? appsById.get(getFkApplicationId(target.doc.values)) : null;

    return {
      category: 'server_consolidation',
      title: `Retirement candidate: ${v['SERVER_NAME Component']}`,
      description:
        `${v['SERVER_NAME Component']} (${role}, ${app ? app.acronym : 'unassigned'}) runs at ${Math.round(r.avgUtil)}% average ` +
        `utilization (CPU ${r.cpu}%, memory ${r.mem}%) — a retirement candidate.` +
        (target
          ? ` Workload can be consolidated onto ${target.doc.values['SERVER_NAME Component']}` +
            ` (${Math.round(target.avgUtil)}% avg utilization, ${targetApp ? targetApp.acronym : 'unassigned'}` +
            `${sameRoleTarget ? ', same role' : `, role: ${target.doc.values['SERVER_ROLE Aggregate']}`}).`
          : ' No survivor was available as a consolidation target.'),
      estimatedAnnualSavingsUsd: roundTo(monthlyCost * 12, 1),
      status: 'identified',
      batchId,
      details: {
        retiringServer: {
          serverId: v['SERVER_ID Qualifier'],
          serverName: v['SERVER_NAME Component'],
          role,
          applicationId: appId,
          applicationAcronym: app ? app.acronym : null,
          applicationName: app ? app.name : null,
          cpuUtilPct: r.cpu,
          memoryUtilPct: r.mem,
          monthlyCostUsd: monthlyCost,
          locationDatacenter: v['LOCATION_DATACENTER Qualifier'] || null,
        },
        sameRoleTarget,
        targetServer: target ? {
          serverId: target.doc.values['SERVER_ID Qualifier'],
          serverName: target.doc.values['SERVER_NAME Component'],
          role: target.doc.values['SERVER_ROLE Aggregate'],
          applicationId: getFkApplicationId(target.doc.values),
          applicationAcronym: targetApp ? targetApp.acronym : null,
          applicationName: targetApp ? targetApp.name : null,
          cpuUtilPct: target.cpu,
          memoryUtilPct: target.mem,
        } : null,
      },
    };
  });
}

async function run() {
  await mongoose.connect(MONGO_URI);
  console.log(`Seeding efficiencyfindings (seed="${RUN_SEED}")${dryRun ? ' (DRY RUN)' : ''}...`);

  const [appDocs, apiDocs, serverDocs, diagrams] = await Promise.all([
    CanonicalData.find({ neighborhoodName: NEIGHBORHOOD, componentType: 'Applications' }, { values: 1, primaryKey: 1 }).lean(),
    CanonicalData.find({ neighborhoodName: NEIGHBORHOOD, componentType: 'APIs' }, { values: 1, primaryKey: 1 }).lean(),
    CanonicalData.find({ neighborhoodName: NEIGHBORHOOD, componentType: 'Servers' }, { values: 1, primaryKey: 1 }).lean(),
    Diagram.find({}, { name: 1, businessFlow: 1, domain: 1, tasks: 1 }).lean(),
  ]);

  const appsById = new Map();
  for (const doc of appDocs) {
    const v = doc.values || {};
    const appId = String(v['APP_ID Qualifier'] || '').trim();
    if (!appId) continue;
    const acronym = String(v['APP_ACRONYM Component'] || doc.primaryKey || '').trim();
    const name = String(v['APP_NAME Qualifier'] || acronym || appId).trim();
    appsById.set(appId, { acronym, name });
  }

  const batchId = crypto.randomUUID();
  const duplicateFindings = buildDuplicateFunctionalityFindings(apiDocs, appsById, batchId);
  const redundantFindings = buildRedundantProcessStepFindings(diagrams, batchId);
  const serverFindings = buildServerConsolidationFindings(serverDocs, appsById, batchId);
  const all = [...duplicateFindings, ...redundantFindings, ...serverFindings];

  console.log(`Applications loaded: ${appsById.size}`);
  console.log(`APIs loaded: ${apiDocs.length}`);
  console.log(`Servers loaded: ${serverDocs.length}`);
  console.log(`Diagrams loaded: ${diagrams.length}`);
  console.log('---');
  console.log(`duplicate_functionality findings: ${duplicateFindings.length} (target ${DUPLICATE_FUNCTIONALITY_TARGET})`);
  console.log(`redundant_process_step findings: ${redundantFindings.length} (target ${REDUNDANT_PROCESS_STEP_TARGET})`);
  console.log(`server_consolidation findings: ${serverFindings.length} (target ~${Math.round(serverDocs.length * SERVER_UNDERUTILIZED_FRACTION)}, ${(SERVER_UNDERUTILIZED_FRACTION * 100).toFixed(0)}% of ${serverDocs.length} servers)`);
  const totalSavings = all.reduce((sum, f) => sum + (f.estimatedAnnualSavingsUsd || 0), 0);
  console.log(`Total estimated annual savings across all findings: $${totalSavings.toLocaleString()}`);

  if (dryRun) {
    console.log('DRY RUN — nothing written.');
    await mongoose.disconnect();
    return;
  }

  if (!noClear) {
    const { deletedCount } = await EfficiencyFinding.deleteMany({});
    console.log(`Cleared ${deletedCount} previously-generated finding(s).`);
  }

  if (all.length) {
    await EfficiencyFinding.insertMany(all);
  }
  console.log(`SEED COMPLETE — inserted ${all.length} finding(s), batchId=${batchId}`);

  await mongoose.disconnect();
}

run().catch(async (error) => {
  console.error(error && error.stack ? error.stack : error);
  try { await mongoose.disconnect(); } catch {}
  process.exit(1);
});
