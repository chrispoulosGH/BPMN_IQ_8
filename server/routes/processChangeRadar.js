const express = require('express');
const router = express.Router();
const Diagram = require('../models/Diagram');
const { isJiraConfigured, getProcessChangeIssues } = require('../services/jiraClient');
const { listApplicationReferences } = require('../utils/applicationReferenceLookup');

function normalizeName(value) {
  return String(value || '').trim().toLowerCase();
}

// Application reference lookups are scoped to a neighborhood and re-scan
// that neighborhood's whole data set — cache one index per neighborhood for
// the lifetime of a single request instead of re-querying per application
// name. Keyed by every name a record could be matched under (name/acronym/
// correlationId), mirroring findApplicationByName() in
// applicationReferenceLookup.js.
function makeCriticalityIndexLoader() {
  const cache = new Map();
  return async function getCriticalityIndex(neighborhoodName) {
    const key = neighborhoodName || '';
    if (cache.has(key)) return cache.get(key);
    const promise = listApplicationReferences(key).then((items) => {
      const index = new Map();
      for (const item of items) {
        for (const candidate of [item.name, item.acronym, item.correlationId]) {
          const normalized = normalizeName(candidate);
          if (normalized && !index.has(normalized)) index.set(normalized, item);
        }
      }
      return index;
    }).catch(() => new Map());
    cache.set(key, promise);
    return promise;
  };
}

// Per-application breakdown of a diagram's matched issues — one point per
// application named by at least one of those issues, for the "3D map of
// impacted applications" view (issue count / nearest due date / criticality
// axes). Only applicationNames feed this (not businessFlowNames, which have
// no single application to anchor to, and not apiNames, which are already
// folded into applicationNames upstream — see fanOutByName below).
async function buildApplicationImpact(matchedIssues, neighborhoodName, getCriticalityIndex) {
  const byApp = new Map();
  for (const issue of matchedIssues) {
    for (const rawName of issue.applicationNames || []) {
      const key = normalizeName(rawName);
      if (!key) continue;
      if (!byApp.has(key)) byApp.set(key, { name: rawName, issueKeys: new Set(), dueDates: [] });
      const entry = byApp.get(key);
      entry.issueKeys.add(issue.key);
      if (issue.dueDate) entry.dueDates.push(issue.dueDate);
    }
  }
  if (!byApp.size) return [];

  const criticalityIndex = await getCriticalityIndex(neighborhoodName);
  return Array.from(byApp.values())
    .map((entry) => ({
      name: entry.name,
      issueCount: entry.issueKeys.size,
      nearestDueDate: entry.dueDates.length ? entry.dueDates.slice().sort()[0] : null,
      businessCriticality: criticalityIndex.get(normalizeName(entry.name))?.businessCriticality || null,
    }))
    .sort((a, b) => b.issueCount - a.issueCount);
}

// Jira's Application/API custom fields hold "Display Name (ACRONYM)" (e.g.
// "Extended Warranty & Protection Product Sales (WARRANTY-SALES)"), but a
// diagram's task often names the application by acronym alone (see
// Diagram.tasks[].applications[].name, populated from the acronym when a
// task is linked to an Application reference record) — extract it so both
// spellings resolve to the same issue.
function extractParentheticalAcronym(value) {
  const match = String(value || '').match(/\(([^()]+)\)\s*$/);
  return match ? match[1].trim() : '';
}

// Adds `issue` (tagged with which of the three Jira fields matched, and the
// exact value that matched) under every name it names in `names` — one issue
// can legitimately reference more than one task/application/API, and the
// same name can be hit by more than one issue. Also indexes under the
// parenthetical acronym alone (see extractParentheticalAcronym) so an
// acronym-only diagram application name still matches.
function fanOutByName(map, names, issue, source) {
  for (const rawName of names) {
    const key = normalizeName(rawName);
    if (!key) continue;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push({ ...issue, source, matchedValue: rawName });

    const acronymKey = normalizeName(extractParentheticalAcronym(rawName));
    if (acronymKey && acronymKey !== key) {
      if (!map.has(acronymKey)) map.set(acronymKey, []);
      map.get(acronymKey).push({ ...issue, source, matchedValue: rawName });
    }
  }
}

