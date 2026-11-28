/**
 * Jira work rolled up to the business process flow (and to domain and the
 * whole landscape), from the Process Change Radar's per-flow issue lists.
 *
 * The jeopardy rules mirror client/src/utils/domainExposure.ts exactly so
 * Ask BIQ and the Heat Map never disagree:
 *   overdue  = due date (end of day) has passed
 *   dueSoon  = due within 7 days
 *   jeopardy = (overdue points + dueSoon points × 0.5) / total points
 *   red      = overdue points and jeopardy ≥ 15%; amber = any overdue or
 *              due-soon points; else green
 *
 * "Late" = overdue. Only open work is in the radar (statusCategory != Done,
 * active or future sprints when a board is configured), so these describe
 * work still in flight, not delivered history.
 */

const MS_DAY = 24 * 60 * 60 * 1000;
const STALE_DAYS = Number(process.env.JIRA_STALE_DAYS) > 0 ? Number(process.env.JIRA_STALE_DAYS) : 14;
const STORY_TYPES = new Set(['story', 'user story']);

const round = (n, d = 1) => Math.round(n * 10 ** d) / 10 ** d;
const clean = (v) => String(v ?? '').replace(/&amp;/g, '&').replace(/&#38;/g, '&').trim();

function daysUntilDue(dueDate, today) {
  const due = new Date(`${dueDate}T23:59:59`);
  return Math.round((due.getTime() - today.getTime()) / MS_DAY);
}

function bump(map, key, points) {
  const k = key || 'None';
  const e = map.get(k) || { issues: 0, points: 0 };
  e.issues += 1;
  e.points += points;
  map.set(k, e);
}
const toObj = (map) => Object.fromEntries([...map.entries()]
  .sort((a, b) => b[1].points - a[1].points || b[1].issues - a[1].issues)
  .map(([k, v]) => [k, { issues: v.issues, points: round(v.points) }]));

/** Aggregate one de-duplicated list of issues. */
function aggregateIssues(issues, today = new Date()) {
  const a = {
    issueCount: issues.length,
    storyPoints: { total: 0, onTrack: 0, dueSoon7: 0, overdue: 0, devDays: 0, unestimatedIssues: 0 },
    late: { issues: 0, points: 0, maxDaysOverdue: 0, avgDaysOverdue: 0, oldest: null },
    dueSoon7: { issues: 0, points: 0 },
    noDueDate: 0,
    userStories: { issues: 0, points: 0, lateIssues: 0, latePoints: 0 },
    stale: { days: STALE_DAYS, issues: 0, points: 0 },
    nearestDue: null,
  };
  const byType = new Map();
  const byStatus = new Map();
  const byStatusCategory = new Map();
  const byPriority = new Map();
  const bySprintState = new Map();
  const byAssignee = new Map();
  let unassigned = 0;
  let overdueDaysSum = 0;

  for (const i of issues) {
    const pts = Number(i.storyPoints) || 0;
    const sp = a.storyPoints;
    sp.total += pts;
    sp.devDays += Number(i.devDays) || 0;
    if (!pts) sp.unestimatedIssues += 1;

    const isStory = STORY_TYPES.has(String(i.issueType || '').toLowerCase());
    if (isStory) { a.userStories.issues += 1; a.userStories.points += pts; }

    if (!i.dueDate) {
      a.noDueDate += 1;
      sp.onTrack += pts;
    } else {
      if (!a.nearestDue || i.dueDate < a.nearestDue) a.nearestDue = i.dueDate;
      const until = daysUntilDue(i.dueDate, today);
      if (until < 0) {
        const over = -until;
        sp.overdue += pts;
        a.late.issues += 1;
        a.late.points += pts;
        overdueDaysSum += over;
        if (over > a.late.maxDaysOverdue) {
          a.late.maxDaysOverdue = over;
          a.late.oldest = { key: i.key, summary: clean(i.summary).slice(0, 140), dueDate: i.dueDate, daysOverdue: over, assignee: i.assignee || null };
        }
        if (isStory) { a.userStories.lateIssues += 1; a.userStories.latePoints += pts; }
      } else if (until <= 7) {
        sp.dueSoon7 += pts;
        a.dueSoon7.issues += 1;
        a.dueSoon7.points += pts;
      } else {
        sp.onTrack += pts;
      }
    }

    if (i.updated && (today.getTime() - new Date(i.updated).getTime()) / MS_DAY > STALE_DAYS) {
      a.stale.issues += 1;
      a.stale.points += pts;
    }

    bump(byType, i.issueType, pts);
    bump(byStatus, i.status, pts);
    bump(byStatusCategory, i.statusCategory, pts);
    bump(byPriority, i.priority, pts);
    bump(bySprintState, i.sprint ? (i.sprint.state === 'active' ? 'current sprint' : i.sprint.state === 'future' ? 'planned sprint' : i.sprint.state) : 'no sprint', pts);
    if (i.assignee) bump(byAssignee, i.assignee, pts); else unassigned += 1;
  }

  const sp = a.storyPoints;
  a.late.avgDaysOverdue = a.late.issues ? round(overdueDaysSum / a.late.issues) : 0;
  const jeopardy = sp.total > 0 ? (sp.overdue + sp.dueSoon7 * 0.5) / sp.total : 0;
  a.jeopardyRatio = round(jeopardy, 3);
  a.latePointsPct = sp.total > 0 ? round((sp.overdue / sp.total) * 100) : 0;
  a.rag = sp.overdue > 0 && jeopardy >= 0.15 ? 'red' : (sp.overdue > 0 || sp.dueSoon7 > 0) ? 'amber' : 'green';
  for (const k of ['total', 'onTrack', 'dueSoon7', 'overdue', 'devDays']) sp[k] = round(sp[k]);
  a.late.points = round(a.late.points);
  a.dueSoon7.points = round(a.dueSoon7.points);
  a.stale.points = round(a.stale.points);

  a.byType = toObj(byType);
  a.byStatus = toObj(byStatus);
  a.byStatusCategory = toObj(byStatusCategory);
  a.byPriority = toObj(byPriority);
  a.bySprint = toObj(bySprintState);
  a.assignees = {
    distinct: byAssignee.size,
    unassignedIssues: unassigned,
    top: Object.entries(toObj(byAssignee)).slice(0, 5).map(([name, v]) => ({ name, ...v })),
  };
  return a;
}

/**
 * radarDiagrams: the `diagrams` array from GET /api/process-change-radar.
 * Returns { flows, byDomain, totals } — each flow's issues are already
 * de-duplicated by the radar; domain and landscape totals de-duplicate
 * again, since one issue can touch several flows.
 */
function buildFlowAggregates(radarDiagrams, today = new Date()) {
  const flows = (radarDiagrams || []).map((d) => {
    const issues = d.issues || [];
    const matchedVia = { businessFlowField: 0, applicationField: 0, apiField: 0 };
    for (const i of issues) {
      if (i.source === 'businessFlow') matchedVia.businessFlowField += 1;
      else if (i.source === 'api') matchedVia.apiField += 1;
      else matchedVia.applicationField += 1;
    }
    return {
      diagramId: String(d.diagramId),
      name: clean(d.name),
      domain: clean(d.domain) || 'Unassigned',
      ...aggregateIssues(issues, today),
      matchedVia,
      applications: (d.applicationImpact || []).slice(0, 8).map((x) => ({ name: clean(x.name), issues: x.issueCount, nearestDue: x.nearestDueDate, criticality: x.businessCriticality })),
      _issues: issues,
    };
  });

  const domainMap = new Map();
  const all = new Map();
  for (const f of flows) {
    const e = domainMap.get(f.domain) || { flows: [], issues: new Map() };
    e.flows.push(f);
    for (const i of f._issues) { e.issues.set(i.key, i); all.set(i.key, i); }
    domainMap.set(f.domain, e);
  }
  const ragCount = (list) => ({ red: list.filter((f) => f.rag === 'red').length, amber: list.filter((f) => f.rag === 'amber').length, green: list.filter((f) => f.rag === 'green').length });

  const byDomain = [...domainMap.entries()].map(([domain, e]) => {
    const agg = aggregateIssues([...e.issues.values()], today);
    return {
      domain,
      flowCount: e.flows.length,
      flowRag: ragCount(e.flows),
      issueCount: agg.issueCount,
      storyPoints: agg.storyPoints,
      late: { issues: agg.late.issues, points: agg.late.points, maxDaysOverdue: agg.late.maxDaysOverdue },
      dueSoon7: agg.dueSoon7,
      userStories: agg.userStories,
      latePointsPct: agg.latePointsPct,
      jeopardyRatio: agg.jeopardyRatio,
      rag: agg.rag,
    };
  }).sort((x, y) => y.late.points - x.late.points || y.storyPoints.total - x.storyPoints.total);

  const totalAgg = aggregateIssues([...all.values()], today);
  const totals = {
    flowsWithWork: flows.length,
    flowRag: ragCount(flows),
    ...totalAgg,
    note: 'Issues are de-duplicated: one issue that touches several flows counts once here, but once in each flow it touches.',
  };

  flows.forEach((f) => { delete f._issues; });
  return { flows, byDomain, totals };
}

const SORTS = {
  latePoints: (a, b) => b.late.points - a.late.points || b.late.issues - a.late.issues,
  lateIssues: (a, b) => b.late.issues - a.late.issues || b.late.points - a.late.points,
  lateStories: (a, b) => b.userStories.lateIssues - a.userStories.lateIssues || b.late.issues - a.late.issues,
  storyPoints: (a, b) => b.storyPoints.total - a.storyPoints.total,
  issues: (a, b) => b.issueCount - a.issueCount,
  jeopardy: (a, b) => b.jeopardyRatio - a.jeopardyRatio || b.late.points - a.late.points,
  daysOverdue: (a, b) => b.late.maxDaysOverdue - a.late.maxDaysOverdue,
  dueSoon: (a, b) => b.dueSoon7.points - a.dueSoon7.points,
  stale: (a, b) => b.stale.issues - a.stale.issues,
};

module.exports = { aggregateIssues, buildFlowAggregates, SORTS, STALE_DAYS };
