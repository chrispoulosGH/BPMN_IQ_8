'use strict';
const { apiGet } = require('../apiClient');

let cache = null;
let cacheAt = 0;
const CACHE_TTL_MS = 2 * 60 * 1000; // Jira data changes faster than the landscape catalog

function norm(s) { return String(s || '').trim().toLowerCase(); }

async function loadRadar() {
  if (cache && Date.now() - cacheAt < CACHE_TTL_MS) return cache;
  try {
    cache = await apiGet('/api/process-change-radar/');
  } catch (err) {
    cache = { configured: false, error: err.message, diagrams: [], issuesByApplicationName: {} };
  }
  cacheAt = Date.now();
  return cache;
}

async function getJiraActivity({ diagramId, businessFlowName, applicationNames } = {}) {
  const radar = await loadRadar();
  if (!radar.configured) {
    return { configured: false, note: 'Jira is not configured on this server — no activity data available.' };
  }

  let matched = null;
  if (diagramId) matched = radar.diagrams.find((d) => d.diagramId === diagramId);
  else if (businessFlowName) matched = radar.diagrams.find((d) => norm(d.name) === norm(businessFlowName));

  const extraIssues = [];
  if (Array.isArray(applicationNames)) {
    for (const name of applicationNames) {
      const found = radar.issuesByApplicationName[norm(name)] || [];
      extraIssues.push(...found);
    }
  }

  if (!matched && !extraIssues.length) {
    return { configured: true, issueCount: 0, atRiskCount: 0, totalDevDays: 0, issues: [] };
  }

  const combined = new Map();
  for (const issue of matched ? matched.issues : []) combined.set(issue.key, issue);
  for (const issue of extraIssues) if (!combined.has(issue.key)) combined.set(issue.key, issue);
  const issues = [...combined.values()];

  return {
    configured: true,
    issueCount: issues.length,
    atRiskCount: issues.filter((i) => i.isOverdue).length,
    totalDevDays: Math.round(issues.reduce((sum, i) => sum + (i.devDays || 0), 0) * 100) / 100,
    issues: issues.map((i) => ({ key: i.key, summary: i.summary, isOverdue: i.isOverdue, dueDate: i.dueDate, devDays: i.devDays })),
  };
}

module.exports = { getJiraActivity };
