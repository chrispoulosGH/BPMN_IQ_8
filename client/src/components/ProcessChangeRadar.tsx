import { useCallback, useEffect, useMemo, useState } from 'react';
import { Alert, Button, Collapse, Drawer, Empty, Input, List, Segmented, Space, Spin, Tag, Typography } from 'antd';
import { ReloadOutlined, SearchOutlined } from '@ant-design/icons';
import BpmnEditor, { EMPTY_DIAGRAM } from './BpmnEditor';
import type { ImpactIssueLike } from './BpmnEditor';
import ApplicationImpact3DChart from './ApplicationImpact3DChart';
import { getApplicationReferenceForNeighborhood, getDiagram, getProcessChangeRadar } from '../api';
import type { ApplicationItem, JiraApplicationImpact, JiraImpactIssue, ProcessChangeRadarDiagramSummary } from '../types';

// Same reference-data scope App.tsx uses for the Diagrams tab (see
// REFERENCE_DATA_NEIGHBORHOOD_NAME there) — without this, BpmnEditor has no
// application catalog to validate against and every application on the
// canvas renders as "invalid" (orange) regardless of its real status.
const REFERENCE_DATA_NEIGHBORHOOD_NAME = 'System Components';

const { Title, Text } = Typography;

// Diagram.domain values in the data include both a clean "Warranty &
// Protection Services" and an HTML-escaped "Warranty &amp; Protection
// Services" spelling of the same domain (an upstream import artifact) — fold
// them together so they don't split into two sidebar groups.
function normalizeDomainLabel(domain?: string | null): string {
  const trimmed = (domain || '').replace(/&amp;/gi, '&').trim();
  return trimmed || 'Uncategorized';
}

/**
 * "Process Change Radar" — every business process flow diagram currently
 * touched by in-flight (not Done/Closed) Jira work, browsable via a
 * domain-grouped, searchable sidebar (most-impacted flow selected by
 * default), with a count badge on every task/application the work names.
 * Clicking a badge opens the Jira details in a right-hand drawer.
 *
 * One diagram is shown on the canvas at a time — fetched only on selection,
 * not all up front — so this scales to however many flows are impacted
 * (unlike an earlier version that stacked up to 25 onto one composite
 * canvas, which got unwieldy well before real Jira data produced 70+ hits).
 */
