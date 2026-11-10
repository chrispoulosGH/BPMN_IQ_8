'use strict';

// Seeds the soxdeviations collection: deviations (deficiencies) against ~10%
// of the SOX controls in soxcontrols (see seed_sox_controls.js), each with a
// severity (Low / Medium / High) and one of four categories:
//
//   Control Not Sufficient   — design deficiency (precision, coverage)
//   Issue Found During Audit — operating-effectiveness exceptions in testing
//   Missing Control          — a required control does not exist
//   Insufficient Evidence    — the control may operate, but can't be evidenced
//
// Every deviation records where it was found (audit name, auditor, date — or
// the non-audit source: management self-assessment, continuous controls
// monitoring, incident post-mortem) and what it affects (process, flow, task,
// applications, databases, servers, APIs), taken from the control's real
// scope — infrastructure for process-level controls comes from the supporting
// application's own ITGC scope. Audit firms and people are fictional.
//
// Controls are sampled weighted by audit risk (auditors find issues where the
// risk is). Deterministic from --seed. Clears and regenerates by default, and
// stamps deviationIds / openDeviationCount onto each affected SoxControl.
// Re-run after seed_sox_controls.js (which recreates the controls).
//
// Usage:
//   node scripts/seed_sox_deviations.js [--dry-run] [--seed=<string>] [--fraction=0.1]

const mongoose = require('mongoose');
const path = require('path');
const dotenv = require('dotenv');
const SoxControl = require('../models/SoxControl');
const SoxDeviation = require('../models/SoxDeviation');

dotenv.config({ path: path.join(__dirname, '..', '.env') });

const MONGO_URI = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/bpmn_iq';
const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const RUN_SEED = (args.find((a) => a.startsWith('--seed=')) || '--seed=sox-deviations-2026').split('=')[1];
const FRACTION = Number((args.find((a) => a.startsWith('--fraction=')) || '--fraction=0.1').split('=')[1]);
const BATCH_ID = `soxdev-${RUN_SEED}`;
const TODAY = new Date();

// ─── Deterministic RNG (same approach as seed_efficiency_findings.js) ───
function hashStr(input) {
  let hash = 2166136261;
  for (let i = 0; i < input.length; i += 1) { hash ^= input.charCodeAt(i); hash = (hash * 16777619) >>> 0; }
  return hash;
}
function seededRng(seed) {
  let state = seed >>> 0;
  return () => { state = (state * 1664525 + 1013904223) >>> 0; return state / 4294967296; };
}
const rng = seededRng(hashStr(RUN_SEED));
const randInt = (min, max) => Math.floor(rng() * (max - min + 1)) + min;
const pick = (list) => list[Math.floor(rng() * list.length)];
function shuffle(list) {
  const arr = list.slice();
  for (let i = arr.length - 1; i > 0; i -= 1) { const j = Math.floor(rng() * (i + 1)); [arr[i], arr[j]] = [arr[j], arr[i]]; }
  return arr;
}
function weighted(entries) { // [[value, weight], ...]
  const total = entries.reduce((s, [, w]) => s + w, 0);
  let r = rng() * total;
  for (const [value, w] of entries) { r -= w; if (r <= 0) return value; }
  return entries[entries.length - 1][0];
}
const addDays = (date, days) => new Date(date.getTime() + days * 86400000);
const dateBetween = (a, b) => new Date(a.getTime() + rng() * (Math.min(b.getTime(), TODAY.getTime()) - a.getTime()));
const fmtDate = (d) => d.toISOString().slice(0, 10);
const list = (items, max = 3) => (items.length > max ? `${items.slice(0, max).join(', ')} and ${items.length - max} more` : items.join(', '));

