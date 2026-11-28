/**
 * "Ask BIQ" tools (phase 1). Read-only; every handler goes through the
 * user's own API session (userApi.js). Each returns { result, refs }:
 *   result  compact JSON for the model (lists are capped)
 *   refs    things the answer may cite, which the client turns into links:
 *           { kind: 'flow' | 'app' | 'control' | 'jira', id, name, url? }
 */

const clean = (v) => String(v ?? '')
  .replace(/&amp;/g, '&').replace(/&#38;/g, '&')
  .replace(/â€”/g, '—').replace(/â€“/g, '–').replace(/â€™/g, '’')
  .trim();
const norm = (v) => clean(v).toLowerCase();
const cap = (list, n) => (Array.isArray(list) ? list.slice(0, n) : []);
const short = (v, n = 280) => { const s = clean(v); return s.length > n ? `${s.slice(0, n - 1)}…` : s; };

const flowRef = (d) => ({ kind: 'flow', id: String(d._id || d.diagramId), name: clean(d.businessFlow || d.name) });
const appRef = (acronym, name) => ({ kind: 'app', id: acronym, name: clean(name || acronym) });

async function diagrams(api) {
  return api.get('/diagrams/');
}

/** Find one diagram by id, or by exact / partial name. */
async function resolveFlow(api, { diagramId, name }) {
  const all = await diagrams(api);
  if (diagramId) return all.find((d) => String(d._id) === String(diagramId)) || null;
  const q = norm(name);
  if (!q) return null;
  return all.find((d) => norm(d.name) === q || norm(d.businessFlow) === q)
    || all.find((d) => norm(d.name).includes(q) || norm(d.businessFlow).includes(q))
    || null;
}

const appsOf = (d) => [...new Set((d.tasks || []).flatMap((t) => (t.applications || []).map((a) => clean(a.name))).filter(Boolean))];

// ── tools ───────────────────────────────────────────────────────────────

const searchFlows = {
  name: 'search_flows',
  label: 'Searching business flows',
  description: 'Find business process flows (BPMN diagrams). Filter by free text (matches flow, task, domain, subdomain, value stream and capability names), domain, or an application acronym used by any task. With no filters it lists every flow. Returns diagramId, name, domain, subdomain, task count and applications.',
  input_schema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Free text, e.g. "warranty", "recall", "credit"' },
      domain: { type: 'string', description: 'Business domain, e.g. "After-Sales & Service"' },
      application: { type: 'string', description: 'Application acronym, e.g. "CONNECTED-CAR"' },
      limit: { type: 'integer', minimum: 1, maximum: 120, description: 'Default 40' },
    },
  },
  async handler(args, api) {
    const all = await diagrams(api);
    const q = norm(args.query);
    const dom = norm(args.domain);
    const app = norm(args.application);
    const matches = all.filter((d) => {
      if (dom && !norm(d.domain).includes(dom)) return false;
      if (app && !appsOf(d).some((a) => norm(a) === app)) return false;
      if (!q) return true;
      const hay = [d.name, d.businessFlow, d.domain, d.subdomain, d.valueStream, d.businessCapability, ...(d.tasks || []).map((t) => t.name)].map(norm).join(' | ');
      return q.split(/\s+/).every((w) => hay.includes(w));
    });
    const limit = Math.min(args.limit || 40, 120);
    const rows = matches.slice(0, limit).map((d) => ({
      diagramId: String(d._id),
      name: clean(d.businessFlow || d.name),
      domain: clean(d.domain),
      subdomain: clean(d.subdomain),
      status: d.status || null,
      taskCount: (d.tasks || []).length,
      applications: appsOf(d),
    }));
    return { result: { totalMatches: matches.length, returned: rows.length, flows: rows }, refs: matches.slice(0, limit).map(flowRef) };
  },
};