export default function ProcessChangeRadar() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notConfigured, setNotConfigured] = useState(false);
  const [summaries, setSummaries] = useState<ProcessChangeRadarDiagramSummary[]>([]);
  const [issuesByApplicationName, setIssuesByApplicationName] = useState<Record<string, JiraImpactIssue[]>>({});
  const [allApplications, setAllApplications] = useState<ApplicationItem[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedDiagramId, setSelectedDiagramId] = useState<string | null>(null);
  const [selectedDiagramXml, setSelectedDiagramXml] = useState<string>(EMPTY_DIAGRAM);
  const [diagramLoading, setDiagramLoading] = useState(false);
  const [diagramError, setDiagramError] = useState<string | null>(null);
  const [importTrigger, setImportTrigger] = useState(0);
  const [generatedAt, setGeneratedAt] = useState<string | null>(null);
  const [drawerIssues, setDrawerIssues] = useState<JiraImpactIssue[] | null>(null);
  const [drawerElementName, setDrawerElementName] = useState<string>('');
  const [drawerApplications, setDrawerApplications] = useState<JiraApplicationImpact[]>([]);
  const [drawerView, setDrawerView] = useState<'list' | '3d'>('list');

  // Fetches fresh from Jira (via the server) every time this runs — no
  // caching. Since the outer Tabs uses destroyInactiveTabPane, this
  // component only exists while its tab is open, so mounting IS "the button
  // was pressed": leaving and reopening the tab re-runs this from scratch.
  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    setNotConfigured(false);
    try {
      const data = await getProcessChangeRadar();
      setGeneratedAt(data.generatedAt);
      setIssuesByApplicationName(data.issuesByApplicationName || {});
      const diagrams = data.diagrams || [];
      setSummaries(diagrams);
      // Keep the current selection if it's still impacted; otherwise default
      // to the top-ranked (most impacted) flow.
      setSelectedDiagramId((current) => {
        if (current && diagrams.some((d) => d.diagramId === current)) return current;
        return diagrams[0]?.diagramId || null;
      });
    } catch (err: any) {
      const responseData = err?.response?.data;
      if (responseData?.configured === false) setNotConfigured(true);
      setError(responseData?.error || err?.message || 'Failed to load Process Change Radar.');
      setSummaries([]);
      setSelectedDiagramId(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  // Application catalog for validity checks (valid/invalid coloring on the
  // canvas) — independent of the Jira data above, so it's fetched once and
  // doesn't need to re-run on Refresh.
  useEffect(() => {
    getApplicationReferenceForNeighborhood(REFERENCE_DATA_NEIGHBORHOOD_NAME)
      .then((applications) => setAllApplications(applications || []))
      .catch(() => setAllApplications([]));
  }, []);

  // Fetch the selected flow's full diagram XML on demand — only ever one at
  // a time, so switching flows in the sidebar stays cheap regardless of how
  // many are impacted overall.
  useEffect(() => {
    if (!selectedDiagramId) {
      setSelectedDiagramXml(EMPTY_DIAGRAM);
      setImportTrigger((t) => t + 1);
      return;
    }
    let cancelled = false;
    setDiagramLoading(true);
    setDiagramError(null);
    getDiagram(selectedDiagramId)
      .then((diagram) => {
        if (cancelled) return;
        setSelectedDiagramXml(diagram.xml);
        setImportTrigger((t) => t + 1);
      })
      .catch((err: any) => {
        if (cancelled) return;
        setDiagramError(err?.response?.data?.error || err?.message || 'Failed to load this diagram.');
        setSelectedDiagramXml(EMPTY_DIAGRAM);
      })
      .finally(() => { if (!cancelled) setDiagramLoading(false); });
    return () => { cancelled = true; };
  }, [selectedDiagramId]);

  // Business Process Flow-matched issues have no task-level anchor (see
  // types.ts) — keyed by diagramId instead, for a badge on each diagram's
  // title banner rather than on any one task.
  const issuesByDiagramId = useMemo(() => {
    const map: Record<string, JiraImpactIssue[]> = {};
    for (const summary of summaries) {
      if (summary.issues?.length) map[summary.diagramId] = summary.issues;
    }
    return map;
  }, [summaries]);

  // Keyed by diagramId, same as issuesByDiagramId — only a diagram-level
  // (Business Process Flow) badge click resolves one of these, since that's
  // the only click that knows which diagram it came from (see
  // renderDiagramImpactBadge in BpmnEditor.tsx). A task-level (application)
  // badge click has no diagramId, so its drawer only ever shows the list.
  const applicationImpactByDiagramId = useMemo(() => {
    const map: Record<string, JiraApplicationImpact[]> = {};
    for (const summary of summaries) {
      if (summary.applicationImpact?.length) map[summary.diagramId] = summary.applicationImpact;
    }
    return map;
  }, [summaries]);

  const handleIndicatorClick = useCallback((issues: ImpactIssueLike[], context: { elementType: 'task' | 'diagram'; elementName: string; diagramId?: string }) => {
    setDrawerIssues(issues as JiraImpactIssue[]);
    setDrawerElementName(context.elementName);
    setDrawerApplications(context.diagramId ? (applicationImpactByDiagramId[context.diagramId] || []) : []);
    setDrawerView('list');
  }, [applicationImpactByDiagramId]);

  const selectedSummary = useMemo(
    () => summaries.find((s) => s.diagramId === selectedDiagramId) || null,
    [summaries, selectedDiagramId]
  );

  // Search matches a flow's name or its domain — the same field it's
  // grouped by below, so typing a domain name is an alternative to scrolling
  // to find its group.
  const filteredSummaries = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return summaries;
    return summaries.filter((s) => s.name.toLowerCase().includes(q) || normalizeDomainLabel(s.domain).toLowerCase().includes(q));
  }, [summaries, searchQuery]);

  // Grouped by Diagram.domain (falling back to "Uncategorized"), most
  // at-risk-heavy domain first — mirrors the per-flow ranking below it.
  const groupedByDomain = useMemo(() => {
    const groups = new Map<string, ProcessChangeRadarDiagramSummary[]>();
    for (const summary of filteredSummaries) {
      const key = normalizeDomainLabel(summary.domain);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(summary);
    }
    return Array.from(groups.entries())
      .map(([domain, flows]) => ({
        domain,
        flows,
        atRiskCount: flows.reduce((sum, f) => sum + f.atRiskCount, 0),
        totalDevDays: Math.round(flows.reduce((sum, f) => sum + f.totalDevDays, 0) * 100) / 100,
      }))
      .sort((a, b) => (b.atRiskCount - a.atRiskCount) || (b.totalDevDays - a.totalDevDays) || a.domain.localeCompare(b.domain));
  }, [filteredSummaries]);

  const totalAtRisk = summaries.reduce((sum, s) => sum + s.atRiskCount, 0);
  const totalDevDays = Math.round(summaries.reduce((sum, s) => sum + s.totalDevDays, 0) * 100) / 100;

  return (
    <div className="flex h-full w-full min-h-0 flex-col">
      <div className="flex items-center justify-between gap-3 border-b border-slate-200 bg-slate-50 px-4 py-2.5">
        <div className="flex items-center gap-3">
          <Title level={5} className="!mb-0">Process Change Radar</Title>
          {!loading && !error && summaries.length > 0 && (
            <Space size={6}>
              <Tag color="blue">{summaries.length} flow{summaries.length === 1 ? '' : 's'} impacted</Tag>
              <Tag color={totalAtRisk ? 'red' : 'default'}>{totalAtRisk} at risk (missed date)</Tag>
              <Tag>{totalDevDays} dev-day{totalDevDays === 1 ? '' : 's'} remaining</Tag>
            </Space>
          )}
        </div>
        <div className="flex items-center gap-3">
          {generatedAt && !loading && (
            <Text type="secondary" className="text-xs">as of {new Date(generatedAt).toLocaleTimeString()}</Text>
          )}
          <Button size="small" icon={<ReloadOutlined />} onClick={() => void load()} loading={loading}>Refresh</Button>
        </div>
      </div>

      <div className="flex min-h-0 flex-1">
        {!loading && !notConfigured && !error && summaries.length > 0 && (
          <div className="flex w-80 shrink-0 flex-col border-r border-slate-200 bg-white">
            <div className="border-b border-slate-100 p-2">
              <Input
                allowClear
                size="small"
                prefix={<SearchOutlined className="text-slate-400" />}
                placeholder="Search flows or domains…"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
              />
            </div>
            <div className="flex-1 overflow-y-auto p-2">
              {!filteredSummaries.length ? (
                <Empty description="No flows match your search" className="mt-8" />
              ) : (
                <Collapse
                  ghost
                  size="small"
                  defaultActiveKey={groupedByDomain.map((g) => g.domain)}
                  items={groupedByDomain.map((group) => ({
                    key: group.domain,
                    label: (
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-sm font-medium text-slate-700">{group.domain}</span>
                        <Space size={4}>
                          <Tag className="!m-0">{group.flows.length}</Tag>
                          {group.atRiskCount > 0 && <Tag color="red" className="!m-0">{group.atRiskCount} at risk</Tag>}
                        </Space>
                      </div>
                    ),
                    children: (
                      <div className="flex flex-col gap-1">
                        {group.flows.map((flow) => (
                          <button
                            key={flow.diagramId}
                            onClick={() => setSelectedDiagramId(flow.diagramId)}
                            className={`rounded px-2 py-1.5 text-left text-xs transition-colors ${
                              flow.diagramId === selectedDiagramId
                                ? 'border border-blue-200 bg-blue-50'
                                : 'border border-transparent hover:bg-slate-50'
                            }`}
                          >
                            <div className="truncate font-medium text-slate-800">{flow.name}</div>
                            <div className="mt-0.5 flex items-center gap-1.5">
                              {flow.atRiskCount > 0 && (
                                <Tag color="red" className="!m-0 !px-1 !text-[10px] !leading-4">{flow.atRiskCount} at risk</Tag>
                              )}
                              <span className="text-[10px] text-slate-400">{flow.totalDevDays}d remaining</span>
                            </div>
                          </button>
                        ))}
                      </div>
                    ),
                  }))}
                />
              )}
            </div>
          </div>
        )}

        <div className="relative min-h-0 flex-1">
          {loading && (
            <div className="absolute inset-0 z-10 flex items-center justify-center bg-white/70">
              <Spin size="large" tip="Querying Jira for in-flight changes…" />
            </div>
          )}
          {!loading && notConfigured && (
            <div className="flex h-full items-center justify-center p-8">
              <Empty description={<span className="max-w-md text-sm text-slate-600">{error}</span>} />
            </div>
          )}
          {!loading && !notConfigured && error && (
            <div className="p-4">
              <Alert type="error" showIcon message="Couldn't load Process Change Radar" description={error} />
            </div>
          )}
          {!loading && !notConfigured && !error && !summaries.length && (
            <div className="flex h-full items-center justify-center p-8">
              <Empty description="No business process flows are currently affected by in-flight Jira changes." />
            </div>
          )}
          {!loading && !notConfigured && !error && summaries.length > 0 && (
            <>
              {diagramLoading && (
                <div className="absolute inset-0 z-10 flex items-center justify-center bg-white/70">
                  <Spin size="large" />
                </div>
              )}
              {diagramError ? (
                <div className="p-4">
                  <Alert type="error" showIcon message="Couldn't load this diagram" description={diagramError} />
                </div>
              ) : (
                <BpmnEditor
                  xml={selectedDiagramXml}
                  importTrigger={importTrigger}
                  showProperties={false}
                  readOnly
                  diagramName={selectedSummary?.name}
                  diagramId={selectedSummary?.diagramId || null}
                  allApplications={allApplications}
                  impactByDiagramId={issuesByDiagramId}
                  impactByApplicationName={issuesByApplicationName}
                  onImpactIndicatorClick={handleIndicatorClick}
                />
              )}
            </>
          )}
        </div>
      </div>

      <Drawer
        title={drawerElementName ? `Jira changes — ${drawerElementName}` : 'Jira changes'}
        placement="right"
        width={drawerView === '3d' ? 720 : 420}
        open={Boolean(drawerIssues)}
        onClose={() => { setDrawerIssues(null); setDrawerElementName(''); setDrawerApplications([]); setDrawerView('list'); }}
        extra={drawerApplications.length > 0 && (
          <Segmented
            size="small"
            value={drawerView}
            onChange={(v) => setDrawerView(v as 'list' | '3d')}
            options={[{ label: 'List', value: 'list' }, { label: '3D Map', value: '3d' }]}
          />
        )}
      >
        {drawerView === '3d' ? (
          <ApplicationImpact3DChart applications={drawerApplications} flowName={drawerElementName} />
        ) : (
          <List
            dataSource={drawerIssues || []}
            renderItem={(issue) => (
              <List.Item key={issue.key} className="!block">
                <div className="w-full">
                  <div className="flex items-center justify-between gap-2">
                    <a href={issue.url} target="_blank" rel="noreferrer" className="font-semibold text-blue-700">{issue.key}</a>
                    <Tag color={issue.isOverdue ? 'red' : issue.statusCategory === 'In Progress' ? 'blue' : 'default'}>{issue.status}</Tag>
                  </div>
                  <div className="mt-1 text-sm text-slate-700">{issue.summary}</div>
                  <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-500">
                    {issue.assignee && <span>👤 {issue.assignee}</span>}
                    {issue.dueDate && (
                      <span style={issue.isOverdue ? { color: '#cf1322', fontWeight: 600 } : undefined}>
                        {issue.isOverdue ? '⚠ Missed' : '📅 Due'} {issue.dueDate}
                      </span>
                    )}
                    {issue.storyPoints > 0 && <span>{issue.storyPoints} pts ≈ {issue.devDays}d</span>}
                  </div>
                  {issue.source && issue.matchedValue && (
                    <Tag color="purple" className="mt-2">{issue.source}: {issue.matchedValue}</Tag>
                  )}
                </div>
              </List.Item>
            )}
          />
        )}
      </Drawer>
    </div>
  );
}
