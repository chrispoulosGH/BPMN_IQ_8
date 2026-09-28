// Aggregation math for the Quantitative Modeling "what-if" screen's four
// gauges — cost, security risk, defect risk, Jira activity — all driven by
// an arbitrary set of application names (typically read live off an
// in-progress, unsaved diagram edit via BpmnEditor's getTaskApplications()
// handle method) rather than any saved flow/lineage record. Kept as pure
// functions, independent of React, so they're trivial to re-run on every
// keystroke-rate edit without any component coupling.

import type { ApplicationRiskProfile, FeatureCostPoint } from '../api';
import type { JiraImpactIssue } from '../types';
import { classifyIssues, type JeopardySummary } from './domainExposure';

export function normalizeAppKey(value: unknown): string {
  return String(value || '').trim().toLowerCase();
}

// ─── Risk (security + defect) ──────────────────────────────────────────
// Re-implements the exact probability/severity math server/routes/
// dashboard.js's business-flow-security-risk and business-flow-defect-risk
// routes use — same trigger functions, same formula — just aggregated over
// a client-supplied app-name set instead of the server's baked-in
// __lineageVariants. Keep in sync if either formula changes server-side.

export type RiskLabel = 'Low' | 'Med' | 'High';
const RANK_LABELS: Record<number, RiskLabel> = { 1: 'Low', 2: 'Med', 3: 'High' };

export interface AggregateRisk {
  probability: number; // 0-100
  rank: number; // 1|2|3
  label: RiskLabel;
  matchedAppCount: number;
  assetCount: number;
}

const EMPTY_RISK: AggregateRisk = { probability: 0, rank: 1, label: 'Low', matchedAppCount: 0, assetCount: 0 };

/** One lookup, built once per fetch of the application-risk reference data — reused across every recompute. */
export function buildRiskLookup(applications: ApplicationRiskProfile[]): Map<string, ApplicationRiskProfile> {
  const map = new Map<string, ApplicationRiskProfile>();
  for (const app of applications) {
    const acronymKey = normalizeAppKey(app.acronym);
    if (acronymKey && !map.has(acronymKey)) map.set(acronymKey, app);
    const nameKey = normalizeAppKey(app.name);
    if (nameKey && !map.has(nameKey)) map.set(nameKey, app);
  }
  return map;
}

function resolveMatchedApps(appNames: string[], lookup: Map<string, ApplicationRiskProfile>): ApplicationRiskProfile[] {
  const matched: ApplicationRiskProfile[] = [];
  const seenAppIds = new Set<string>();
  for (const name of appNames) {
    const app = lookup.get(normalizeAppKey(name));
    if (app && !seenAppIds.has(app.appId)) {
      seenAppIds.add(app.appId);
      matched.push(app);
    }
  }
  return matched;
}

export function computeAggregateSecurityRisk(appNames: string[], lookup: Map<string, ApplicationRiskProfile>): AggregateRisk {
  const matched = resolveMatchedApps(appNames, lookup);
  if (!matched.length) return EMPTY_RISK;
  const assetCount = matched.reduce((sum, a) => sum + a.assetCount, 0);
  const atRiskCount = matched.reduce((sum, a) => sum + a.atRiskCountSecurity, 0);
  let probability = assetCount ? Math.round(100 * (atRiskCount / assetCount)) : 0;
  if (matched.some((a) => a.internetFacing)) probability = Math.min(100, probability + 5);
  const rank = Math.round(matched.reduce((sum, a) => sum + a.securitySeverityRank, 0) / matched.length);
  return { probability, rank, label: RANK_LABELS[rank] || 'Low', matchedAppCount: matched.length, assetCount };
}

export function computeAggregateDefectRisk(appNames: string[], lookup: Map<string, ApplicationRiskProfile>): AggregateRisk {
  const matched = resolveMatchedApps(appNames, lookup);
  if (!matched.length) return EMPTY_RISK;
  const assetCount = matched.reduce((sum, a) => sum + a.assetCount, 0);
  const atRiskCount = matched.reduce((sum, a) => sum + a.atRiskCountDefect, 0);
  const probability = assetCount ? Math.round(100 * (atRiskCount / assetCount)) : 0;
  const rank = Math.round(matched.reduce((sum, a) => sum + a.defectCriticalityRank, 0) / matched.length);
  return { probability, rank, label: RANK_LABELS[rank] || 'Low', matchedAppCount: matched.length, assetCount };
}

// ─── Cost ───────────────────────────────────────────────────────────────
// Feature Dev Cost only (see session discussion) — per (business flow,
// task, application, year) dev cost of the discrete features built for that
// combination. Deliberately (flow, TASK, application)-scoped, not just
// (flow, application) — an application newly added to the what-if edit that
// has never had feature-cost data recorded *for this flow* contributes $0,
// not some other flow's cost for that app (adding scope should never
// silently import unrelated spend); and critically, deleting one task that
// uses an application still used by *other* tasks in the same flow now
// correctly drops just that task's own recorded spend, rather than the
// application's full flow-wide cost staying put because it's "still used
// somewhere in the flow." Takes the live task list (task name + its
// applications), not a flattened app-name array, for exactly this reason.

export interface CostTaskEntry {
  taskName: string;
  apps: string[];
}

export function computeAggregateCost(
  tasks: CostTaskEntry[],
  businessFlowName: string,
  points: FeatureCostPoint[],
  year: number
): number {
  const flowKey = normalizeAppKey(businessFlowName);
  const pairKeys = new Set<string>();
  for (const task of tasks) {
    const taskKey = normalizeAppKey(task.taskName);
    for (const app of task.apps) {
      pairKeys.add(`${taskKey}|${normalizeAppKey(app)}`);
    }
  }
  return points
    .filter((p) => p.year === year
      && normalizeAppKey(p.businessFlow) === flowKey
      && pairKeys.has(`${normalizeAppKey(p.task)}|${normalizeAppKey(p.application)}`))
    .reduce((sum, p) => sum + (p.cost || 0), 0);
}

// ─── Jira activity ──────────────────────────────────────────────────────
// Mirrors server/routes/processChangeRadar.js's own matching: an issue
// counts if it names this flow directly (source === 'businessFlow' — edit-
// independent, since renaming/restructuring tasks doesn't invalidate a
// flow-level Jira link) OR if it names one of the app names currently in
// play (source-independent of which task references it, so removing the
// task that used an app drops that app's issues from the live count, and
// adding a task that uses an app already known to Jira picks its issues up).

export function computeLiveJiraActivity(
  appNames: string[],
  flowSourcedIssues: JiraImpactIssue[],
  issuesByApplicationName: Record<string, JiraImpactIssue[]>,
  referenceDate: Date
): JeopardySummary {
  const combined = new Map<string, JiraImpactIssue>();
  for (const issue of flowSourcedIssues) combined.set(issue.key, issue);
  for (const name of appNames) {
    const matches = issuesByApplicationName[normalizeAppKey(name)] || [];
    for (const issue of matches) {
      if (!combined.has(issue.key)) combined.set(issue.key, issue);
    }
  }
  return classifyIssues(Array.from(combined.values()), referenceDate);
}