const getFlow = {
  name: 'get_flow',
  label: 'Reading a flow',
  description: 'One business flow in detail: its hierarchy (domain, subdomain, value stream, capability), description, and every task in order with its actor and applications. Give diagramId (preferred) or the flow name.',
  input_schema: {
    type: 'object',
    properties: { diagramId: { type: 'string' }, name: { type: 'string' } },
  },
  async handler(args, api) {
    const found = await resolveFlow(api, args);
    if (!found) return { result: { error: 'No flow matches. Use search_flows first.' }, refs: [] };
    const d = await api.get(`/diagrams/${found._id}`);
    const apps = appsOf(d);
    return {
      result: {
        diagramId: String(d._id),
        name: clean(d.businessFlow || d.name),
        domain: clean(d.domain), subdomain: clean(d.subdomain),
        valueStream: clean(d.valueStream), businessCapability: clean(d.businessCapability),
        lineOfBusiness: clean(d.lineOfBusiness), product: clean(d.product), channel: clean(d.channel),
        status: d.status, version: d.version, owner: d.owner || null,
        description: short(d.description, 600),
        tasks: (d.tasks || []).map((t, i) => ({ step: i + 1, name: clean(t.name), actor: t.actor || null, next: t.target || null, applications: (t.applications || []).map((a) => clean(a.name)) })),
        applications: apps,
      },
      refs: [flowRef(d), ...apps.map((a) => appRef(a))],
    };
  },
};

const flowScorecards = {
  name: 'flow_scorecards',
  label: 'Reading flow scorecards',
  description: 'Per-flow scorecards: annual total cost of ownership (TCO, latest year, with run vs development split and prior year), SOX scope (controls, compliance %, open deviations by severity, overdue), and security/defect risk. Filter by diagramIds, flow names or domain; sort to find the most expensive or least compliant.',
  input_schema: {
    type: 'object',
    properties: {
      diagramIds: { type: 'array', items: { type: 'string' } },
      names: { type: 'array', items: { type: 'string' }, description: 'Flow names (partial match)' },
      domain: { type: 'string' },
      sortBy: { type: 'string', enum: ['tco', 'tco_change', 'sox_compliance', 'open_deviations', 'name'], description: 'Default tco (highest first)' },
      limit: { type: 'integer', minimum: 1, maximum: 111, description: 'Default 15' },
    },
  },
  async handler(args, api) {
    const data = await api.get('/dashboard/flow-scorecards');
    let rows = data.scorecards || [];
    if (args.diagramIds?.length) rows = rows.filter((r) => args.diagramIds.includes(String(r.diagramId)));
    if (args.names?.length) { const ns = args.names.map(norm); rows = rows.filter((r) => ns.some((n) => norm(r.name).includes(n))); }
    if (args.domain) rows = rows.filter((r) => norm(r.domain).includes(norm(args.domain)));
    const tco = (r) => r.tco?.total || 0;
    const sorters = {
      tco: (a, b) => tco(b) - tco(a),
      tco_change: (a, b) => ((b.tco?.total || 0) - (b.tco?.priorYearTotal || 0)) - ((a.tco?.total || 0) - (a.tco?.priorYearTotal || 0)),
      sox_compliance: (a, b) => (a.sox?.compliancePct ?? 101) - (b.sox?.compliancePct ?? 101),
      open_deviations: (a, b) => (b.sox?.openDeviations || 0) - (a.sox?.openDeviations || 0),
      name: (a, b) => clean(a.name).localeCompare(clean(b.name)),
    };
    rows = [...rows].sort(sorters[args.sortBy] || sorters.tco);
    const limit = Math.min(args.limit || 15, 111);
    const out = rows.slice(0, limit).map((r) => ({
      diagramId: r.diagramId, name: clean(r.name), domain: clean(r.domain), applications: r.applications,
      tco: r.tco ? { year: r.tco.year, total: r.tco.total, run: r.tco.run, development: r.tco.development, priorYearTotal: r.tco.priorYearTotal } : null,
      sox: r.sox?.inScope ? { controls: r.sox.controlCount, compliancePct: r.sox.compliancePct, openDeviations: r.sox.openDeviations, bySeverity: r.sox.bySeverity, overdue: r.sox.overdueDeviations } : { inScope: false },
      security: r.security, defect: r.defect,
    }));
    return { result: { tcoYear: data.tcoYear, totalMatches: rows.length, flows: out }, refs: rows.slice(0, limit).map(flowRef) };
  },
};

