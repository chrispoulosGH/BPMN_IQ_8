import type { JiraImpactIssue, ProcessChangeRadarDiagramSummary, ProcessChangeRadarResponse } from '../types';

// Diagram.domain values in the data can include both a clean "Warranty &
// Protection Services" and an HTML-escaped "Warranty &amp; Protection
// Services" spelling of the same domain (an upstream import artifact) — fold
// them together so they don't split into two groups. Shared by
// ProcessChangeRadar.tsx (sidebar grouping) and the exposure-board rollup
// below, so both agree on what a "domain" is.
export function normalizeDomainLabel(domain?: string | null): string {
  const trimmed = (domain || '').replace(/&amp;/gi, '&').trim();
  return trimmed || 'Uncategorized';
}

export type JeopardyBucket = 'overdue' | 'dueSoon' | 'onTrack';
export type RagLevel = 'red' | 'amber' | 'green';

// Same risk palette Dashboard.tsx's FlowDashboard risk rows use
// (RISK_COLORS.low/medium/critical) — the one red/amber/green vocabulary
// every Process Change Radar-derived view (Change Exposure Board, Process
// Change Heat Map) should share, so a flow never reads as one color in one
// view and a different one elsewhere.
export const RAG_COLOR: Record<RagLevel, string> = { green: '#52c41a', amber: '#faad14', red: '#f5222d' };
export const RAG_TEXT_COLOR: Record<RagLevel, string> = { green: '#0f172a', amber: '#0f172a', red: '#ffffff' };
export const RAG_LABEL: Record<RagLevel, string> = { green: 'On track', amber: 'Needs attention', red: 'Critical' };

export interface DomainExposure extends JeopardySummary {
  domain: string;
  flowCount: number;
}

export interface DomainExposureTotals {
  totalPoints: number;
  overduePoints: number;
  dueSoon7Points: number;
  issueCount: number;
  flowCount: number;
  nearestDue: string | null;
}

export interface DomainExposureSummary {
  domains: DomainExposure[];
  totals: DomainExposureTotals;
  ragCounts: { red: number; amber: number; green: number };
}

const MS_DAY = 86400000;

function jeopardyBucket(issue: JiraImpactIssue, referenceDate: Date): JeopardyBucket {
  if (!issue.dueDate) return 'onTrack';
  const due = new Date(issue.dueDate + 'T23:59:59');
  const daysUntil = Math.round((due.getTime() - referenceDate.getTime()) / MS_DAY);
  if (daysUntil < 0) return 'overdue';
  if (daysUntil <= 7) return 'dueSoon';
  return 'onTrack';
}

export interface JeopardySummary {
  totalPoints: number;
  onTrackPoints: number;
  dueSoon7Points: number;
  overduePoints: number;
  overdueCount: number;
  issueCount: number;
  nearestDue: string | null;
  /** (overdue + dueSoon*0.5) / total — a due-soon issue counts as "half a jeopardy". */
  jeopardyRatio: number;
  rag: RagLevel;
}

/**
 * Buckets a set of (already-deduped) issues into on-track/due-soon/overdue
 * story points and derives a red/amber/green judgment — the one piece of
 * jeopardy math shared by every Process Change Radar rollup, whether it's
 * grouped by domain (computeDomainExposure) or by individual flow
 * (computeFlowExposure below), so the two views can never silently disagree
 * about what "at risk" means.
 */
export function classifyIssues(issues: JiraImpactIssue[], referenceDate: Date = new Date()): JeopardySummary {
  let totalPoints = 0;
  let onTrackPoints = 0;
  let dueSoon7Points = 0;
  let overduePoints = 0;
  let overdueCount = 0;
  let nearestDue: string | null = null;

  for (const issue of issues) {
    const pts = issue.storyPoints || 0;
    totalPoints += pts;
    const bucket = jeopardyBucket(issue, referenceDate);
    if (bucket === 'overdue') { overduePoints += pts; overdueCount += 1; }
    else if (bucket === 'dueSoon') { dueSoon7Points += pts; }
    else { onTrackPoints += pts; }
    if (issue.dueDate && (!nearestDue || issue.dueDate < nearestDue)) nearestDue = issue.dueDate;
  }

  const jeopardyRatio = totalPoints > 0 ? (overduePoints + dueSoon7Points * 0.5) / totalPoints : 0;
  const rag: JeopardySummary['rag'] =
    overduePoints > 0 && jeopardyRatio >= 0.15 ? 'red'
      : overduePoints > 0 || dueSoon7Points > 0 ? 'amber'
      : 'green';

  return {
    totalPoints, onTrackPoints, dueSoon7Points, overduePoints, overdueCount,
    issueCount: issues.length, nearestDue, jeopardyRatio: Math.round(jeopardyRatio * 1000) / 1000, rag,
  };
}