// ─── Audits and other sources (fictional organizations and people) ───
const AUDITS = {
  EXT_INT: {
    source: 'External Audit', auditId: 'AUD-2026-EXT-01', auditName: 'FY2026 SOX 404 External Audit — Interim Testing', org: 'Calder Whitmore LLP',
    start: new Date('2026-08-03T12:00:00Z'), end: new Date('2026-09-25T12:00:00Z'), periodStart: new Date('2026-01-01T12:00:00Z'), periodEnd: new Date('2026-06-30T12:00:00Z'),
    it: ['Daniel Okafor (IT Audit Senior Manager)', 'Mei-Lin Zhou (IT Audit Senior)'], biz: ['Priya Natarajan (Audit Senior Manager)', 'Elena Marsh (Audit Senior)'],
  },
  EXT_YE: {
    source: 'External Audit', auditId: 'AUD-2025-EXT-02', auditName: 'FY2025 SOX 404 External Audit — Year-End', org: 'Calder Whitmore LLP',
    start: new Date('2026-01-12T12:00:00Z'), end: new Date('2026-02-20T12:00:00Z'), periodStart: new Date('2025-01-01T12:00:00Z'), periodEnd: new Date('2025-12-31T12:00:00Z'),
    it: ['Daniel Okafor (IT Audit Senior Manager)'], biz: ['Priya Natarajan (Audit Senior Manager)', 'Jonah Feld (Audit Associate)'],
    repeat: true,
  },
  IA_ITGC: {
    source: 'Internal Audit', auditId: 'IA-2026-07', auditName: '2026 Internal Audit — IT General Controls Review', org: 'LLM Motors Internal Audit',
    start: new Date('2026-05-11T12:00:00Z'), end: new Date('2026-06-26T12:00:00Z'), periodStart: new Date('2025-10-01T12:00:00Z'), periodEnd: new Date('2026-03-31T12:00:00Z'),
    it: ['Marcus Bell (IT Audit Manager)', 'Sofia Reyes (IT Auditor)'], biz: ['Marcus Bell (IT Audit Manager)'],
  },
  IA_FIN: {
    source: 'Internal Audit', auditId: 'IA-2026-04', auditName: '2026 Internal Audit — Revenue, Reserves & Procure-to-Pay', org: 'LLM Motors Internal Audit',
    start: new Date('2026-04-06T12:00:00Z'), end: new Date('2026-06-12T12:00:00Z'), periodStart: new Date('2025-10-01T12:00:00Z'), periodEnd: new Date('2026-03-31T12:00:00Z'),
    it: ['Sofia Reyes (IT Auditor)'], biz: ['Hannah Cho (Director, Internal Audit)', 'Tomás Alvarez (Senior Internal Auditor)'],
  },
  MSA: {
    source: 'Management Self-Assessment', auditId: 'MSA-2026-Q2', auditName: 'Q2 2026 SOX Management Self-Assessment', org: 'SOX Program Office',
    start: new Date('2026-07-06T12:00:00Z'), end: new Date('2026-07-31T12:00:00Z'), periodStart: new Date('2026-04-01T12:00:00Z'), periodEnd: new Date('2026-06-30T12:00:00Z'),
    it: ['Rachel Kim (SOX PMO Lead)'], biz: ['Rachel Kim (SOX PMO Lead)', 'Victor Hale (Finance Controls Lead)'],
  },
  CCM: {
    source: 'Continuous Controls Monitoring', auditId: 'CCM-RISK-MGR', auditName: 'Continuous Controls Monitoring — RISK-MGR GRC rules', org: 'GRC Analytics (RISK-MGR)',
    start: new Date('2026-08-15T12:00:00Z'), end: new Date('2026-10-02T12:00:00Z'), periodStart: new Date('2026-07-01T12:00:00Z'), periodEnd: new Date('2026-09-30T12:00:00Z'),
    it: ['Automated rule — reviewed by Alina Petrova (GRC Analyst)'], biz: ['Automated rule — reviewed by Alina Petrova (GRC Analyst)'],
  },
  INCIDENT: {
    source: 'Incident Post-Mortem', auditId: 'PIR-2026-031', auditName: 'Post-Incident Review — Production Data Correction', org: 'IT Service Management (IT-SERVICE)',
    start: new Date('2026-06-15T12:00:00Z'), end: new Date('2026-09-15T12:00:00Z'), periodStart: new Date('2026-06-01T12:00:00Z'), periodEnd: new Date('2026-09-15T12:00:00Z'),
    it: ['Kofi Mensah (Problem Manager)'], biz: ['Kofi Mensah (Problem Manager)'],
  },
};
const SOURCES_BY_CATEGORY = {
  'Issue Found During Audit': { it: [['EXT_INT', 4], ['IA_ITGC', 3], ['EXT_YE', 2]], biz: [['EXT_INT', 4], ['IA_FIN', 3], ['EXT_YE', 2]] },
  'Insufficient Evidence': { it: [['EXT_INT', 4], ['EXT_YE', 2], ['IA_ITGC', 2]], biz: [['EXT_INT', 4], ['EXT_YE', 2], ['IA_FIN', 2]] },
  'Control Not Sufficient': { it: [['EXT_INT', 3], ['IA_ITGC', 3], ['MSA', 2]], biz: [['EXT_INT', 3], ['IA_FIN', 3], ['MSA', 2]] },
  'Missing Control': { it: [['IA_ITGC', 3], ['CCM', 2], ['INCIDENT', 2], ['MSA', 1]], biz: [['IA_FIN', 3], ['MSA', 2], ['CCM', 2]] },
};