const getApplication = {
  name: 'get_application',
  label: 'Reading an application',
  description: 'One application\'s full catalog record (owners, domain, criticality, lifecycle, technology, hosting, upstream/downstream systems, data classification, compliance, DR tier, annual cost), its infrastructure risk profile (servers/software at security or defect risk), the flows that use it, and its SOX control count. Give the acronym (e.g. "WARRANTY-SALES"), app id (e.g. "LLM-010") or name.',
  input_schema: { type: 'object', properties: { application: { type: 'string' } }, required: ['application'] },
  async handler(args, api) {
    const key = clean(args.application);
    let record;
    try { record = await api.get('/system-components/applications/record', /^LLM-\d+$/i.test(key) ? { appId: key.toUpperCase() } : { key }); } catch (err) {
      if (err.status === 404) return { result: { error: `No application "${key}" in the catalog.` }, refs: [] };
      throw err;
    }
    const v = record.values || {};
    const fields = {};
    for (const [k, val] of Object.entries(v)) {
      if (k.startsWith('FK_') || k.startsWith('__') || val === '' || val === null) continue;
      fields[k.replace(/\s+(Qualifier|Aggregator|Component)$/i, '')] = typeof val === 'string' ? short(val, 500) : val;
    }
    const acronym = record.primaryKey;
    const [risk, all, sox] = await Promise.all([
      api.get('/dashboard/application-risk').catch(() => null),
      diagrams(api),
      api.get('/sox-controls', { app: acronym }).catch(() => []),
    ]);
    const profile = (risk?.applications || []).find((a) => a.acronym === acronym) || null;
    const flows = all.filter((d) => appsOf(d).some((a) => a === acronym));
    const openDeviations = sox.flatMap((c) => (c.deviations || []).filter((d) => d.remediation?.status !== 'Closed'));
    return {
      result: {
        acronym, fields,
        riskProfile: profile,
        usedByFlows: flows.map((d) => ({ diagramId: String(d._id), name: clean(d.businessFlow || d.name), domain: clean(d.domain) })),
        sox: { controls: sox.length, openDeviations: openDeviations.length, highSeverityOpen: openDeviations.filter((d) => d.severity === 'High').length },
      },
      refs: [appRef(acronym, fields.APP_NAME), ...flows.map(flowRef)],
    };
  },
};

const soxControls = {
  name: 'sox_controls',
  label: 'Looking up SOX controls',
  description: 'SOX controls (ITGCs, business-process, IT-application and interface controls). Filter by application acronym, flow (diagramId), category, audit risk (High/Medium/Low) or text; optionally only controls with open deviations. Returns control id, title, category, process cycle, risk, owner, frequency and open deviations.',
  input_schema: {
    type: 'object',
    properties: {
      application: { type: 'string' },
      diagramId: { type: 'string' },
      category: { type: 'string', description: 'e.g. "IT General Control", "Business Process Control", "IT Application Control", "Interface Control"' },
      auditRisk: { type: 'string', enum: ['High', 'Medium', 'Low'] },
      query: { type: 'string' },
      onlyWithOpenDeviations: { type: 'boolean' },
      limit: { type: 'integer', minimum: 1, maximum: 100, description: 'Default 25' },
    },
  },
  async handler(args, api) {
    let controls;
    if (args.diagramId) {
      const r = await api.get(`/sox-controls/for-diagram/${args.diagramId}`);
      const seen = new Map();
      [...(r.diagramControls || []), ...Object.values(r.byTaskName || {}).flat(), ...Object.values(r.byApplicationName || {}).flat()].forEach((c) => seen.set(c.controlId, c));
      controls = [...seen.values()];
    } else {
      controls = await api.get('/sox-controls', { app: args.application, risk: args.auditRisk, q: args.query });
    }
    if (args.category) controls = controls.filter((c) => norm(c.category).includes(norm(args.category)));
    const open = (c) => (c.deviations || []).filter((d) => d.remediation?.status !== 'Closed');
    if (args.onlyWithOpenDeviations) controls = controls.filter((c) => open(c).length);
    const limit = Math.min(args.limit || 25, 100);
    const rows = controls.slice(0, limit).map((c) => ({
      controlId: c.controlId, title: short(c.title, 160), category: c.category, processCycle: c.processCycleName || c.processCycle,
      auditRisk: c.auditRisk, keyControl: c.keyControl, owner: c.controlOwner, frequency: c.frequency,
      applications: cap((c.scope?.applications || []).map((a) => a.name), 8),
      openDeviations: open(c).map((d) => ({ deviationId: d.deviationId, severity: d.severity, title: short(d.title, 140), status: d.remediation?.status, targetDate: d.remediation?.targetDate })),
    }));
    return { result: { totalMatches: controls.length, returned: rows.length, controls: rows }, refs: rows.map((c) => ({ kind: 'control', id: c.controlId, name: c.title })) };
  },
};