/**
 * Rolls a full Process Change Radar response up into one row per business
 * domain — total story points in flight, how much of that is overdue/due
 * soon/on track, and a red/amber/green judgment — for the executive Change
 * Exposure Board. `referenceDate` defaults to now; pass the response's own
 * `generatedAt` to keep "today" consistent with the snapshot being read.
 *
 * A single Jira issue can touch flows in more than one domain (it names an
 * application several flows share) — each domain that issue touches counts
 * it once, so per-domain totals can sum to more than the portfolio-wide
 * total in `totals` (which dedupes by issue key across all domains).
 */
export function computeDomainExposure(
  response: Pick<ProcessChangeRadarResponse, 'diagrams'>,
  referenceDate: Date = new Date()
): DomainExposureSummary {
  const byDomain = new Map<string, { issuesByKey: Map<string, JiraImpactIssue>; flowIds: Set<string> }>();
  for (const diagram of response.diagrams || []) {
    const domain = normalizeDomainLabel(diagram.domain);
    if (!byDomain.has(domain)) byDomain.set(domain, { issuesByKey: new Map(), flowIds: new Set() });
    const entry = byDomain.get(domain)!;
    entry.flowIds.add(diagram.diagramId);
    for (const issue of diagram.issues || []) {
      if (!entry.issuesByKey.has(issue.key)) entry.issuesByKey.set(issue.key, issue);
    }
  }

  const domains: DomainExposure[] = [];
  const allIssuesByKey = new Map<string, JiraImpactIssue>();

  for (const [domain, entry] of byDomain.entries()) {
    const issues = Array.from(entry.issuesByKey.values());
    for (const issue of issues) {
      if (!allIssuesByKey.has(issue.key)) allIssuesByKey.set(issue.key, issue);
    }

    const jeopardy = classifyIssues(issues, referenceDate);
    domains.push({ domain, flowCount: entry.flowIds.size, ...jeopardy });
  }

  domains.sort((a, b) => b.totalPoints - a.totalPoints);

  const allIssues = Array.from(allIssuesByKey.values());
  const totals: DomainExposureTotals = {
    totalPoints: allIssues.reduce((sum, i) => sum + (i.storyPoints || 0), 0),
    overduePoints: domains.reduce((sum, d) => sum + d.overduePoints, 0),
    dueSoon7Points: domains.reduce((sum, d) => sum + d.dueSoon7Points, 0),
    issueCount: allIssues.length,
    flowCount: domains.reduce((sum, d) => sum + d.flowCount, 0),
    nearestDue: allIssues.reduce<string | null>((min, i) => (i.dueDate && (!min || i.dueDate < min) ? i.dueDate : min), null),
  };

  const ragCounts = {
    red: domains.filter((d) => d.rag === 'red').length,
    amber: domains.filter((d) => d.rag === 'amber').length,
    green: domains.filter((d) => d.rag === 'green').length,
  };

  return { domains, totals, ragCounts };
}

export interface FlowExposure extends JeopardySummary {
  diagramId: string;
  name: string;
  domain: string;
  neighborhoodName: string | null;
  status: string | null;
}

/**
 * One row per impacted business flow (not grouped by domain) — the Process
 * Change Heat Map's data: every diagram Process Change Radar matched at
 * least one issue to, each with its own jeopardy classification. Unlike
 * computeDomainExposure, a diagram's own `issues` list is already deduped
 * per-diagram by the server, so no further de-duping is needed here.
 */
export function computeFlowExposure(
  response: Pick<ProcessChangeRadarResponse, 'diagrams'>,
  referenceDate: Date = new Date()
): FlowExposure[] {
  return (response.diagrams || []).map((diagram) => ({
    diagramId: diagram.diagramId,
    name: diagram.name,
    domain: normalizeDomainLabel(diagram.domain),
    neighborhoodName: diagram.neighborhoodName || null,
    status: diagram.status || null,
    ...classifyIssues(diagram.issues || [], referenceDate),
  }));
}

export type { ProcessChangeRadarDiagramSummary };
