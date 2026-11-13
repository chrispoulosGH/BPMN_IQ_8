import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type React from 'react';
import { Alert, Button, Empty, Select, Spin, Switch, Table, Tag, Tooltip } from 'antd';
import { ApartmentOutlined, InfoCircleOutlined, LockOutlined, ReloadOutlined } from '@ant-design/icons';
import * as d3 from 'd3';
import { sankey as d3Sankey, sankeyLinkHorizontal, type SankeyLink, type SankeyNode } from 'd3-sankey';
import { getIntegrationMap } from '../api';
import type { IntegrationMapApi, IntegrationMapApp, IntegrationMapDataObject, IntegrationMapLink, IntegrationMapResponse } from '../types';

/**
 * Integration Map: how applications exchange data through APIs.
 *
 *  - Overview: hierarchical edge bundling. Apps sit on a circle grouped into
 *    domain arcs; each provider→consumer pair is one bundled curve, width =
 *    API count. Hover an app to see what it provides (orange) and consumes
 *    (blue); click to drill down.
 *  - Drill-down: a left-to-right flow for the selected app —
 *    apps that send to it → the app → its (derived) host servers → apps it sends to.
 *  - API table for whatever is selected, with a jump to the business flows.
 *
 * Palette (validated with the dataviz validator, light surface): provides
 * #ea580c, consumes #2563eb, host #7c3aed. The 23 domains are NOT given
 * categorical hues (far beyond a usable palette); arcs alternate neutrals and
 * carry their name as a label.
 */

const COLOR = {
  provides: '#ea580c',
  consumes: '#2563eb',
  host: '#7c3aed',
  app: '#0f172a',
  edge: '#94a3b8',
  ink: '#0f172a',
  inkMuted: '#64748b',
  arcA: '#cbd5e1',
  arcB: '#e2e8f0',
  surface: '#ffffff',
};

interface IntegrationMapProps {
  /** Opens the Diagrams tab filtered to these business flows (LLM AMI). */
  onOpenBusinessFlows?: (businessFlows: string[], label: string) => void;
}

interface HierarchyDatum {
  name: string;
  app?: IntegrationMapApp;
  children?: HierarchyDatum[];
}

type TooltipState = { x: number; y: number; content: React.ReactNode } | null;

/** What the API table is showing. */
type ApiSelection =
  | { kind: 'app'; appId: string }
  | { kind: 'link'; source: string; target: string; host?: string };

const truncate = (value: string, max: number) => (value.length > max ? `${value.slice(0, max - 1)}…` : value);

/** A data object chip; hover lists its fields with required/PII/financial flags. */
export function DataObjectTag({ object, count, systemOfRecord }: { object?: IntegrationMapDataObject; count?: number; systemOfRecord?: string }) {
  if (!object) return <span className="text-slate-400">—</span>;
  return (
    <Tooltip
      overlayStyle={{ maxWidth: 380 }}
      title={(
        <div className="text-xs">
          <div className="font-semibold">{object.name} <span className="font-normal opacity-80">· {object.category} · {object.sensitivity}</span></div>
          {systemOfRecord ? <div className="opacity-80">System of record: {systemOfRecord}</div> : null}
          <div className="mt-1">
            {object.fields.map((field) => (
              <div key={field.name}>
                {field.name}<span className="opacity-70">: {field.type}</span>
                {field.required ? ' *' : ''}
                {field.restricted ? ' · restricted' : field.pii ? ' · PII' : ''}
                {field.financial ? ' · financial' : ''}
              </div>
            ))}
          </div>
          <div className="mt-1 opacity-70">* required · generated, illustrative</div>
        </div>
      )}
    >
      <Tag className="m-0 cursor-help">
        {object.containsPii ? <LockOutlined className="mr-1 text-slate-500" aria-label="contains personal data" /> : null}
        {object.name}{typeof count === 'number' ? <span className="ml-1 text-slate-500">{count}</span> : null}
      </Tag>
    </Tooltip>
  );
}