const soxDeviations = {
  name: 'sox_deviations',
  label: 'Looking up SOX deviations',
  description: 'SOX audit findings (deviations): severity, category (Control Not Sufficient / Issue Found During Audit / Missing Control / Insufficient Evidence), deficiency classification, condition, audit and auditor, remediation status/owner/target date, and the applications and flows affected. Filter by severity, category, remediation status, or an application acronym / flow name in the affected scope.',
  input_schema: {
    type: 'object',
    properties: {
      severity: { type: 'string', enum: ['High', 'Medium', 'Low'] },
      category: { type: 'string' },
      status: { type: 'string', description: 'Remediation status, e.g. "Open", "In Progress", "Closed"' },
      application: { type: 'string' },
      flow: { type: 'string' },
      limit: { type: 'integer', minimum: 1, maximum: 60, description: 'Default 20' },
    },
  },
  async handler(args, api) {
    let rows = await api.get('/sox-controls/deviations', { severity: args.severity, category: args.category, status: args.status });
    const inAffected = (d, term) => JSON.stringify(d.affected || {}).toLowerCase().includes(norm(term));
    if (args.application) rows = rows.filter((d) => inAffected(d, args.application) || norm(d.controlId).includes(norm(args.application)));
    if (args.flow) rows = rows.filter((d) => inAffected(d, args.flow));
    const limit = Math.min(args.limit || 20, 60);
    const out = rows.slice(0, limit).map((d) => ({
      deviationId: d.deviationId, controlId: d.controlId, controlTitle: short(d.controlTitle, 140),
      severity: d.severity, category: d.category, classification: d.deficiencyClassification,
      title: short(d.title, 180), condition: short(d.condition, 320),
      audit: d.audit ? { name: d.audit.auditName || d.audit.name, auditor: d.audit.auditor || d.audit.leadAuditor, date: d.audit.auditDate } : null,
      remediation: d.remediation ? { status: d.remediation.status, owner: d.remediation.owner, targetDate: d.remediation.targetDate, repeat: d.remediation.repeatFinding } : null,
      affected: d.affected ? { applications: cap(d.affected.applications, 6), flows: cap(d.affected.businessFlows || d.affected.flows, 6) } : null,
    }));
    return { result: { totalMatches: rows.length, returned: out.length, deviations: out }, refs: out.map((d) => ({ kind: 'control', id: d.controlId, name: d.controlTitle })) };
  },
};

