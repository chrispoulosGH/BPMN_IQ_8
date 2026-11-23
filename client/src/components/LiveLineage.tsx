import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type React from 'react';
import { Alert, Button, Empty, Segmented, Select, Spin, Switch, Table, Tag, Tooltip } from 'antd';
import { InfoCircleOutlined, ReloadOutlined } from '@ant-design/icons';
import { sankey as d3Sankey, sankeyLinkHorizontal, type SankeyLink, type SankeyNode } from 'd3-sankey';
import { getLiveLineage } from '../api';
import type { LiveLineageApi, LiveLineageApp, LiveLineageFlow, LiveLineageResponse } from '../types';
import SnapshotNotice from './SnapshotNotice';

/**
 * Integration Map › Live lineage: which business flows are running in
 * production right now → which applications serve them → which APIs they call.
 * Built from live telemetry (GET /api/live-lineage: Tempo span metrics in
 * Prometheus), not from the catalog.
 *
 * Link width = API calls in the window. Hover or click a flow to trace its
 * exact path (an app can serve several flows, so the app → API links that
 * belong to the flow are highlighted, not every link out of the app).
 * Amber marks what production uses but BPMN IQ doesn't know: flows with no
 * diagram, apps missing from the Applications catalog, APIs missing from the
 * API catalog.
 */

const COLOR = {
  node: '#64748b',
  flagged: '#d97706',
  link: '#cbd5e1',
  active: '#2563eb',
  error: '#dc2626',
  ink: '#0f172a',
  inkMuted: '#64748b',
};
const WINDOWS = [
  { label: '5 min', value: 5 },
  { label: '15 min', value: 15 },
  { label: '1 h', value: 60 },
  { label: '6 h', value: 360 },
  { label: '24 h', value: 1440 },
];
const TOP_OPTIONS = [10, 25, 50, 0];
const LABEL_W = 230;

type Kind = 'flow' | 'app' | 'api';
interface NodeDatum {
  id: string;
  kind: Kind;
  label: string;
  flagged: boolean;
  errors: number;
  data: LiveLineageFlow | LiveLineageApp | LiveLineageApi;
}
interface LinkDatum { source: string; target: string; value: number; flows: Set<string> }
type SNode = SankeyNode<NodeDatum, LinkDatum>;
type SLink = SankeyLink<NodeDatum, LinkDatum>;

interface LiveLineageProps {
  /** Open these flows on Business Processes › Processes. */
  onOpenBusinessFlows?: (flows: string[], label: string) => void;
}

const truncate = (v: string, n: number) => (v.length > n ? `${v.slice(0, n - 1)}…` : v);
const apiLabel = (api: LiveLineageApi) => {
  const last = (api.endpoint || '').split('/').filter(Boolean).pop();
  return `${api.method || ''} ${last ? `…/${last}` : api.apiId}`.trim();
};