// ─── Classify a control into a template "kind" ───
const ITGC_KIND = { AC01: 'ACCESS_USER', AC04: 'ACCESS_USER', AC02: 'ACCESS_REVIEW', AC03: 'ACCESS_PRIV', AC05: 'ACCESS_PRIV', CM01: 'CHANGE', CM02: 'CHANGE', PD01: 'CHANGE', OP01: 'OPS_JOBS', OP02: 'OPS_BACKUP', OP03: 'OPS_PATCH' };
function kindOf(control) {
  if (control.category === 'Interface Control') return 'IF';
  if (control.scope.level === 'businessFlow') return 'MRC';
  if (control.category === 'IT General Control') {
    const code = (control.controlId.match(/^SOX-ITGC-([A-Z]{2}\d{2})-/) || [])[1];
    if (code) return ITGC_KIND[code];
    return control.itgcDomain === 'Program Change' ? 'CHANGE' : 'ACCESS_USER';
  }
  if (control.controlNature === 'Automated') return 'ITAC';
  return 'MANUAL';
}
const IT_KINDS = new Set(['ACCESS_USER', 'ACCESS_REVIEW', 'ACCESS_PRIV', 'CHANGE', 'OPS_JOBS', 'OPS_BACKUP', 'OPS_PATCH', 'IF', 'ITAC']);