let radarCache = { at: 0, data: null };
const jiraChanges = {
  name: 'jira_changes',
  label: 'Checking Jira changes',
  description: 'In-flight Jira work (active and planned sprints) that touches business flows and applications: per flow the issue count, at-risk (missed due date) count and remaining dev-days, plus the issues (key, summary, status, assignee, due date, overdue). Filter by diagramId, flow name or application acronym; optionally only overdue issues. For totals, rankings and story-point rollups use jira_flow_rollup.',
  input_schema: {
    type: 'object',
    properties: {
      diagramId: { type: 'string' },
      flow: { type: 'string' },
      application: { type: 'string' },
      onlyOverdue: { type: 'boolean' },
      limit: { type: 'integer', minimum: 1, maximum: 50, description: 'Flows to return, default 10' },
    },
  },
  async handler(args, api) {
    if (!radarCache.data || Date.now() - radarCache.at > 2 * 60 * 1000) {
      radarCache = { at: Date.now(), data: await api.get('/process-change-radar', {}, { timeoutMs: 180000 }) };
    }
    const data = radarCache.data;
    if (data.configured === false) return { result: { error: 'Jira is not configured on this server.' }, refs: [] };
    let flows = data.diagrams || [];
    if (args.diagramId) flows = flows.filter((f) => String(f.diagramId) === String(args.diagramId));
    if (args.flow) flows = flows.filter((f) => norm(f.name).includes(norm(args.flow)));
    const issueApps = (i) => (i.applicationNames || []).map(norm).join(' ');
    if (args.application) flows = flows.filter((f) => (f.issues || []).some((i) => issueApps(i).includes(norm(args.application))));
    const limit = Math.min(args.limit || 10, 50);
    const refs = [];
    const out = flows.slice(0, limit).map((f) => {
      let issues = f.issues || [];
      if (args.application) issues = issues.filter((i) => issueApps(i).includes(norm(args.application)));
      if (args.onlyOverdue) issues = issues.filter((i) => i.isOverdue);
      refs.push({ kind: 'flow', id: String(f.diagramId), name: clean(f.name) });
      const shown = issues.slice(0, 12);
      shown.forEach((i) => refs.push({ kind: 'jira', id: i.key, name: short(i.summary, 120), url: i.url }));
      return {
        diagramId: f.diagramId, name: clean(f.name), domain: clean(f.domain),
        issueCount: f.issueCount, atRiskCount: f.atRiskCount, devDaysRemaining: f.totalDevDays,
        issues: shown.map((i) => ({ key: i.key, summary: short(i.summary, 140), status: i.status, assignee: i.assignee, dueDate: i.dueDate, overdue: i.isOverdue, storyPoints: i.storyPoints })),
        moreIssues: Math.max(0, issues.length - shown.length),
      };
    });
    return { result: { asOf: data.generatedAt, flowsImpacted: (data.diagrams || []).length, totalMatches: flows.length, flows: out }, refs };
  },
};