export default function IntegrationMap({ onOpenBusinessFlows }: IntegrationMapProps) {
  const [data, setData] = useState<IntegrationMapResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showUnconnected, setShowUnconnected] = useState(false);
  const [hoveredAppId, setHoveredAppId] = useState<string | null>(null);
  const [hoveredLinkKey, setHoveredLinkKey] = useState<string | null>(null);
  const [selectedAppId, setSelectedAppId] = useState<string | null>(null);
  const [apiSelection, setApiSelection] = useState<ApiSelection | null>(null);
  const [tooltip, setTooltip] = useState<TooltipState>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  // The flow is laid out at the card's real pixel width, so 12px text stays 12px.
  const flowCardRef = useRef<HTMLDivElement>(null);
  const [flowWidth, setFlowWidth] = useState(1100);
  useEffect(() => {
    const element = flowCardRef.current;
    if (!element || typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(([entry]) => {
      const next = Math.max(640, Math.floor(entry.contentRect.width));
      setFlowWidth((current) => (Math.abs(current - next) > 4 ? next : current));
    });
    observer.observe(element);
    return () => observer.disconnect();
  });

  const load = useCallback(async (fresh = false) => {
    setLoading(true);
    setError(null);
    try {
      setData(await getIntegrationMap(fresh));
    } catch (err: any) {
      setError(err?.response?.data?.error || err?.message || 'Failed to load the integration map.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const appsById = useMemo(() => new Map((data?.apps || []).map((app) => [app.id, app])), [data]);
  const linkKey = (link: { source: string; target: string }) => `${link.source}>${link.target}`;

  const connectedIds = useMemo(() => {
    const ids = new Set<string>();
    for (const link of data?.links || []) { ids.add(link.source); ids.add(link.target); }
    return ids;
  }, [data]);

  const visibleApps = useMemo(
    () => (data?.apps || []).filter((app) => showUnconnected || connectedIds.has(app.id)),
    [data, showUnconnected, connectedIds],
  );

  const kpis = useMemo(() => {
    const links = data?.links || [];
    const apiCount = links.reduce((sum, link) => sum + link.count, 0);
    const crossDomain = links.reduce((sum, link) => (
      appsById.get(link.source)?.domain !== appsById.get(link.target)?.domain ? sum + link.count : sum
    ), 0);
    return {
      connectedApps: connectedIds.size,
      pairs: links.length,
      apiCount,
      crossDomainPct: apiCount ? Math.round((crossDomain / apiCount) * 100) : 0,
    };
  }, [data, appsById, connectedIds]);

  // ── Radial layout ────────────────────────────────────────────────────────
  const radial = useMemo(() => {
    if (!visibleApps.length) return null;
    const byDomain = d3.group(visibleApps, (app) => app.domain);
    const domains = [...byDomain.keys()].sort((a, b) => a.localeCompare(b));
    const root = d3.hierarchy<HierarchyDatum>({
      name: 'root',
      children: domains.map((domain) => ({
        name: domain,
        children: (byDomain.get(domain) || [])
          .slice()
          .sort((a, b) => a.acronym.localeCompare(b.acronym))
          .map((app) => ({ name: app.id, app })),
      })),
    });

    const innerRadius = visibleApps.length > 60 ? 260 : 220;
    const longestLabel = d3.max(visibleApps, (app) => app.acronym.length) || 10;
    const labelSpace = Math.min(120, longestLabel * 6.4 + 16);
    const arcInner = innerRadius + labelSpace;
    const arcOuter = arcInner + 6;
    const domainLabelRadius = arcOuter + 8;
    const outer = domainLabelRadius + 150;

    const laidOut = d3.cluster<HierarchyDatum>()
      .size([2 * Math.PI, innerRadius])
      .separation((a, b) => (a.parent === b.parent ? 1 : 2.2))(root);
    const leaves = laidOut.leaves();
    const leafById = new Map(leaves.map((leaf) => [leaf.data.name, leaf]));
    const step = leaves.length > 1 ? (2 * Math.PI) / (leaves.length * 1.3) : 0.2;

    const line = d3.lineRadial<d3.HierarchyPointNode<HierarchyDatum>>()
      .curve(d3.curveBundle.beta(0.85))
      .radius((node) => node.y)
      .angle((node) => node.x);

    const maxCount = d3.max(data?.links || [], (link) => link.count) || 1;
    const width = d3.scaleSqrt().domain([1, maxCount]).range([1, 6]);

    const edges = (data?.links || [])
      .filter((link) => leafById.has(link.source) && leafById.has(link.target))
      .map((link) => {
        const source = leafById.get(link.source)!;
        const target = leafById.get(link.target)!;
        return { link, d: line(source.path(target)) || '', strokeWidth: width(link.count) };
      })
      // Thin edges first so heavy ones stay on top.
      .sort((a, b) => a.link.count - b.link.count);

    const arc = d3.arc<{ startAngle: number; endAngle: number }>()
      .innerRadius(arcInner)
      .outerRadius(arcOuter);
    const domainArcs = (laidOut.children || []).map((domainNode, index) => {
      const angles = domainNode.leaves().map((leaf) => leaf.x);
      const start = (d3.min(angles) || 0) - step / 2;
      const end = (d3.max(angles) || 0) + step / 2;
      return {
        domain: domainNode.data.name,
        d: arc({ startAngle: start, endAngle: end }) || '',
        mid: (start + end) / 2,
        fill: index % 2 ? COLOR.arcB : COLOR.arcA,
        appCount: angles.length,
      };
    });

    return { leaves, edges, domainArcs, innerRadius, domainLabelRadius, outer };
  }, [visibleApps, data]);

  const focusAppId = hoveredAppId || selectedAppId;
  const partnerRoles = useMemo(() => {
    const roles = new Map<string, { downstream: boolean; upstream: boolean }>();
    if (!focusAppId) return roles;
    for (const link of data?.links || []) {
      if (link.source === focusAppId) roles.set(link.target, { ...(roles.get(link.target) || { upstream: false, downstream: false }), downstream: true });
      if (link.target === focusAppId) roles.set(link.source, { ...(roles.get(link.source) || { upstream: false, downstream: false }), upstream: true });
    }
    return roles;
  }, [focusAppId, data]);

  const showTooltip = (event: React.MouseEvent, content: React.ReactNode) => {
    const box = containerRef.current?.getBoundingClientRect();
    if (!box) return;
    setTooltip({ x: event.clientX - box.left + 14, y: event.clientY - box.top + 14, content });
  };

  const selectApp = (appId: string | null) => {
    setSelectedAppId(appId);
    setApiSelection(appId ? { kind: 'app', appId } : null);
  };

  // ── Selected-app summary ────────────────────────────────────────────────
  const selectedApp = selectedAppId ? appsById.get(selectedAppId) || null : null;
  const selectedSummary = useMemo(() => {
    if (!selectedAppId || !data) return null;
    const outgoing = data.links.filter((link) => link.source === selectedAppId).sort((a, b) => b.count - a.count);
    const incoming = data.links.filter((link) => link.target === selectedAppId).sort((a, b) => b.count - a.count);
    return { outgoing, incoming };
  }, [selectedAppId, data]);

  // Data objects on any of the selected app's links, most frequent first.
  const exchangedObjects = useMemo(() => {
    if (!selectedSummary) return [] as Array<[string, number]>;
    const counts = new Map<string, number>();
    for (const link of [...selectedSummary.outgoing, ...selectedSummary.incoming]) {
      for (const d of link.dataObjects) counts.set(d.id, (counts.get(d.id) || 0) + d.count);
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1]);
  }, [selectedSummary]);

  const mostConnected = useMemo(() => {
    const degree = new Map<string, number>();
    for (const link of data?.links || []) {
      degree.set(link.source, (degree.get(link.source) || 0) + 1);
      degree.set(link.target, (degree.get(link.target) || 0) + 1);
    }
    return [...degree.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
  }, [data]);

  // ── Drill-down flow (Sankey) for the selected app ───────────────────────
  const flow = useMemo(() => {
    if (!selectedAppId || !selectedSummary || !data) return null;
    const { outgoing, incoming } = selectedSummary;
    if (!outgoing.length && !incoming.length) return null;

    type FlowNode = { id: string; label: string; kind: 'in' | 'app' | 'host' | 'out'; col: number; appId?: string; hostId?: string };
    type FlowLink = { source: string; target: string; value: number; sel: ApiSelection };
    const nodes = new Map<string, FlowNode>();
    const links: FlowLink[] = [];
    const add = (node: FlowNode) => { if (!nodes.has(node.id)) nodes.set(node.id, node); };

    const appNode = `app:${selectedAppId}`;
    add({ id: appNode, label: appsById.get(selectedAppId)?.acronym || selectedAppId, kind: 'app', col: 1, appId: selectedAppId });

    for (const link of incoming) {
      const id = `in:${link.source}`;
      add({ id, label: appsById.get(link.source)?.acronym || link.source, kind: 'in', col: 0, appId: link.source });
      links.push({ source: id, target: appNode, value: link.count, sel: { kind: 'link', source: link.source, target: link.target } });
    }

    const appToHost = new Map<string, number>();
    const hostToOut = new Map<string, number>();
    for (const link of outgoing) {
      add({ id: `out:${link.target}`, label: appsById.get(link.target)?.acronym || link.target, kind: 'out', col: 3, appId: link.target });
      for (const api of link.apis) {
        const host = api.host || 'unassigned';
        add({ id: `host:${host}`, label: data.hosts[host]?.name || (host === 'unassigned' ? 'No host' : host), kind: 'host', col: 2, hostId: host });
        appToHost.set(host, (appToHost.get(host) || 0) + 1);
        const key = `${host}|${link.target}`;
        hostToOut.set(key, (hostToOut.get(key) || 0) + 1);
      }
    }
    for (const [host, value] of appToHost) {
      links.push({ source: appNode, target: `host:${host}`, value, sel: { kind: 'link', source: selectedAppId, target: '*', host } });
    }
    for (const [key, value] of hostToOut) {
      const [host, target] = key.split('|');
      links.push({ source: `host:${host}`, target: `out:${target}`, value, sel: { kind: 'link', source: selectedAppId, target, host } });
    }

    const nodeList = [...nodes.values()];
    const minCol = d3.min(nodeList, (node) => node.col) || 0;
    const width = flowWidth;
    const height = Math.max(260, Math.max(incoming.length, outgoing.length, appToHost.size) * 26 + 40);

    const layout = d3Sankey<FlowNode, FlowLink>()
      .nodeId((node) => node.id)
      .nodeAlign((node) => node.col - minCol)
      .nodeWidth(14)
      .nodePadding(10)
      .nodeSort(null as unknown as (a: SankeyNode<FlowNode, FlowLink>, b: SankeyNode<FlowNode, FlowLink>) => number) // keep insertion order (largest partner first)
      .extent([[1, 8], [width - 1, height - 8]]);

    const graph = layout({
      nodes: nodeList.map((node) => ({ ...node })),
      links: links.map((link) => ({ ...link })),
    });
    return { graph, width, height };
  }, [selectedAppId, selectedSummary, data, appsById, flowWidth]);

  // ── API table ───────────────────────────────────────────────────────────
  const tableApis = useMemo(() => {
    if (!apiSelection || !data) return { title: '', rows: [] as Array<IntegrationMapApi & { provider: string; consumer: string }> };
    const withEnds = (link: IntegrationMapLink) => link.apis.map((api) => ({ ...api, provider: link.source, consumer: link.target }));
    const name = (id: string) => appsById.get(id)?.acronym || id;
    if (apiSelection.kind === 'app') {
      const rows = data.links
        .filter((link) => link.source === apiSelection.appId || link.target === apiSelection.appId)
        .flatMap(withEnds);
      return { title: `All cross-application APIs for ${name(apiSelection.appId)}`, rows };
    }
    const { source, target, host } = apiSelection;
    const rows = data.links
      .filter((link) => link.source === source && (target === '*' || link.target === target))
      .flatMap(withEnds)
      .filter((api) => !host || (api.host || 'unassigned') === host);
    const hostLabel = host ? ` via ${data.hosts[host]?.name || host}` : '';
    return { title: `${name(source)} → ${target === '*' ? 'all consumers' : name(target)}${hostLabel}`, rows };
  }, [apiSelection, data, appsById]);

  const tableFlows = useMemo(
    () => Array.from(new Set(tableApis.rows.map((api) => api.businessFlow).filter(Boolean))).sort(),
    [tableApis],
  );

  if (loading && !data) {
    return <div className="flex h-full items-center justify-center"><Spin tip="Loading integration map…" /></div>;
  }

  return (
    <div className="h-full w-full overflow-y-auto bg-slate-50 p-5">
      <div ref={containerRef} className="relative mx-auto flex max-w-[1600px] flex-col gap-4">
        {/* Header + KPIs + controls (one row, above the charts) */}
        <div className="flex flex-wrap items-center gap-3 rounded-lg border border-solid border-slate-200 bg-white px-4 py-3">
          <div className="mr-2 flex items-center gap-2">
            <ApartmentOutlined className="text-blue-700" />
            <span className="text-base font-semibold text-slate-800">Integration Map</span>
          </div>
          {[
            { label: 'Connected apps', value: kpis.connectedApps },
            { label: 'App pairs', value: kpis.pairs },
            { label: 'Cross-app APIs', value: kpis.apiCount },
            { label: 'Cross-domain', value: `${kpis.crossDomainPct}%` },
          ].map((kpi) => (
            <div key={kpi.label} className="rounded-md bg-slate-50 px-3 py-1">
              <div className="text-[11px] text-slate-500">{kpi.label}</div>
              <div className="text-base font-semibold text-slate-800">{kpi.value}</div>
            </div>
          ))}
          <div className="ml-auto flex flex-wrap items-center gap-3">
            <Select
              showSearch
              allowClear
              placeholder="Find an application…"
              style={{ width: 280 }}
              value={selectedAppId || undefined}
              onChange={(value) => selectApp(value || null)}
              optionFilterProp="label"
              options={(data?.apps || []).map((app) => ({
                value: app.id,
                label: `${app.acronym} · ${app.name}`,
                disabled: !connectedIds.has(app.id),
              }))}
            />
            <span className="flex items-center gap-2 text-xs text-slate-600">
              <Switch size="small" checked={showUnconnected} onChange={setShowUnconnected} />
              Apps without cross-app APIs
            </span>
            <Tooltip title="Rebuild from the database">
              <Button size="small" icon={<ReloadOutlined />} onClick={() => void load(true)} loading={loading} />
            </Tooltip>
          </div>
        </div>

        {error ? <Alert type="error" showIcon message={error} /> : null}

        <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_360px]">
          {/* Overview */}
          <div className="rounded-lg border border-solid border-slate-200 bg-white p-3">
            <div className="flex flex-wrap items-center gap-4 px-1 pb-2 text-xs text-slate-600">
              <span className="font-semibold text-slate-700">Application network by domain</span>
              <span className="flex items-center gap-1.5"><span className="inline-block h-0.5 w-5 rounded" style={{ background: COLOR.provides }} />Provides (outgoing)</span>
              <span className="flex items-center gap-1.5"><span className="inline-block h-0.5 w-5 rounded" style={{ background: COLOR.consumes }} />Consumes (incoming)</span>
              <span>Line width = number of APIs · hover an app, click to drill down</span>
            </div>
            {radial ? (
              <svg
                viewBox={`${-radial.outer} ${-radial.outer} ${radial.outer * 2} ${radial.outer * 2}`}
                className="mx-auto block w-full"
                style={{ maxHeight: 900 }}
                role="img"
                aria-label="Circular application integration network grouped by business domain"
                onMouseLeave={() => { setHoveredAppId(null); setHoveredLinkKey(null); setTooltip(null); }}
              >
                {radial.domainArcs.map((arc) => {
                  const angleDeg = (arc.mid * 180) / Math.PI - 90;
                  const flip = arc.mid >= Math.PI;
                  return (
                    <g key={arc.domain}>
                      <path d={arc.d} fill={arc.fill} />
                      <text
                        transform={`rotate(${angleDeg}) translate(${radial.domainLabelRadius},0)${flip ? ' rotate(180)' : ''}`}
                        textAnchor={flip ? 'end' : 'start'}
                        dy="0.32em"
                        fontSize={10.5}
                        fontWeight={600}
                        fill={COLOR.inkMuted}
                        style={{ textTransform: 'uppercase', letterSpacing: '0.04em' }}
                      >
                        <title>{`${arc.domain} · ${arc.appCount} app(s)`}</title>
                        {truncate(arc.domain, 26)}
                      </text>
                    </g>
                  );
                })}

                <g fill="none">
                  {radial.edges.map(({ link, d, strokeWidth }) => {
                    const key = linkKey(link);
                    const isOut = focusAppId && link.source === focusAppId;
                    const isIn = focusAppId && link.target === focusAppId;
                    const hovered = hoveredLinkKey === key;
                    const stroke = isOut ? COLOR.provides : isIn ? COLOR.consumes : COLOR.edge;
                    const opacity = hovered ? 1 : focusAppId ? (isOut || isIn ? 0.85 : 0.05) : 0.4;
                    return (
                      <g key={key}>
                        <path d={d} stroke={stroke} strokeOpacity={opacity} strokeWidth={hovered ? strokeWidth + 1.5 : strokeWidth} strokeLinecap="round" />
                        {/* Wider invisible hit target */}
                        <path
                          d={d}
                          stroke="transparent"
                          strokeWidth={Math.max(8, strokeWidth + 6)}
                          style={{ cursor: 'pointer' }}
                          onMouseEnter={(event) => {
                            setHoveredLinkKey(key);
                            showTooltip(event, (
                              <>
                                <div className="font-semibold">{appsById.get(link.source)?.acronym} → {appsById.get(link.target)?.acronym}</div>
                                <div>{link.count} API{link.count === 1 ? '' : 's'} · {link.businessFlows.length} business flow{link.businessFlows.length === 1 ? '' : 's'}</div>
                                <div className="text-slate-500">{appsById.get(link.source)?.domain} → {appsById.get(link.target)?.domain}</div>
                                {link.dataObjects.length ? (
                                  <div className="mt-1">Carries: {link.dataObjects.slice(0, 4).map((d) => data?.dataObjects[d.id]?.name || d.id).join(', ')}{link.dataObjects.length > 4 ? ` +${link.dataObjects.length - 4}` : ''}</div>
                                ) : null}
                              </>
                            ));
                          }}
                          onMouseMove={(event) => setTooltip((current) => (current ? { ...current, x: event.clientX - (containerRef.current?.getBoundingClientRect().left || 0) + 14, y: event.clientY - (containerRef.current?.getBoundingClientRect().top || 0) + 14 } : current))}
                          onMouseLeave={() => { setHoveredLinkKey(null); setTooltip(null); }}
                          onClick={() => {
                            setSelectedAppId(link.source);
                            setApiSelection({ kind: 'link', source: link.source, target: link.target });
                          }}
                        />
                      </g>
                    );
                  })}
                </g>

                {radial.leaves.map((leaf) => {
                  const app = leaf.data.app!;
                  const angleDeg = (leaf.x * 180) / Math.PI - 90;
                  const flip = leaf.x >= Math.PI;
                  const role = partnerRoles.get(app.id);
                  const isFocus = app.id === focusAppId;
                  const isSelected = app.id === selectedAppId;
                  const dimmed = focusAppId && !isFocus && !role;
                  const connected = connectedIds.has(app.id);
                  const dotFill = isFocus ? COLOR.app : role?.downstream ? COLOR.provides : role?.upstream ? COLOR.consumes : connected ? COLOR.inkMuted : COLOR.surface;
                  return (
                    <g
                      key={app.id}
                      transform={`rotate(${angleDeg}) translate(${leaf.y},0)`}
                      style={{ cursor: connected ? 'pointer' : 'default' }}
                      opacity={dimmed ? 0.35 : 1}
                      onMouseEnter={(event) => {
                        if (!connected) return;
                        setHoveredAppId(app.id);
                        showTooltip(event, (
                          <>
                            <div className="font-semibold">{app.acronym}</div>
                            <div>{app.name}</div>
                            <div className="text-slate-500">{app.domain}</div>
                            <div className="mt-1">Provides {app.providedApiCount} · consumes {app.consumedApiCount} · internal {app.internalApiCount}</div>
                          </>
                        ));
                      }}
                      onMouseLeave={() => { setHoveredAppId(null); setTooltip(null); }}
                      onClick={() => connected && selectApp(app.id)}
                    >
                      <circle
                        r={isSelected ? 5.5 : 3.5}
                        fill={dotFill}
                        stroke={role?.downstream && role?.upstream ? COLOR.consumes : connected ? COLOR.surface : COLOR.inkMuted}
                        strokeWidth={role?.downstream && role?.upstream ? 2 : 1}
                      />
                      <text
                        x={flip ? -8 : 8}
                        dy="0.32em"
                        transform={flip ? 'rotate(180)' : undefined}
                        textAnchor={flip ? 'end' : 'start'}
                        fontSize={11}
                        fontWeight={isFocus || isSelected ? 700 : role ? 600 : 400}
                        fill={connected ? COLOR.ink : COLOR.inkMuted}
                      >
                        {app.acronym}
                      </text>
                      {/* Hit target spanning the label */}
                      <rect
                        x={flip ? -130 : -6}
                        y={-7}
                        width={136}
                        height={14}
                        fill="transparent"
                        transform={flip ? 'rotate(180)' : undefined}
                      />
                    </g>
                  );
                })}
              </svg>
            ) : (
              <Empty description="No application integrations found" className="py-16" />
            )}
          </div>

          {/* Side panel */}
          <div className="flex flex-col gap-3 rounded-lg border border-solid border-slate-200 bg-white p-4 text-sm">
            {selectedApp && selectedSummary ? (
              <>
                <div>
                  <div className="text-xs uppercase tracking-wide text-slate-500">{selectedApp.domain}</div>
                  <div className="text-lg font-semibold text-slate-900">{selectedApp.acronym}</div>
                  <div className="text-slate-600">{selectedApp.name}</div>
                  {selectedApp.criticality ? <Tag className="mt-2">{selectedApp.criticality}</Tag> : null}
                </div>
                <div className="grid grid-cols-3 gap-2 text-center">
                  {[
                    { label: 'Provides', value: selectedApp.providedApiCount, color: COLOR.provides },
                    { label: 'Consumes', value: selectedApp.consumedApiCount, color: COLOR.consumes },
                    { label: 'Internal', value: selectedApp.internalApiCount, color: COLOR.inkMuted },
                  ].map((item) => (
                    <div key={item.label} className="rounded-md bg-slate-50 py-2">
                      <div className="flex items-center justify-center gap-1 text-[11px] text-slate-500">
                        <span className="inline-block h-2 w-2 rounded-full" style={{ background: item.color }} />{item.label}
                      </div>
                      <div className="text-base font-semibold text-slate-800">{item.value}</div>
                    </div>
                  ))}
                </div>
                {[
                  { title: `Sends to (${selectedSummary.outgoing.length})`, links: selectedSummary.outgoing, other: (link: IntegrationMapLink) => link.target, color: COLOR.provides },
                  { title: `Receives from (${selectedSummary.incoming.length})`, links: selectedSummary.incoming, other: (link: IntegrationMapLink) => link.source, color: COLOR.consumes },
                ].map((group) => (
                  <div key={group.title}>
                    <div className="mb-1 text-xs font-semibold text-slate-600">{group.title}</div>
                    {group.links.length ? (
                      <div className="flex max-h-48 flex-col overflow-y-auto">
                        {group.links.map((link) => {
                          const other = appsById.get(group.other(link));
                          return (
                            <button
                              key={linkKey(link)}
                              type="button"
                              className="flex items-center gap-2 rounded border-0 bg-transparent px-1.5 py-1 text-left hover:bg-slate-50"
                              onClick={() => setApiSelection({ kind: 'link', source: link.source, target: link.target })}
                            >
                              <span className="inline-block h-2 w-2 shrink-0 rounded-full" style={{ background: group.color }} />
                              <span className="font-medium text-slate-800">{other?.acronym}</span>
                              <span className="truncate text-xs text-slate-500">{other?.domain}</span>
                              <span className="ml-auto text-xs font-semibold text-slate-700">{link.count}</span>
                            </button>
                          );
                        })}
                      </div>
                    ) : <div className="text-xs text-slate-400">None</div>}
                  </div>
                ))}
                {exchangedObjects.length ? (
                  <div>
                    <div className="mb-1 text-xs font-semibold text-slate-600">
                      Data exchanged ({exchangedObjects.length})
                      <Tooltip title={data?.dataObjectNote}><InfoCircleOutlined className="ml-1 text-slate-400" /></Tooltip>
                    </div>
                    <div className="flex flex-wrap gap-1">
                      {exchangedObjects.slice(0, 12).map(([id, count]) => (
                        <DataObjectTag key={id} object={data?.dataObjects[id]} count={count} systemOfRecord={appsById.get(data?.dataObjects[id]?.systemOfRecord || '')?.acronym} />
                      ))}
                    </div>
                  </div>
                ) : null}
                <Button size="small" onClick={() => selectApp(null)}>Clear selection</Button>
              </>
            ) : (
              <>
                <div className="text-slate-600">
                  Hover an application to see who it sends data to and receives data from. Click one to drill down into its APIs and host servers.
                </div>
                <div>
                  <div className="mb-1 text-xs font-semibold text-slate-600">Most connected applications</div>
                  {mostConnected.map(([id, degree]) => {
                    const app = appsById.get(id);
                    return (
                      <button
                        key={id}
                        type="button"
                        className="flex w-full items-center gap-2 rounded border-0 bg-transparent px-1.5 py-1 text-left hover:bg-slate-50"
                        onClick={() => selectApp(id)}
                      >
                        <span className="font-medium text-slate-800">{app?.acronym}</span>
                        <span className="truncate text-xs text-slate-500">{app?.domain}</span>
                        <span className="ml-auto text-xs text-slate-600">{degree} partners</span>
                      </button>
                    );
                  })}
                </div>
                {data ? (
                  <div className="text-xs text-slate-500">
                    Not drawn: {data.internalApiCount} internal APIs (same app on both ends) and {data.unlinkedApiCount} APIs with no catalog provider or consumer.
                  </div>
                ) : null}
              </>
            )}
          </div>
        </div>

        {/* Drill-down flow */}
        {selectedApp && flow ? (
          <div className="rounded-lg border border-solid border-slate-200 bg-white p-3">
            <div className="flex flex-wrap items-center gap-4 px-1 pb-2 text-xs text-slate-600">
              <span className="font-semibold text-slate-700">{selectedApp.acronym}: data flow</span>
              <span className="flex items-center gap-1.5"><span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: COLOR.consumes }} />Sends to {selectedApp.acronym}</span>
              <span className="flex items-center gap-1.5"><span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: COLOR.host }} />Host server</span>
              <span className="flex items-center gap-1.5"><span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: COLOR.provides }} />Receives from {selectedApp.acronym}</span>
              <Tooltip title={data?.hostAssignmentNote}>
                <span className="flex items-center gap-1 text-slate-500"><InfoCircleOutlined /> Host servers are derived</span>
              </Tooltip>
            </div>
            <div ref={flowCardRef} className="w-full" />
            <svg viewBox={`0 0 ${flow.width} ${flow.height}`} width={flow.width} height={flow.height} className="block max-w-full" role="img" aria-label={`API data flow for ${selectedApp.acronym}`}>
              <g fill="none">
                {(flow.graph.links as Array<SankeyLink<any, any> & { sel: ApiSelection; value: number }>).map((link, index) => {
                  const source = link.source as SankeyNode<any, any> & { kind: string; label: string };
                  const target = link.target as SankeyNode<any, any> & { kind: string; label: string };
                  const stroke = source.kind === 'in' ? COLOR.consumes : COLOR.provides;
                  const key = `flow-${index}`;
                  const hovered = hoveredLinkKey === key;
                  return (
                    <path
                      key={key}
                      d={sankeyLinkHorizontal()(link as any) || ''}
                      stroke={stroke}
                      strokeOpacity={hovered ? 0.6 : 0.28}
                      strokeWidth={Math.max(1, link.width || 1)}
                      style={{ cursor: 'pointer' }}
                      onMouseEnter={(event) => {
                        setHoveredLinkKey(key);
                        showTooltip(event, (
                          <>
                            <div className="font-semibold">{source.label} → {target.label}</div>
                            <div>{link.value} API{link.value === 1 ? '' : 's'}</div>
                          </>
                        ));
                      }}
                      onMouseLeave={() => { setHoveredLinkKey(null); setTooltip(null); }}
                      onClick={() => setApiSelection(link.sel)}
                    />
                  );
                })}
              </g>
              {(flow.graph.nodes as Array<SankeyNode<any, any> & { id: string; kind: 'in' | 'app' | 'host' | 'out'; label: string; appId?: string; hostId?: string }>).map((node) => {
                const x0 = node.x0 || 0; const x1 = node.x1 || 0; const y0 = node.y0 || 0; const y1 = node.y1 || 0;
                const fill = node.kind === 'app' ? COLOR.app : node.kind === 'in' ? COLOR.consumes : node.kind === 'host' ? COLOR.host : COLOR.provides;
                const labelRight = node.kind !== 'out';
                const host = node.hostId ? data?.hosts[node.hostId] : undefined;
                return (
                  <g
                    key={node.id}
                    style={{ cursor: node.appId && node.kind !== 'app' ? 'pointer' : 'default' }}
                    onClick={() => { if (node.appId && node.kind !== 'app') selectApp(node.appId); }}
                    onMouseEnter={(event) => showTooltip(event, (
                      <>
                        <div className="font-semibold">{node.label}</div>
                        {node.appId ? <div>{appsById.get(node.appId)?.name}</div> : null}
                        {host ? <div>{host.role} · {host.city} ({host.datacenter})</div> : null}
                        <div>{node.value} API{node.value === 1 ? '' : 's'}</div>
                        {node.appId && node.kind !== 'app' ? <div className="text-slate-500">Click to focus this app</div> : null}
                      </>
                    ))}
                    onMouseLeave={() => setTooltip(null)}
                  >
                    <rect x={x0} y={y0} width={x1 - x0} height={Math.max(2, y1 - y0)} rx={2} fill={fill} />
                    <text
                      x={labelRight ? x1 + 6 : x0 - 6}
                      y={(y0 + y1) / 2}
                      dy="0.32em"
                      textAnchor={labelRight ? 'start' : 'end'}
                      fontSize={12}
                      fontWeight={node.kind === 'app' ? 700 : 500}
                      fill={COLOR.ink}
                    >
                      {truncate(node.label, 28)}
                      <tspan fill={COLOR.inkMuted} fontWeight={400}>{` ${node.value}`}</tspan>
                    </text>
                  </g>
                );
              })}
            </svg>
          </div>
        ) : null}

        {/* API table */}
        {apiSelection ? (
          <div className="rounded-lg border border-solid border-slate-200 bg-white p-3">
            <div className="mb-2 flex flex-wrap items-center gap-3 px-1">
              <span className="font-semibold text-slate-800">{tableApis.title}</span>
              <span className="text-xs text-slate-500">{tableApis.rows.length} API{tableApis.rows.length === 1 ? '' : 's'} · {tableFlows.length} business flow{tableFlows.length === 1 ? '' : 's'}</span>
              {onOpenBusinessFlows && tableFlows.length ? (
                <Button size="small" type="primary" className="ml-auto" onClick={() => onOpenBusinessFlows(tableFlows, tableApis.title)}>
                  Open {tableFlows.length} business flow{tableFlows.length === 1 ? '' : 's'} in Diagrams
                </Button>
              ) : null}
            </div>
            <Table
              size="small"
              rowKey={(row) => `${row.id}|${row.provider}|${row.consumer}`}
              dataSource={tableApis.rows}
              pagination={{ pageSize: 10, showSizeChanger: false }}
              scroll={{ x: 1300 }}
              columns={[
                { title: 'API', dataIndex: 'id', width: 100 },
                { title: 'Provider', dataIndex: 'provider', width: 130, render: (id: string) => appsById.get(id)?.acronym || id },
                { title: 'Consumer', dataIndex: 'consumer', width: 130, render: (id: string) => appsById.get(id)?.acronym || id },
                { title: 'Business flow', dataIndex: 'businessFlow', ellipsis: true },
                { title: 'Task', dataIndex: 'task', ellipsis: true },
                { title: 'Method', dataIndex: 'method', width: 80 },
                {
                  title: 'Request',
                  dataIndex: 'requestObject',
                  width: 190,
                  render: (id: string) => (id ? <DataObjectTag object={data?.dataObjects[id]} /> : <span className="text-xs text-slate-400">No body</span>),
                },
                {
                  title: 'Response',
                  dataIndex: 'responseObject',
                  width: 190,
                  render: (id: string) => <DataObjectTag object={data?.dataObjects[id]} />,
                },
                { title: 'Type', dataIndex: 'type', width: 150, ellipsis: true },
                {
                  title: 'Host server (derived)',
                  dataIndex: 'host',
                  width: 190,
                  render: (id: string) => {
                    const host = data?.hosts[id];
                    return host ? <Tooltip title={`${host.role} · ${host.city} · ${host.datacenter}`}>{host.name}</Tooltip> : (id || '—');
                  },
                },
              ]}
            />
          </div>
        ) : null}

        {tooltip ? (
          <div
            className="pointer-events-none absolute z-20 max-w-[320px] rounded-md border border-solid border-slate-200 bg-white px-3 py-2 text-xs text-slate-700 shadow-lg"
            style={{ left: tooltip.x, top: tooltip.y }}
          >
            {tooltip.content}
          </div>
        ) : null}
      </div>
    </div>
  );
}