// ─── Deviation templates: [category][kind] → (ctx) => { title, condition, cause } ───
// ctx: app, task, actor, flow, n, x, days, servers, dbs, api, month, owner
const T = {
  'Issue Found During Audit': {
    ACCESS_USER: (c) => ({ title: `Access granted to ${c.app} without approved request`, condition: `${c.x} of ${c.n} sampled ${c.app} user additions/removals did not follow the control: ${c.x - 1 > 0 ? `${c.x - 1} new user(s) were granted access before manager approval was recorded, and ` : ''}1 terminated user retained active access for ${c.days} days after the HR termination date and logged in ${randInt(1, 6)} time(s) after termination.`, cause: 'Access fulfilled from an email request while the ticketing workflow was bypassed; HR termination feed failed for one weekly cycle without alerting.' }),
    ACCESS_REVIEW: (c) => ({ title: `${c.app} user access recertification incomplete`, condition: `The ${c.month} recertification for ${c.app} was completed ${c.days} days after the due date, and ${c.x} user(s) flagged "remove" by the reviewer were still active at the date of testing.`, cause: 'Reviewer turnover; removal tickets were raised but not prioritized by the IT team.' }),
    ACCESS_PRIV: (c) => ({ title: `Unmonitored privileged access on ${c.app} database tier`, condition: `${c.x} generic DBA / admin account(s) on ${c.dbs || 'the database tier'} (hosted on ${c.servers || 'in-scope servers'}) were not vaulted in privileged-access management, and the privileged activity log review was not performed for ${c.month}.`, cause: 'New database instances were provisioned outside the standard build and never onboarded to the PAM vault.' }),
    CHANGE: (c) => ({ title: `Production changes to ${c.app} without evidence of approval / testing`, condition: `${c.x} of ${c.n} sampled production changes to ${c.app} had CAB approval dated after deployment or no user-acceptance testing evidence; ${c.x > 1 ? '1 was an emergency change never retro-approved.' : 'the change was classified "standard" incorrectly.'}`, cause: 'Release pressure; emergency-change procedure used for routine changes without retrospective review.' }),
    OPS_JOBS: (c) => ({ title: `Interface/job failures for ${c.app} not resolved timely`, condition: `On ${c.x} of ${c.n} sampled days, failed jobs or interface messages for ${c.app} (including ${c.api || 'cross-application APIs'}) had no incident ticket; the oldest failure was reprocessed ${c.days} days later.`, cause: 'Alert routing pointed to a decommissioned distribution list.' }),
    OPS_BACKUP: (c) => ({ title: `Backup failures on ${c.app} servers not investigated`, condition: `Backup job failures on ${c.servers || 'in-scope servers'} were not investigated for ${c.x} of ${c.n} sampled days, and no restore test of ${c.app} data was performed in the last 12 months.`, cause: 'Backup monitoring is reviewed only for Tier-1 platforms; restore test was deferred twice.' }),
    OPS_PATCH: (c) => ({ title: `Critical patches past SLA on ${c.app} infrastructure`, condition: `${c.servers || 'In-scope servers'} remained in "Critical" patching status ${c.days} days beyond the 15-day remediation SLA with no approved risk exception; ${c.x} critical vulnerabilities remained open at the date of testing.`, cause: 'Patch windows were cancelled during peak business periods without escalation to the CISO.' }),
    ITAC: (c) => ({ title: `Automated control "${c.task}" not operating as configured`, condition: `Test of one in ${c.app} failed: the configuration enforcing "${c.task}" ${pick(['allowed a tolerance of 10% versus the 2% approved in policy', 'permitted a user override of the calculated amount without a second approval', 'used a rate table that had been changed without an approved change ticket'])}.`, cause: 'Configuration change made during a release was not included in regression testing of key automated controls.' }),
    MANUAL: (c) => ({ title: `Exceptions in "${c.task}" sample testing`, condition: `${c.x} of ${c.n} sampled "${c.task}" transactions in ${c.flow} lacked evidence of review by the ${c.actor}${c.x > 1 ? ', and 1 was approved by the same person who prepared it' : ''}.`, cause: 'Volume spike at quarter-end; approvers delegated informally without updating the delegation of authority.' }),
    MRC: (c) => ({ title: `Management review for ${c.flow} not performed at required precision`, condition: `For ${c.x} of ${c.n} months tested, variances above the stated threshold in the ${c.flow} review were not investigated, and the review for ${c.month} was signed off ${c.days} days after the period was closed.`, cause: 'Reviewer relied on prior-month explanations without corroboration.' }),
    IF: (c) => ({ title: `Interface ${c.api} — reconciliation exceptions`, condition: `Record counts between sender and receiver for ${c.api} were not reconciled on ${c.x} of ${c.n} sampled days; ${randInt(12, 340)} messages sat in the error queue for more than 5 days without reprocessing.`, cause: 'Error-queue ownership unclear between application and integration teams.' }),
  },
  'Control Not Sufficient': {
    ACCESS_USER: (c) => ({ title: `${c.app} provisioning control does not cover all access paths`, condition: `The provisioning control covers only the ${c.app} front-end; direct database accounts on ${c.dbs || 'the database tier'} and service accounts are created outside the workflow, so access can be granted without approval.` }),
    ACCESS_REVIEW: (c) => ({ title: `${c.app} recertification excludes privileged and DB-layer accounts`, condition: `The ${c.app} user access review covers application roles only; database and OS accounts on ${c.servers || 'in-scope servers'} are not in the review population, and the user listing's completeness (IPE) is not validated.` }),
    ACCESS_PRIV: (c) => ({ title: `Privileged-access control on ${c.app} lacks independent review`, condition: `Privileged activity logs for ${c.dbs || 'the database tier'} are reviewed by the same DBA team that holds the privileged access, so the review is not independent of the activity being reviewed.` }),
    CHANGE: (c) => ({ title: `Change control for ${c.app} excludes configuration changes`, condition: `The change control covers code releases only; configuration and master-data table changes made directly in ${c.app} production (e.g., rate tables, posting rules) are not routed through CAB approval.` }),
    OPS_JOBS: (c) => ({ title: `Job monitoring for ${c.app} excludes API interfaces`, condition: `Monitoring covers scheduled batch jobs only; ${c.apiCount} cross-application API(s) owned by ${c.app} are not covered, so failed messages are only detected when users report missing data.` }),
    OPS_BACKUP: (c) => ({ title: `Backup cadence for ${c.app} inconsistent with RPO`, condition: `${c.servers || 'In-scope database servers'} are backed up weekly while ${c.app}'s documented RPO requires near-daily recovery points; the control design does not ensure financial data can be restored to the required point.` }),
    OPS_PATCH: (c) => ({ title: `Patch control for ${c.app} does not cover all server zones`, condition: `The patch-compliance control scopes production-zone servers only; ${c.app} servers in DMZ / management zones (${c.servers || 'several servers'}) are excluded even though they host components that process financial data.` }),
    ITAC: (c) => ({ title: `Automated control "${c.task}" can be overridden`, condition: `${c.app} allows users with a common role to override the system result for "${c.task}" without a second approval or an exception report, so the automated control can be bypassed.` }),
    MANUAL: (c) => ({ title: `"${c.task}" review threshold too high to detect material errors`, condition: `The ${c.actor} only reviews "${c.task}" items above $${(randInt(2, 9) * 250000).toLocaleString('en-US')}, while errors below the threshold could aggregate to an amount above performance materiality for ${c.flow}.` }),
    MRC: (c) => ({ title: `${c.flow} review lacks precision`, condition: `The review is performed at total-company level with a ${randInt(10, 25)}% / $${randInt(3, 9)}M variance threshold; it is not disaggregated by product, region or channel enough to detect a material misstatement arising in ${c.flow}.` }),
    IF: (c) => ({ title: `Interface ${c.api} validates record counts only`, condition: `The interface control checks record counts but not amount hash totals, so a message with an altered amount would pass validation into the receiving system.` }),
  },
  'Missing Control': {
    ACCESS_USER: (c) => ({ title: `No timely-removal control for ${c.app} contractor accounts`, condition: `Contractor and vendor accounts in ${c.app} are not sourced from HR-CORE, and no other control removes them at contract end; ${c.x} contractor account(s) were found active after the contract end date.` }),
    ACCESS_REVIEW: (c) => ({ title: `No user access review for ${c.app} service accounts`, condition: `No control exists to periodically review ${c.app} service / interface accounts, ${c.x} of which have interactive-login rights.` }),
    ACCESS_PRIV: (c) => ({ title: `No privileged-activity monitoring on ${c.dbs || c.app + ' databases'}`, condition: `Database audit logging is not enabled on ${c.servers || 'the database servers'}, so direct changes to ${c.app} financial tables by privileged users cannot be detected.` }),
    CHANGE: (c) => ({ title: `No detective control for unauthorized changes to ${c.app}`, condition: `There is no reconciliation of production changes (deployment logs / object timestamps) back to approved tickets for ${c.app}; changes made outside the process would go undetected.` }),
    OPS_JOBS: (c) => ({ title: `No owner monitoring ${c.app} interfaces flagged "mapping required"`, condition: `${c.apiCount} API(s) for ${c.app} are in "Proposed — application mapping required" status with no assigned owner; no control monitors their failures.` }),
    OPS_BACKUP: (c) => ({ title: `No restore testing for ${c.app}`, condition: `Backups of ${c.servers || c.app + ' servers'} are taken, but no control requires periodic restore testing, so recoverability of ${c.app} financial data has never been demonstrated.` }),
    OPS_PATCH: (c) => ({ title: `No vulnerability-exception approval process for ${c.app}`, condition: `Servers past patch SLA (${c.servers || 'several servers'}) have no risk-exception approval control; the CISO is not informed of overdue critical patches.` }),
    ITAC: (c) => ({ title: `No master-data change control supporting "${c.task}"`, condition: `The automated calculation in "${c.task}" depends on ${c.app} master data (prices, rates, rules), but no control reviews changes to that master data.` }),
    MANUAL: (c) => ({ title: `No mitigating control for segregation-of-duties conflict in ${c.flow}`, condition: c.sod || `No control prevents the ${c.actor} from both initiating and completing "${c.task}"; no independent review of these transactions exists.` }),
    MRC: (c) => ({ title: `No review of the reports used in the ${c.flow} review (IPE)`, condition: `The reports from ${c.app} used in the ${c.flow} management review are not validated for completeness and accuracy, and no control covers changes to their logic.` }),
    IF: (c) => ({ title: `No error-queue monitoring for ${c.api}`, condition: `No control monitors failed messages for ${c.api}; the interface has no designated owner and failures are discovered only through downstream reconciliation differences.` }),
  },
  'Insufficient Evidence': {
    ACCESS_USER: (c) => ({ title: `${c.app} access approvals not retained`, condition: `For ${c.x} of ${c.n} sampled ${c.app} access grants, the approval was given by email or chat that was not retained; the ticket shows "approved verbally".` }),
    ACCESS_REVIEW: (c) => ({ title: `${c.app} recertification listing cannot be validated`, condition: `The user listing for the ${c.month} ${c.app} review was extracted without retaining the query, parameters or record count, so completeness and accuracy of the review population cannot be evidenced.` }),
    ACCESS_PRIV: (c) => ({ title: `Privileged log review on ${c.app} not evidenced`, condition: `The DBA manager states privileged logs for ${c.dbs || 'the databases'} are reviewed weekly, but no sign-off, ticket or annotated log exists for ${c.x} of ${c.n} sampled weeks.` }),
    CHANGE: (c) => ({ title: `${c.app} change population cannot be reconciled to deployments`, condition: `The change ticket population from IT-SERVICE cannot be reconciled to ${c.app} deployment logs (logs retained 30 days only), so completeness of the population tested cannot be evidenced.` }),
    OPS_JOBS: (c) => ({ title: `${c.app} job-monitoring evidence not retained`, condition: `Daily monitoring of ${c.app} jobs and interfaces is performed on a dashboard, but no screenshots, logs or tickets are retained for ${c.x} of ${c.n} sampled days.` }),
    OPS_BACKUP: (c) => ({ title: `${c.app} backup logs retained only 30 days`, condition: `Backup job history for ${c.servers || 'in-scope servers'} is purged after 30 days; operation of the control for the rest of the audit period cannot be evidenced.` }),
    OPS_PATCH: (c) => ({ title: `${c.app} patch compliance reports not retained`, condition: `Monthly scan and patch-compliance reports for ${c.servers || 'in-scope servers'} were overwritten; only the current month is available.` }),
    ITAC: (c) => ({ title: `No configuration baseline for automated control "${c.task}"`, condition: `No baseline of the ${c.app} configuration enforcing "${c.task}" was retained, so the test of one cannot be extended across the period (benchmarking not possible).` }),
    MANUAL: (c) => ({ title: `"${c.task}" performance evidence insufficient`, condition: `Evidence of "${c.task}" consists of a system "approved" flag only; for ${c.x} of ${c.n} samples there is no evidence of what the ${c.actor} reviewed or how exceptions were resolved.` }),
    MRC: (c) => ({ title: `${c.flow} review evidenced by sign-off only`, condition: `The ${c.month} review package for ${c.flow} contains a sign-off but no documentation of the thresholds applied, the variances investigated, or the explanations obtained.` }),
    IF: (c) => ({ title: `Interface ${c.api} reconciliations not retained`, condition: `Daily reconciliation reports for ${c.api} are overwritten each day; reconciliation for ${c.x} of ${c.n} sampled days cannot be evidenced.` }),
  },
};
const CRITERIA_PREFIX = 'Per the control design: ';
const CAUSES = {
  'Control Not Sufficient': ['Control was designed before the application landscape changed and has not been re-scoped.', 'Risk assessment did not consider all access paths / data flows.', 'Control owner was unaware of the full population the control must cover.'],
  'Missing Control': ['Gap not identified in the annual SOX scoping / risk assessment.', 'Responsibility fell between application and infrastructure teams.', 'Application was onboarded without a SOX control design review.'],
  'Insufficient Evidence': ['No evidence-retention standard communicated to the control owner.', 'Tool retention settings shorter than the audit period.', 'Control owner performs the activity but does not document it.'],
};
const RECOMMENDATIONS = {
  'Issue Found During Audit': 'Remediate the specific exceptions, perform a root-cause analysis, re-train the control performer, and have the control re-tested over a sufficient remediation period (e.g., one quarter for a quarterly control, 25+ instances for a transactional control).',
  'Control Not Sufficient': 'Redesign the control to cover the full population at a level of precision that would detect a material misstatement; document the revised design and have it walked through by the auditors.',
  'Missing Control': 'Design and implement a control addressing the risk, assign an owner, add it to the SOX control library and RCM, and operate it for a full remediation period before testing.',
  'Insufficient Evidence': 'Define and communicate evidence requirements (what, where, retention ≥ audit period + 1 year); adjust tool retention settings; re-perform and document the control for the current period.',
};
const MGMT_RESPONSE = {
  High: 'Management agrees. Remediation is prioritized and tracked weekly by the SOX Steering Committee; interim compensating procedures are in place until remediation is validated.',
  Medium: 'Management agrees and has assigned an owner; progress is reported monthly to the SOX Program Office.',
  Low: 'Management agrees; the deviation will be remediated within the standard remediation window.',
};