const jiraFlowRollup = {
  name: 'jira_flow_rollup',
  label: 'Rolling up Jira work by flow',
  description: 'Jira work in flight rolled up per business process flow, plus per-domain and landscape totals. Per flow: issue count; story points (total, on track, due within 7 days, overdue) and dev-days; late (overdue) issues and points, max/avg days overdue and the oldest late issue; user stories (Story-type issues) and how many are late; issues with no due date or no estimate; stale issues (not updated recently); breakdowns by issue type, status, status category, priority, sprint (current vs planned) and assignee; jeopardy ratio and red/amber/green rating (same rules as the Process Change Heat Map); how issues were matched (Business Process Flow field vs application/API); top applications. Use this for counts, totals, rankings and comparisons ("which flows have the most late work", "story points in flight for Finance", "how many late stories on X"). Use jira_changes for the individual issues. Filter by diagramId, flow name, domain or application; sort by latePoints (default), lateIssues, lateStories, storyPoints, issues, jeopardy, daysOverdue, dueSoon or stale. detail "summary" (default) returns the headline numbers per flow; "full" adds every breakdown (use it for one or a few flows).',
  input_schema: {
    type: 'object',
    properties: {
      diagramId: { type: 'string' },
      flow: { type: 'string', description: 'Flow name or part of it' },
      domain: { type: 'string', description: 'Business domain or part of it' },
      application: { type: 'string', description: 'Only issues that name this application or API (acronym or name)' },
      sort: { type: 'string', enum: ['latePoints', 'lateIssues', 'lateStories', 'storyPoints', 'issues', 'jeopardy', 'daysOverdue', 'dueSoon', 'stale'] },
      detail: { type: 'string', enum: ['summary', 'full'] },
      limit: { type: 'integer', minimum: 1, maximum: 120, description: 'Flows to return, default 15' },
    },
  },
  async handler(args, api) {
    let data;
    try {
      data = await api.get('/process-change-radar/flow-aggregates', {
        diagramId: args.diagramId, flow: args.flow, domain: args.domain, application: args.application, sort: args.sort,
      }, { timeoutMs: 180000 });
    } catch (err) {
      if (err.status === 400) return { result: { error: 'Jira is not configured on this server.' }, refs: [] };
      throw err;
    }
    const full = args.detail === 'full';
    const limit = Math.min(args.limit || 15, 120);
    const flows = (data.flows || []).slice(0, limit).map((f) => {
      const base = {
        diagramId: f.diagramId, name: f.name, domain: f.domain, rag: f.rag, jeopardyRatio: f.jeopardyRatio,
        issues: f.issueCount, storyPoints: f.storyPoints, late: f.late, latePointsPct: f.latePointsPct,
        dueSoon7: f.dueSoon7, userStories: f.userStories, noDueDate: f.noDueDate, stale: f.stale.issues, nearestDue: f.nearestDue,
      };
      if (!full) return base;
      return {
        ...base, staleDetail: f.stale, byType: f.byType, byStatus: f.byStatus, byStatusCategory: f.byStatusCategory,
        byPriority: f.byPriority, bySprint: f.bySprint, assignees: f.assignees, matchedVia: f.matchedVia, applications: f.applications,
      };
    });
    const t = data.totals || {};
    return {
      result: {
        asOf: data.generatedAt,
        scope: 'Open Jira work only (not Done), in active or planned sprints. "Late" = past its due date.',
        sort: data.sort, staleAfterDays: data.staleDays,
        flowsMatching: data.flowCount, returned: flows.length,
        totals: {
          flowsWithWork: t.flowsWithWork, flowRag: t.flowRag, issues: t.issueCount, storyPoints: t.storyPoints,
          late: t.late, dueSoon7: t.dueSoon7, userStories: t.userStories, latePointsPct: t.latePointsPct,
          noDueDate: t.noDueDate, stale: t.stale, byType: t.byType, byStatusCategory: t.byStatusCategory, bySprint: t.bySprint,
          assignees: t.assignees ? { distinct: t.assignees.distinct, unassignedIssues: t.assignees.unassignedIssues } : null,
          note: t.note,
        },
        byDomain: data.byDomain,
        flows,
      },
      refs: flows.map((f) => ({ kind: 'flow', id: f.diagramId, name: f.name }))
        .concat(flows.map((f) => f.late?.oldest).filter(Boolean).map((o) => ({ kind: 'jira', id: o.key, name: o.summary }))),
    };
  },
};