export default function LiveLineage({ onOpenBusinessFlows }: LiveLineageProps) {
  const [minutes, setMinutes] = useState(60);
  const [domain, setDomain] = useState<string | undefined>(undefined);
  const [top, setTop] = useState(25);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [data, setData] = useState<LiveLineageResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hoverFlow, setHoverFlow] = useState<string | null>(null);
  const [pinnedFlow, setPinnedFlow] = useState<string | null>(null);
  const [tooltip, setTooltip] = useState<{ x: number; y: number; content: React.ReactNode } | null>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(1100);

  useEffect(() => {
    const el = cardRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(([entry]) => setWidth(Math.max(760, Math.floor(entry.contentRect.width))));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setData(await getLiveLineage(minutes, domain));
    } catch (err: any) {
      setError(err?.response?.data?.error || err?.message || 'Failed to load live lineage');
    } finally {
      setLoading(false);
    }
  }, [minutes, domain]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    if (!autoRefresh) return undefined;
    const timer = window.setInterval(() => { void load(); }, 30000);
    return () => window.clearInterval(timer);
  }, [autoRefresh, load]);

  // Keep the top-N flows by calls, and the apps/APIs they reach.
  const view = useMemo(() => {
    if (!data) return null;
    const flows = top ? data.flows.slice(0, top) : data.flows;
    const flowIds = new Set(flows.map((f) => f.id));
    const links = data.links.filter((l) => flowIds.has(l.flow));
    const appIds = new Set(links.map((l) => l.app));
    const apiIds = new Set(links.map((l) => l.api));
    return {
      flows,
      apps: data.apps.filter((a) => appIds.has(a.id)),
      apis: data.apis.filter((a) => apiIds.has(a.id)),
      links,
    };
  }, [data, top]);

  const layout = useMemo(() => {
    if (!view || !view.links.length) return null;
    const nodes: NodeDatum[] = [
      ...view.flows.map((f) => ({ id: f.id, kind: 'flow' as const, label: f.name, flagged: !f.modeled, errors: f.errors, data: f })),
      ...view.apps.map((a) => ({ id: a.id, kind: 'app' as const, label: a.acronym, flagged: !a.catalogued, errors: a.errors, data: a })),
      ...view.apis.map((a) => ({ id: a.id, kind: 'api' as const, label: apiLabel(a), flagged: !a.inCatalog, errors: a.errors, data: a })),
    ];
    const linkMap = new Map<string, LinkDatum>();
    const add = (source: string, target: string, value: number, flow: string) => {
      const key = `${source}>${target}`;
      const entry = linkMap.get(key) || { source, target, value: 0, flows: new Set<string>() };
      entry.value += value;
      entry.flows.add(flow);
      linkMap.set(key, entry);
    };
    for (const l of view.links) {
      add(l.flow, l.app, l.calls, l.flow);
      add(l.app, l.api, l.calls, l.flow);
    }
    const rows = Math.max(view.flows.length, view.apps.length, view.apis.length);
    const height = Math.max(360, rows * 17 + 40);
    const generator = d3Sankey<NodeDatum, LinkDatum>()
      .nodeId((n) => n.id)
      .nodeWidth(10)
      .nodePadding(5)
      .extent([[LABEL_W, 10], [width - LABEL_W, height - 10]]);
    const graph = generator({ nodes: nodes.map((n) => ({ ...n })), links: [...linkMap.values()].map((l) => ({ ...l })) });
    return { ...graph, height };
  }, [view, width]);

  const activeFlow = pinnedFlow || hoverFlow;
  const linkActive = (l: SLink) => Boolean(activeFlow && l.flows.has(activeFlow));
  const nodeActive = (n: SNode) => {
    if (!activeFlow) return false;
    if (n.id === activeFlow) return true;
    return (n.sourceLinks || []).concat(n.targetLinks || []).some((l) => (l as SLink).flows.has(activeFlow));
  };

  const nodeTooltip = (n: SNode): React.ReactNode => {
    const d = n.data as any;
    const flag = n.kind === 'flow' ? (d.modeled ? null : 'Running in production, but no diagram in BPMN IQ')
      : n.kind === 'app' ? (d.catalogued ? null : 'Not in the Applications catalog')
        : (d.inCatalog ? null : 'Not in the API catalog');
    return (
      <div className="text-xs">
        <div className="font-semibold">{n.kind === 'api' ? `${d.apiId} · ${d.method} ${d.endpoint}` : n.kind === 'app' ? `${d.acronym}${d.name ? ` — ${d.name}` : ''}` : d.name}</div>
        {n.kind === 'flow' ? <div>{d.domain}{d.subdomain ? ` › ${d.subdomain}` : ''}</div> : null}
        {n.kind === 'app' && d.domain ? <div>{d.domain}</div> : null}
        {n.kind === 'api' && d.name ? <div>{d.name}</div> : null}
        <div>{d.calls.toLocaleString()} calls{d.errors ? ` · ${d.errors} errors` : ''}</div>
        {flag ? <div className="mt-1 text-amber-300">⚑ {flag}</div> : null}
      </div>
    );
  };

  const flaggedCounts = data ? {
    flows: data.flows.filter((f) => !f.modeled).length,
    apps: data.apps.filter((a) => !a.catalogued).length,
    apis: data.apis.filter((a) => !a.inCatalog).length,
  } : null;
  const selectedFlow = data?.flows.find((f) => f.id === pinnedFlow) || null;
  const selectedRows = selectedFlow && data
    ? data.links.filter((l) => l.flow === selectedFlow.id).map((l) => ({
      key: `${l.app}|${l.api}`,
      app: data.apps.find((a) => a.id === l.app),
      api: data.apis.find((a) => a.id === l.api),
      calls: l.calls,
      errors: l.errors,
    })).sort((a, b) => b.calls - a.calls)
    : [];

  return (
    <div className="h-full overflow-y-auto bg-slate-50 p-4">
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <div className="text-base font-semibold text-slate-800">Live lineage: flows → applications → APIs</div>
        <Tooltip title={`${data?.note || ''} Source: ${data?.source || 'Prometheus'}.`} overlayStyle={{ maxWidth: 380 }}>
          <InfoCircleOutlined className="text-slate-400" />
        </Tooltip>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <Segmented size="small" value={minutes} options={WINDOWS} onChange={(v) => setMinutes(Number(v))} />
          <Select
            size="small"
            allowClear
            placeholder="All domains"
            className="min-w-[220px]"
            value={domain}
            onChange={(v) => setDomain(v)}
            options={(data?.domains || []).map((d) => ({ label: d, value: d }))}
          />
          <Select
            size="small"
            value={top}
            onChange={setTop}
            className="w-[130px]"
            options={TOP_OPTIONS.map((n) => ({ value: n, label: n ? `Top ${n} flows` : 'All flows' }))}
          />
          <span className="text-xs text-slate-500">Auto-refresh</span>
          <Switch size="small" checked={autoRefresh} onChange={setAutoRefresh} />
          <Button size="small" icon={<ReloadOutlined />} onClick={() => void load()} loading={loading}>Refresh</Button>
        </div>
      </div>

      {error ? <Alert type="error" showIcon message="Live lineage unavailable" description={error} className="mb-3" /> : null}
      <SnapshotNotice snapshot={data?.snapshot} />

      {data ? (
        <div className="mb-3 flex flex-wrap gap-2 text-xs">
          <Tag className="m-0">{data.flows.length} active flows</Tag>
          <Tag className="m-0">{data.apps.length} applications</Tag>
          <Tag className="m-0">{data.apis.length} APIs</Tag>
          <Tag className="m-0">{data.flows.reduce((n, f) => n + f.calls, 0).toLocaleString()} calls</Tag>
          {flaggedCounts && (flaggedCounts.flows || flaggedCounts.apps || flaggedCounts.apis) ? (
            <Tag color="warning" className="m-0">
              Not in BPMN IQ: {flaggedCounts.flows} flows · {flaggedCounts.apps} apps · {flaggedCounts.apis} APIs
            </Tag>
          ) : null}
          <span className="text-slate-500">
            Last {WINDOWS.find((w) => w.value === minutes)?.label}{top && data.flows.length > top ? ` · showing the ${top} busiest flows` : ''} · updated {new Date(data.generatedAt).toLocaleTimeString()}
          </span>
        </div>
      ) : null}

      <div ref={cardRef} className="relative rounded-lg border border-solid border-slate-200 bg-white p-2">
        <div className="mb-1 flex justify-between px-1 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
          <span>Business flow</span><span>Application (serves the API)</span><span>API</span>
        </div>
        {!data && loading ? <div className="flex h-64 items-center justify-center"><Spin /></div> : null}
        {data && !layout ? <Empty className="my-10" description="No API traffic in this window" /> : null}
        {layout ? (
          <svg width={width} height={layout.height} role="img" aria-label="Live lineage of business flows to applications to APIs" onMouseLeave={() => { setHoverFlow(null); setTooltip(null); }}>
            <g fill="none">
              {(layout.links as SLink[]).map((l, i) => {
                const active = linkActive(l);
                return (
                  <path
                    key={i}
                    d={sankeyLinkHorizontal()(l) || ''}
                    stroke={active ? COLOR.active : COLOR.link}
                    strokeOpacity={activeFlow ? (active ? 0.75 : 0.15) : 0.55}
                    strokeWidth={Math.max(1, l.width || 1)}
                  />
                );
              })}
            </g>
            {(layout.nodes as SNode[]).map((n) => {
              const x0 = n.x0 || 0; const x1 = n.x1 || 0; const y0 = n.y0 || 0; const y1 = n.y1 || 0;
              const active = nodeActive(n);
              const dim = Boolean(activeFlow) && !active;
              const leftSide = n.kind === 'flow';
              const fill = n.flagged ? COLOR.flagged : active ? COLOR.active : COLOR.node;
              const labelX = leftSide ? x0 - 6 : x1 + 6;
              return (
                <g
                  key={n.id}
                  opacity={dim ? 0.35 : 1}
                  className={n.kind === 'flow' ? 'cursor-pointer' : undefined}
                  onMouseEnter={(e) => {
                    if (n.kind === 'flow') setHoverFlow(n.id);
                    const box = cardRef.current?.getBoundingClientRect();
                    setTooltip({ x: e.clientX - (box?.left || 0) + 12, y: e.clientY - (box?.top || 0) + 12, content: nodeTooltip(n) });
                  }}
                  onMouseLeave={() => setTooltip(null)}
                  onClick={() => { if (n.kind === 'flow') setPinnedFlow((cur) => (cur === n.id ? null : n.id)); }}
                >
                  <rect x={x0} y={y0} width={Math.max(2, x1 - x0)} height={Math.max(2, y1 - y0)} fill={fill} rx={2} />
                  <rect x={leftSide ? 0 : x1} y={y0 - 2} width={leftSide ? x0 : LABEL_W} height={Math.max(14, y1 - y0 + 4)} fill="transparent" />
                  <text x={labelX} y={(y0 + y1) / 2} dy="0.35em" textAnchor={leftSide ? 'end' : 'start'} fontSize={11} fill={COLOR.ink} fontWeight={active ? 600 : 400}>
                    {n.flagged ? '⚑ ' : ''}{truncate(n.label, n.kind === 'flow' ? 34 : 32)}
                  </text>
                  {n.errors ? <circle cx={leftSide ? x0 - 3 : x1 + 3} cy={y0} r={3} fill={COLOR.error}><title>{n.errors} errors</title></circle> : null}
                </g>
              );
            })}
          </svg>
        ) : null}
        {tooltip ? (
          <div className="pointer-events-none absolute z-10 max-w-[380px] rounded-md bg-slate-900 px-3 py-2 text-white shadow-lg" style={{ left: tooltip.x, top: tooltip.y }}>
            {tooltip.content}
          </div>
        ) : null}
        <div className="mt-1 flex flex-wrap gap-4 px-1 text-[11px] text-slate-500">
          <span><span className="mr-1 inline-block h-2 w-2 rounded-sm" style={{ background: COLOR.node }} />Known to BPMN IQ</span>
          <span><span className="mr-1 inline-block h-2 w-2 rounded-sm" style={{ background: COLOR.flagged }} />⚑ Not in BPMN IQ (no diagram / not catalogued)</span>
          <span><span className="mr-1 inline-block h-2 w-2 rounded-full" style={{ background: COLOR.error }} />Errors in window</span>
          <span>Hover a flow to trace it; click to pin.</span>
        </div>
      </div>

      {selectedFlow ? (
        <div className="mt-3 rounded-lg border border-solid border-slate-200 bg-white p-3">
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <span className="font-semibold text-slate-800">{selectedFlow.name}</span>
            <span className="text-xs text-slate-500">{selectedFlow.domain}{selectedFlow.subdomain ? ` › ${selectedFlow.subdomain}` : ''}</span>
            {!selectedFlow.modeled ? <Tag color="warning" className="m-0">⚑ No diagram in BPMN IQ</Tag> : null}
            <span className="ml-auto" />
            {selectedFlow.modeled && onOpenBusinessFlows ? (
              <Button size="small" type="primary" onClick={() => onOpenBusinessFlows([selectedFlow.name], selectedFlow.name)}>Open in Business Processes</Button>
            ) : null}
            <Button size="small" onClick={() => setPinnedFlow(null)}>Clear</Button>
          </div>
          <Table
            size="small"
            pagination={false}
            dataSource={selectedRows}
            columns={[
              { title: 'Application', render: (_, r) => <span>{r.app?.acronym}{r.app && !r.app.catalogued ? <Tag color="warning" className="ml-1">not catalogued</Tag> : null}</span> },
              { title: 'API', render: (_, r) => <span className="font-mono text-xs">{r.api?.apiId}</span> },
              { title: 'Endpoint', render: (_, r) => <span className="text-xs">{r.api?.method} {r.api?.endpoint}{r.api && !r.api.inCatalog ? <Tag color="warning" className="ml-1">not in catalog</Tag> : null}</span> },
              { title: 'Calls', dataIndex: 'calls', align: 'right' as const, width: 80 },
              { title: 'Errors', dataIndex: 'errors', align: 'right' as const, width: 80, render: (v: number) => (v ? <span className="text-red-600">{v}</span> : 0) },
            ]}
          />
        </div>
      ) : null}
    </div>
  );
}