// GET /api/process-change-radar — ranks business process flows by how much
// currently-or-soon in-flight Jira change touches them (via the Business
// Process Flow/Application/API custom fields), for the Process Change Radar
// tab. Runs the live Jira query fresh on every call — this route is only
// ever hit when that tab is opened, by design (see ProcessChangeRadar.tsx).
router.get('/', async (req, res) => {
  if (!isJiraConfigured()) {
    return res.status(400).json({
      error: 'Jira is not configured. Set JIRA_BASE_URL, JIRA_EMAIL, and JIRA_API_TOKEN in server/.env, then restart the server.',
      configured: false,
    });
  }

  try {
    const issues = await getProcessChangeIssues();

    // Business Process Flow names a diagram directly (Diagram.businessFlow/
    // name) — matched once per diagram below, not per task. Application/API
    // name applications used by a diagram's tasks — matched per task.
    const issuesByBusinessFlowName = new Map();
    const issuesByApplicationName = new Map();
    for (const issue of issues) {
      fanOutByName(issuesByBusinessFlowName, issue.businessFlowNames, issue, 'businessFlow');
      fanOutByName(issuesByApplicationName, issue.applicationNames, issue, 'application');
      // "API" isn't its own element on a diagram — an API-linked issue is
      // surfaced through whichever Application it's also tied to. An issue
      // that names only an API (no Business Process Flow/Application) has
      // nothing to anchor to and won't appear on any diagram, but that's a
      // data-entry gap in Jira, not something this route can resolve.
      fanOutByName(issuesByApplicationName, issue.apiNames, issue, 'api');
    }

    if (!issuesByBusinessFlowName.size && !issuesByApplicationName.size) {
      return res.json({
        configured: true,
        generatedAt: new Date().toISOString(),
        diagrams: [],
        issuesByApplicationName: {},
      });
    }

    const diagrams = await Diagram.find({}, {
      name: 1, businessFlow: 1, neighborhoodName: 1, status: 1, tasks: 1, domain: 1,
    }).lean();

    const getCriticalityIndex = makeCriticalityIndexLoader();
    const summaries = [];
    for (const diagram of diagrams) {
      const matchedIssueKeys = new Set();
      const matchedIssues = [];
      let atRiskCount = 0;
      let totalDevDays = 0;
      const record = (issueList) => {
        for (const issue of issueList) {
          if (matchedIssueKeys.has(issue.key)) continue;
          matchedIssueKeys.add(issue.key);
          matchedIssues.push(issue);
          if (issue.isOverdue) atRiskCount += 1;
          totalDevDays += issue.devDays || 0;
        }
      };

      record(issuesByBusinessFlowName.get(normalizeName(diagram.businessFlow || diagram.name)) || []);
      for (const task of diagram.tasks || []) {
        for (const application of task.applications || []) {
          record(issuesByApplicationName.get(normalizeName(application.name)) || []);
        }
      }

      if (!matchedIssueKeys.size) continue;
      const applicationImpact = await buildApplicationImpact(matchedIssues, diagram.neighborhoodName, getCriticalityIndex);
      summaries.push({
        diagramId: String(diagram._id),
        name: diagram.businessFlow || diagram.name,
        neighborhoodName: diagram.neighborhoodName || null,
        status: diagram.status || null,
        domain: diagram.domain || null,
        issueCount: matchedIssueKeys.size,
        atRiskCount,
        totalDevDays: Math.round(totalDevDays * 100) / 100,
        issues: matchedIssues,
        applicationImpact,
      });
    }

    // Most impacted first: flows with the most overdue/at-risk issues lead,
    // ties broken by total remaining dev-days.
    summaries.sort((a, b) => (b.atRiskCount - a.atRiskCount) || (b.totalDevDays - a.totalDevDays));

    res.json({
      configured: true,
      generatedAt: new Date().toISOString(),
      diagrams: summaries,
      issuesByApplicationName: Object.fromEntries(issuesByApplicationName),
    });
  } catch (err) {
    console.error('[PROCESS CHANGE RADAR] failed:', err);
    const knownConfigError = err.code === 'JIRA_NOT_CONFIGURED' || err.code === 'JIRA_FIELDS_NOT_FOUND';
    res.status(knownConfigError ? 400 : 500).json({ error: err.message, configured: !knownConfigError });
  }
});

module.exports = router;