const vendorSupport = {
  name: 'vendor_support',
  label: 'Checking vendor support dates',
  description: 'Vendor support lifecycle of the hardware, operating systems and software behind business flows, now and forecast 1, 2 and 3 years out. Per flow: servers and software installs, and at each checkpoint how many servers have unsupported hardware or OS, how many software installs are past end of support, % of the flow\'s servers and software affected, applications affected, and servers out of warranty (reported separately; out of warranty is not unsupported). Also the flow\'s rating (red/amber/green/no data), the next item to lose support, and (detail "full") a quarterly timeline and the products driving it. The landscape section covers the whole estate (or the matching flows when filtered), with the top products losing support. Hardware dates are ESTIMATES (server generation release + 8 years) unless an administrator entered the vendor date; OS and software dates come from the catalog. Filter by diagramId, flow, domain or application acronym; asOf (YYYY-MM-DD) shifts "now". Sort flows by now, 1y, 2y or 3y (share of servers affected).',
  input_schema: {
    type: 'object',
    properties: {
      diagramId: { type: 'string' },
      flow: { type: 'string' },
      domain: { type: 'string' },
      application: { type: 'string', description: 'Application acronym' },
      asOf: { type: 'string', description: 'YYYY-MM-DD; default today' },
      sort: { type: 'string', enum: ['now', '1y', '2y', '3y'], description: 'Default now' },
      detail: { type: 'string', enum: ['summary', 'full'] },
      limit: { type: 'integer', minimum: 1, maximum: 110, description: 'Flows to return, default 15' },
    },
  },
  async handler(args, api) {
    const full = args.detail === 'full';
    const data = await api.get('/support-lifecycle/flows', {
      diagramId: args.diagramId, flow: args.flow, domain: args.domain, application: args.application, asOf: args.asOf, drivers: full ? 1 : undefined,
    });
    const idx = { now: 0, '1y': 1, '2y': 2, '3y': 3 }[args.sort || 'now'] ?? 0;
    const score = (f) => (f.checkpoints[idx]?.serversPct || 0) + (f.checkpoints[idx]?.softwarePct || 0) / 100;
    const flows = [...(data.flows || [])].sort((a, b) => score(b) - score(a)).slice(0, Math.min(args.limit || 15, 110));
    const slim = (c) => ({ when: c.label, date: c.date, serversAffected: c.serversAffected, serversPct: c.serversPct, hardware: c.hardware, os: c.os, software: c.software, softwarePct: c.softwarePct, appsAffected: c.appsAffected, outOfWarranty: c.outOfWarranty });
    const out = flows.map((f) => ({
      diagramId: f.diagramId, name: f.name, domain: f.domain, rating: f.rating,
      servers: f.totals.servers, softwareInstalls: f.totals.software, unknownDates: f.totals.unknownDates,
      checkpoints: f.checkpoints.map(slim), nextLoss: f.nextLoss,
      uncataloguedApplications: f.uncataloguedApplications.length ? f.uncataloguedApplications : undefined,
      ...(full ? { timeline: f.timeline, drivers: f.drivers } : {}),
    }));
    return {
      result: {
        asOf: data.asOf, sources: data.sources, ratingRule: data.ratingRule,
        landscape: { scope: data.landscape.scope, totals: data.landscape.totals, ratings: data.landscape.ratings, checkpoints: data.landscape.checkpoints.map(slim), topProductsLosingSupport: data.landscape.drivers.slice(0, full ? 15 : 8) },
        byDomain: data.byDomain,
        flowsMatching: (data.flows || []).length, returned: out.length, flows: out,
      },
      refs: out.map((f) => ({ kind: 'flow', id: f.diagramId, name: f.name })),
    };
  },
};

const businessMetrics = {
  name: 'business_metrics',
  label: 'Reading business metrics',
  description: 'Leadership business measures from production telemetry: vehicles sold, built and passing final quality, designs released, safety certifications, OTA updates delivered, repair orders closed, warranty claims paid, recall repairs, finance contracts funded, connected subscriptions renewed. For a window of 6, 24, 168 (7 days) or 720 (30 days) hours: total, previous-window total, USD value and top breakdown. If live telemetry is down the last saved snapshot is used (see snapshot.capturedAt).',
  input_schema: {
    type: 'object',
    properties: { hours: { type: 'integer', enum: [6, 24, 168, 720], description: 'Default 24' } },
  },
  async handler(args, api) {
    const data = await api.get('/business-kpis/metrics', { hours: args.hours || 24 });
    return {
      result: {
        windowHours: data.hours, generatedAt: data.generatedAt,
        snapshot: data.snapshot ? { capturedAt: data.snapshot.capturedAt, note: 'Live telemetry unavailable; this is the last saved snapshot.' } : null,
        metrics: (data.metrics || []).map((m) => ({
          id: m.id, label: m.label, unit: m.unit, domain: m.domain, total: m.total, previousTotal: m.previousTotal,
          value: m.value, previousValue: m.previousValue, valueLabel: m.valueLabel || null, lowerIsBetter: Boolean(m.lowerIsBetter),
          topBreakdown: cap(m.dimensions, 4), dimensionLabel: m.dimensionLabel, countedAt: m.source,
        })),
      },
      refs: [],
    };
  },
};

const TOOLS = [searchFlows, getFlow, flowScorecards, getApplication, soxControls, soxDeviations, jiraChanges, jiraFlowRollup, vendorSupport, businessMetrics];

module.exports = { TOOLS };