// ─── Main ───
async function main() {
  await mongoose.connect(MONGO_URI);
  const controls = await SoxControl.find({}).lean();
  if (!controls.length) throw new Error('No SOX controls found — run scripts/seed_sox_controls.js first.');
  const byId = new Map(controls.map((c) => [c.controlId, c]));
  // Supporting infrastructure per application, taken from that app's AC03 (DB tier) ITGC scope.
  const dbTierByApp = new Map();
  for (const c of controls) {
    const m = c.controlId.match(/^SOX-ITGC-AC03-(.+)$/);
    if (m) dbTierByApp.set(m[1], { servers: c.scope.servers || [], databases: c.scope.databases || [] });
  }
  // Process-level controls per application (for ITGC deviations' affected flows/tasks).
  const taskControlsByApp = new Map();
  for (const c of controls) {
    if (c.scope.level !== 'task') continue;
    for (const a of c.scope.applications) {
      if (!taskControlsByApp.has(a.name)) taskControlsByApp.set(a.name, []);
      taskControlsByApp.get(a.name).push(c);
    }
  }

  // Weighted sample without replacement — auditors concentrate on high-risk controls.
  const target = Math.round(controls.length * FRACTION);
  const riskWeight = { High: 5, Medium: 2.5, Low: 1 };
  const pool = controls.map((c) => ({ c, key: Math.pow(rng(), 1 / (riskWeight[c.auditRisk] || 1)) }));
  const selected = pool.sort((a, b) => b.key - a.key).slice(0, target).map((p) => p.c);

  // Balanced category assignment.
  const categories = Object.keys(T);
  const categoryDeck = shuffle(Array.from({ length: target }, (_, i) => categories[i % categories.length]));

  const deviations = [];
  let materialWeaknessCount = 0;
  selected.forEach((control, i) => {
    const category = categoryDeck[i];
    const kind = kindOf(control);
    const isIt = IT_KINDS.has(kind);
    const auditKey = weighted(SOURCES_BY_CATEGORY[category][isIt ? 'it' : 'biz']);
    const audit = AUDITS[auditKey];
    const auditDate = dateBetween(audit.start, audit.end);

    // Severity — driven by the control's audit risk, nudged by category and key-control status.
    const base = { High: [['High', 5], ['Medium', 4], ['Low', 1]], Medium: [['High', 2], ['Medium', 5], ['Low', 3]], Low: [['High', 0.5], ['Medium', 3], ['Low', 6.5]] }[control.auditRisk];
    let severity = weighted(base);
    if (severity === 'Low' && control.keyControl && (category === 'Missing Control' || category === 'Control Not Sufficient') && rng() < 0.5) severity = 'Medium';
    let classification = severity === 'High' ? 'Significant Deficiency' : severity === 'Medium' && control.keyControl ? 'Significant Deficiency' : 'Control Deficiency';
    if (severity === 'Medium' && rng() < 0.5) classification = 'Control Deficiency';
    if (severity === 'High' && control.keyControl && control.auditRisk === 'High' && ['ACCESS_PRIV', 'CHANGE', 'MRC'].includes(kind) && materialWeaknessCount < 2) {
      classification = 'Potential Material Weakness';
      materialWeaknessCount += 1;
    }

    // Affected objects, from the control's real scope.
    const apps = control.scope.applications || [];
    const primaryApp = apps[0]?.name || 'the application';
    const tier = dbTierByApp.get(primaryApp) || { servers: [], databases: [] };
    let servers = [];
    let databases = [];
    if (kind === 'OPS_PATCH') servers = shuffle((control.scope.servers || []).filter((s) => s.patchingStatus === 'Critical' || s.patchingStatus === 'Behind')).slice(0, 4);
    else if (kind === 'OPS_BACKUP') servers = shuffle((control.scope.servers || []).filter((s) => s.backupStatus === 'Weekly' || /database/i.test(s.role || ''))).slice(0, 3);
    else if (kind === 'ACCESS_PRIV') { servers = shuffle(control.scope.servers || []).slice(0, 3); databases = shuffle(control.scope.databases || []).slice(0, 3); }
    if (!servers.length) servers = shuffle(tier.servers).slice(0, kind === 'MANUAL' || kind === 'MRC' ? 1 : 2);
    if (!databases.length) databases = shuffle(tier.databases).slice(0, 2);
    const apisAll = control.scope.apis || [];
    const apis = kind === 'IF' ? apisAll : shuffle(apisAll).slice(0, 2);
    let tasks = control.scope.tasks || [];
    let flows = control.scope.businessFlows || [];
    if (control.scope.level === 'application') {
      const relied = shuffle(taskControlsByApp.get(primaryApp) || []).slice(0, 3);
      tasks = relied.flatMap((c) => c.scope.tasks);
      flows = [...new Map(relied.flatMap((c) => c.scope.businessFlows).map((f) => [f.diagramId, f])).values()];
    }
    const task = tasks[0];
    const sodObservation = (control.observations || []).find((o) => o.startsWith('Segregation-of-duties conflict'));

    const n = /Quarterly|Semi-annual/.test(control.frequency) ? 2 : /Monthly/.test(control.frequency) ? 3 : /Daily/.test(control.frequency) ? 25 : kind === 'ITAC' ? 1 : 25;
    const x = n <= 3 ? 1 : randInt(1, Math.min(4, Math.max(1, Math.round(n / 8))));
    const ctx = {
      app: primaryApp,
      task: task?.taskName || control.title,
      actor: task?.actor || control.performedBy || 'control owner',
      flow: flows[0]?.name || task?.flowName || 'the process',
      n, x,
      days: randInt(9, 46),
      servers: list(servers.map((s) => s.name || s.serverId)),
      dbs: list([...new Set(databases.map((d) => (d.version && !String(d.name).includes(String(d.version)) ? `${d.name} ${d.version}` : d.name)))]),
      api: apis[0] ? `${apis[0].apiId} (${apis[0].method} ${apis[0].endpoint})` : '',
      apiCount: apisAll.length || randInt(3, 12),
      month: pick(['January', 'February', 'March', 'April', 'May', 'June']) + ' 2026',
      sod: sodObservation ? `${sodObservation} No mitigating (compensating) control has been designed for this conflict.` : null,
    };
    const tpl = T[category][kind](ctx);
    const deficiencyType = category === 'Issue Found During Audit' ? 'Operating Effectiveness' : category === 'Insufficient Evidence' ? 'Evidence / Documentation' : 'Design';
    const ageDays = (TODAY - auditDate) / 86400000;
    const status = audit.repeat ? 'In Remediation' : ageDays > 75 ? weighted([['In Remediation', 5], ['Remediated — Pending Validation', 3], ['Open', 1]]) : ageDays > 25 ? weighted([['Open', 3], ['In Remediation', 5]]) : 'Open';
    const targetDays = severity === 'High' ? randInt(30, 60) : severity === 'Medium' ? randInt(60, 90) : randInt(90, 120);

    deviations.push({
      controlId: control.controlId,
      controlTitle: control.title,
      controlCategory: control.category,
      category,
      severity,
      deficiencyClassification: classification,
      deficiencyType,
      title: tpl.title,
      condition: tpl.condition + (audit.repeat ? ' Repeat finding — a similar exception was reported in the prior-year (FY2024) audit and remediation was not completed.' : ''),
      criteria: CRITERIA_PREFIX + control.description,
      cause: tpl.cause || pick(CAUSES[category] || CAUSES['Control Not Sufficient']),
      effect: control.riskStatement + (control.financialStatementAccounts?.length ? ` Accounts potentially affected: ${control.financialStatementAccounts.slice(0, 4).join(', ')}.` : ''),
      recommendation: RECOMMENDATIONS[category],
      managementResponse: MGMT_RESPONSE[severity],
      testing: category === 'Issue Found During Audit' || category === 'Insufficient Evidence'
        ? { population: kind === 'ITAC' ? 'Configuration (test of one)' : `${control.frequency} control — period ${fmtDate(audit.periodStart)} to ${fmtDate(audit.periodEnd)}`, sampleSize: n, exceptions: x }
        : { population: 'Design evaluation (walkthrough)', sampleSize: null, exceptions: null },
      source: audit.source,
      audit: {
        auditId: audit.auditId,
        auditName: audit.auditName,
        auditorOrganization: audit.org,
        auditor: pick(isIt ? audit.it : audit.biz),
        auditDate,
        periodStart: audit.periodStart,
        periodEnd: audit.periodEnd,
      },
      affected: {
        process: control.category === 'IT General Control'
          ? `IT General Controls — ${control.itgcDomain || 'General'}${flows.length ? ` (relied on by ${[...new Set(tasks.map((t) => t.flowName))].slice(0, 3).join(', ')})` : ''}`
          : control.processCycleName || '',
        businessFlows: flows.map((f) => ({ diagramId: f.diagramId, name: f.name, domain: f.domain })),
        tasks: tasks.map((t) => ({ diagramId: t.diagramId, flowName: t.flowName, taskName: t.taskName, actor: t.actor })),
        applications: apps.map((a) => ({ name: a.name, appId: a.appId, appName: a.appName })),
        databases: databases.map((d) => ({ softwareId: d.softwareId, name: d.name, version: d.version, serverId: d.serverId })),
        servers: servers.map((s) => ({ serverId: s.serverId, name: s.name, role: s.role, patchingStatus: s.patchingStatus, backupStatus: s.backupStatus })),
        apis: apis.map((a) => ({ apiId: a.apiId, name: a.name, endpoint: a.endpoint, method: a.method })),
      },
      remediation: {
        owner: control.controlOwner,
        targetDate: addDays(auditDate, targetDays),
        status,
        repeatFinding: Boolean(audit.repeat),
      },
      batchId: BATCH_ID,
    });
  });

  deviations.sort((a, b) => a.audit.auditDate - b.audit.auditDate);
  deviations.forEach((d, i) => { d.deviationId = `DEV-${d.audit.auditDate.getUTCFullYear()}-${String(i + 1).padStart(4, '0')}`; });

  const count = (key) => deviations.reduce((acc, d) => { const k = key(d); acc[k] = (acc[k] || 0) + 1; return acc; }, {});
  console.log(`[soxdev] ${deviations.length} deviations on ${new Set(deviations.map((d) => d.controlId)).size} of ${controls.length} controls (${Math.round(FRACTION * 100)}%)`);
  console.log('[soxdev] by category:', count((d) => d.category));
  console.log('[soxdev] by severity:', count((d) => d.severity));
  console.log('[soxdev] by classification:', count((d) => d.deficiencyClassification));
  console.log('[soxdev] by source:', count((d) => d.audit.auditName));
  console.log('[soxdev] by status:', count((d) => d.remediation.status));
  if (dryRun) {
    console.log(JSON.stringify(deviations.slice(0, 2), null, 2));
    await mongoose.disconnect();
    return;
  }

  await SoxDeviation.deleteMany({});
  await SoxDeviation.insertMany(deviations);
  await SoxControl.collection.updateMany({}, { $unset: { deviationIds: '', openDeviationCount: '' } });
  const byControl = new Map();
  for (const d of deviations) {
    if (!byControl.has(d.controlId)) byControl.set(d.controlId, []);
    byControl.get(d.controlId).push(d);
  }
  await SoxControl.collection.bulkWrite([...byControl].map(([controlId, devs]) => ({
    updateOne: {
      filter: { controlId },
      update: { $set: { deviationIds: devs.map((d) => d.deviationId), openDeviationCount: devs.filter((d) => d.remediation.status !== 'Closed').length } },
    },
  })));
  console.log(`[soxdev] inserted ${deviations.length} deviations; stamped ${byControl.size} controls`);
  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error('[soxdev] failed:', err);
  try { await mongoose.disconnect(); } catch { /* ignore */ }
  process.exit(1);
});
