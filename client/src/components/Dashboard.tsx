import { Fragment, useState, useEffect, useMemo, useRef } from 'react';
import { Spin, Select, Segmented, Empty, Card, Row, Col, Statistic, Table, Tag, Button } from 'antd';
import { ReloadOutlined } from '@ant-design/icons';
import {
  BarChart,
  Bar,
  ScatterChart,
  Scatter,
  ZAxis,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
  RadarChart,
  Radar,
  PolarGrid,
  PolarAngleAxis,
  PolarRadiusAxis,
  PieChart,
  Pie,
  Cell,
} from 'recharts';
import { enhanceColumnsWithSortAndFilters } from '../utils/tableEnhancer';
import { getDashboardTaskRisk, getDashboardFlowRisk, getDashboardCostByYear, getDashboardCapabilityCostByYear, getDashboardCapabilityFlowRelationships, getDashboardFeatureCost3D, getBusinessFlowMap, getDiagram } from '../api';
import type { CapabilityCostByYearItem, CostByYearItem, TaskCostByYearItem, FeatureCostPoint } from '../api';
import FeatureCost3DChart from './FeatureCost3DChart';
import ServerLocationMap from './ServerLocationMap';
import BpmnMiniViewer from './BpmnMiniViewer';

// ─── Types ──────────────────────────────────────────────────
interface YNCount { yes: number; no: number; unknown: number }

interface TaskProfile {
  _id: string;
  name: string;
  businessFlow: string;
  product: string;
  domain?: string;
  channel?: string;
  actor?: string;
  appCount: number;
  criticality: Record<string, number>;
  lifecycle: Record<string, number>;
  applicationType: Record<string, number>;
  customerFacing: YNCount;
  internetFacing: YNCount;
  cpni: YNCount;
  handleSpi: YNCount;
  storeSpi: YNCount;
  pciData: YNCount;
  pciDataStored: YNCount;
  soxFsa: YNCount;
  serverVulnerabilities: number;
  dbVulnerabilities: number;
  riskScore: number;
}

interface FlowProfile {
  name: string;
  taskCount: number;
  appCount: number;
  uniqueApps: number;
  criticality: Record<string, number>;
  lifecycle: Record<string, number>;
  applicationType: Record<string, number>;
  customerFacing: YNCount;
  internetFacing: YNCount;
  cpni: YNCount;
  handleSpi: YNCount;
  storeSpi: YNCount;
  pciData: YNCount;
  pciDataStored: YNCount;
  soxFsa: YNCount;
  serverVulnerabilities: number;
  dbVulnerabilities: number;
  riskScore: number;
}

interface CapabilityFlowRelationshipLink {
  capability: string;
  businessFlow: string;
  count: number;
}

interface CapabilityFlowRelationshipData {
  totalDiagrams: number;
  diagramsWithCapabilities: number;
  capabilityCount: number;
  businessFlowCount: number;
  linkCount: number;
  capabilities: Array<{ name: string; count: number }>;
  businessFlows: Array<{ name: string; count: number }>;
  links: CapabilityFlowRelationshipLink[];
}

// ─── Constants ──────────────────────────────────────────────
const COMPLIANCE_FIELDS = ['cpni', 'handleSpi', 'storeSpi', 'pciData', 'pciDataStored', 'soxFsa', 'customerFacing', 'internetFacing'] as const;
const COMPLIANCE_LABELS: Record<string, string> = {
  cpni: 'CPNI',
  handleSpi: 'Handle SPI',
  storeSpi: 'Store SPI',
  pciData: 'PCI Data',
  pciDataStored: 'PCI Stored',
  soxFsa: 'SOX/FSA',
  customerFacing: 'Cust. Facing',
  internetFacing: 'Internet Facing',
};

const COLORS = ['#1890ff', '#52c41a', '#faad14', '#f5222d', '#722ed1', '#13c2c2', '#eb2f96', '#fa8c16', '#a0d911', '#2f54eb'];
const RISK_COLORS = { low: '#52c41a', medium: '#faad14', high: '#fa541c', critical: '#f5222d' };
// Business Flow Comparison's 3x3 grid — all 3 rows start at this height and
// all 3 columns start at an even split; the user can then drag any of the
// grid's 4 interior boundaries (2 vertical, 2 horizontal) to resize the
// cells on either side of it. CHART_HEIGHT_OFFSET is how much of a cell's
// height is taken up by the Card's own header/padding, left over for the
// chart itself.
const QUADRANT_HEIGHT = 360;
const CHART_HEIGHT_OFFSET = 100;
// Floors for the pairwise (col/row) and bottom-edge drags below — 0 lets a
// row or column be dragged all the way down to fully collapsed, which is
// how a specific row/column gets "maximized": collapse its siblings to 0
// and it naturally fills the rest of the grid. Drag the divider back out to
// restore it.
const MIN_QUADRANT_SIZE = 0;
const MIN_COL_WIDTH_PERCENT = 0;
const VULNERABILITY_LABELS: Record<string, string> = {
  serverVulnerabilities: 'Server Vulns',
  dbVulnerabilities: 'DB Vulns',
};

function riskLevel(score: number): { label: string; color: string } {
  if (score <= 5) return { label: 'Low', color: RISK_COLORS.low };
  if (score <= 15) return { label: 'Medium', color: RISK_COLORS.medium };
  if (score <= 30) return { label: 'High', color: RISK_COLORS.high };
  return { label: 'Critical', color: RISK_COLORS.critical };
}

function sortDescBy<T>(items: T[], selector: (item: T) => number): T[] {
  return [...items].sort((a, b) => selector(b) - selector(a));
}

function complianceYesTotal(item: Record<string, any>): number {
  return COMPLIANCE_FIELDS.reduce((sum, field) => sum + ((item[field] as YNCount)?.yes || 0), 0);
}

interface DashboardProps {
  // Framework this dashboard instance belongs to — needed to look up a
  // Business Process Flow's diagram by name (see onViewDiagramClick below).
  neighborhoodName?: string;
  // "View Diagram" link in the Business Process Flow Diagram quadrant —
  // same handler App.tsx already wires into ComponentsViewer/SearchAll's
  // own "View Diagram" links, so this jumps to the Diagrams tab with that
  // flow's diagram loaded exactly the same way those do.
  onViewDiagramClick?: (businessFlowName: string, neighborhoodName: string) => void;
}

// ─── Cross-mount data cache ────────────────────────────────
// The app's outer tab bar fully unmounts this component whenever the user
// switches away from the Analytics tab (destroyInactiveTabPane), so every
// revisit re-ran all 6 of the dashboard's parallel API calls from scratch —
// a visible loading spinner every single time. Cache the fetched result in
// module scope (survives the component unmounting; only cleared by a full
// page reload or the "Refresh" button below), keyed by neighborhoodName, so
// a revisit within DASHBOARD_CACHE_TTL_MS renders instantly from cache
// instead of waiting on the network again.
const DASHBOARD_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
interface DashboardCachedData {
  taskData: TaskProfile[];
  flowData: FlowProfile[];
  flowCostData: CostByYearItem[];
  taskCostData: TaskCostByYearItem[];
  capabilityCostData: CapabilityCostByYearItem[];
  capRelData: CapabilityFlowRelationshipData | null;
  featureCostPoints: FeatureCostPoint[];
  fetchedAt: number;
}
const dashboardDataCache = new Map<string, DashboardCachedData>();

// Which sub-view and which business flow (if any) was selected — kept
// separately from the fetched data above (no TTL; a user's place in the UI
// doesn't go "stale" the way fetched data does) so that leaving Analytics
// for another tab and coming back restores exactly where they left off:
// same sub-view, same flow selected, all 3 Business Flow Comparison frames
// populated with that flow's data again instead of resetting to empty.
interface DashboardSelectionState {
  view: 'flows' | 'featurecost3d' | 'servermap';
  featureCostFlowRequest: { flow: string; nonce: number } | null;
}
const dashboardSelectionCache = new Map<string, DashboardSelectionState>();

// Business Process Flow Diagram quadrant's own two DB round-trips — the
// flow-name→diagram-id map, and each diagram's own XML — cached the same
// way so re-selecting an already-seen flow (including via the selection
// restore above, after a remount) doesn't hit the database again either.
const DIAGRAM_LOOKUP_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
// Keyed by neighborhood (like dashboardDataCache above) so switching
// frameworks can't serve a stale flow→diagram map from a different one.
const businessFlowMapCache = new Map<string, { map: Record<string, string>; fetchedAt: number }>();
const diagramXmlCache = new Map<string, string>();
async function getCachedBusinessFlowMap(neighborhoodKey: string): Promise<Record<string, string>> {
  const cached = businessFlowMapCache.get(neighborhoodKey);
  if (cached && Date.now() - cached.fetchedAt < DIAGRAM_LOOKUP_CACHE_TTL_MS) return cached.map;
  const map = await getBusinessFlowMap();
  businessFlowMapCache.set(neighborhoodKey, { map, fetchedAt: Date.now() });
  return map;
}
async function getCachedDiagramXml(diagramId: string): Promise<string> {
  const cached = diagramXmlCache.get(diagramId);
  if (cached !== undefined) return cached;
  const diagram = await getDiagram(diagramId);
  diagramXmlCache.set(diagramId, diagram.xml);
  return diagram.xml;
}

// ─── Component ──────────────────────────────────────────────
export default function Dashboard({ neighborhoodName, onViewDiagramClick }: DashboardProps = {}) {
  const COST_YEAR = 2025;
  const cacheKey = neighborhoodName || '__default__';
  const freshCacheEntry = () => {
    const cached = dashboardDataCache.get(cacheKey);
    return cached && Date.now() - cached.fetchedAt < DASHBOARD_CACHE_TTL_MS ? cached : null;
  };
  const [taskData, setTaskData] = useState<TaskProfile[]>(() => freshCacheEntry()?.taskData || []);
  const [flowData, setFlowData] = useState<FlowProfile[]>(() => freshCacheEntry()?.flowData || []);
  const [loading, setLoading] = useState(() => !freshCacheEntry());
  const [view, setView] = useState<'flows' | 'featurecost3d' | 'servermap'>(() => dashboardSelectionCache.get(cacheKey)?.view || 'flows');
  const [selectedFlow, setSelectedFlow] = useState<string | null>(null);
  const [flowCostData, setFlowCostData] = useState<CostByYearItem[]>(() => freshCacheEntry()?.flowCostData || []);
  const [taskCostData, setTaskCostData] = useState<TaskCostByYearItem[]>(() => freshCacheEntry()?.taskCostData || []);
  const [capabilityCostData, setCapabilityCostData] = useState<CapabilityCostByYearItem[]>(() => freshCacheEntry()?.capabilityCostData || []);
  const [capRelData, setCapRelData] = useState<CapabilityFlowRelationshipData | null>(() => freshCacheEntry()?.capRelData || null);
  // Same underlying ApplicationFeatureDevCost data the YoY Feature Cost 3D
  // chart uses — reused here so the flow-comparison dashboard's top-flows
  // chart is driven by the same dev-cost source, not the older op/dev cost
  // seed data.
  const [featureCostPoints, setFeatureCostPoints] = useState<FeatureCostPoint[]>(() => freshCacheEntry()?.featureCostPoints || []);
  // Set when a bar in the Business Flow Comparison dev-cost chart is
  // clicked — jumps to the YoY Feature Cost view with that flow selected.
  // The nonce forces re-application even when the same flow is clicked
  // twice in a row (e.g. after the user manually cleared the selection).
  // Restored from dashboardSelectionCache on mount so revisiting Analytics
  // after switching tabs doesn't lose the selected flow.
  const [featureCostFlowRequest, setFeatureCostFlowRequest] = useState<{ flow: string; nonce: number } | null>(() => dashboardSelectionCache.get(cacheKey)?.featureCostFlowRequest || null);

  // Keep the cache in sync with whatever the user last selected, so the next
  // mount (after navigating away and back) can restore it.
  useEffect(() => {
    dashboardSelectionCache.set(cacheKey, { view, featureCostFlowRequest });
  }, [cacheKey, view, featureCostFlowRequest]);

  // Stays on the Business Flow Comparison screen — just updates the YoY
  // Feature Cost chart embedded in its top-right quadrant, rather than
  // navigating away to the standalone YoY Feature Cost view.
  const handleFlowCostBarClick = (flowName: string) => {
    setFeatureCostFlowRequest({ flow: flowName, nonce: Date.now() });
  };

  // force=true bypasses the cache (used by the "Refresh" button below) —
  // otherwise a still-fresh cache entry is served immediately and no
  // network request is made at all.
  const loadDashboardData = (force = false) => {
    if (!force) {
      const cached = freshCacheEntry();
      if (cached) {
        setTaskData(cached.taskData);
        setFlowData(cached.flowData);
        setFlowCostData(cached.flowCostData);
        setTaskCostData(cached.taskCostData);
        setCapabilityCostData(cached.capabilityCostData);
        setCapRelData(cached.capRelData);
        setFeatureCostPoints(cached.featureCostPoints);
        setLoading(false);
        return;
      }
    }

    setLoading(true);
    Promise.all([
      getDashboardTaskRisk(),
      getDashboardFlowRisk(),
      getDashboardCostByYear(COST_YEAR),
      getDashboardCapabilityCostByYear(COST_YEAR),
      getDashboardCapabilityFlowRelationships(),
      getDashboardFeatureCost3D(),
    ])
      .then(([tasks, flows, cost, capabilityCost, caprels, featureCost]) => {
        setTaskData(tasks);
        setFlowData(flows);
        setFlowCostData(cost.flows);
        setTaskCostData(cost.tasks);
        setCapabilityCostData(capabilityCost.capabilities);
        setCapRelData(caprels);
        setFeatureCostPoints(featureCost.points);
        dashboardDataCache.set(cacheKey, {
          taskData: tasks,
          flowData: flows,
          flowCostData: cost.flows,
          taskCostData: cost.tasks,
          capabilityCostData: capabilityCost.capabilities,
          capRelData: caprels,
          featureCostPoints: featureCost.points,
          fetchedAt: Date.now(),
        });
      })
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    loadDashboardData();
    // Only re-run when the underlying framework actually changes — a fresh
    // cache hit above already short-circuits the common "revisited the same
    // tab" case without needing this effect to re-fire at all.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cacheKey]);

  const flowNames = useMemo(() => [...new Set(taskData.map((t) => t.businessFlow))].sort(), [taskData]);

  const filteredTasks = useMemo(() => {
    if (!selectedFlow) return taskData;
    return taskData.filter((t) => t.businessFlow === selectedFlow);
  }, [taskData, selectedFlow]);

  if (loading) return <div style={{ padding: 48, textAlign: 'center' }}><Spin size="large" /></div>;

  return (
    <div style={{ padding: 16, height: '100%', overflow: 'auto' }}>
      {/* Header controls */}
      <div style={{ display: 'flex', gap: 16, alignItems: 'center', marginBottom: 16, flexWrap: 'wrap' }}>
        <Segmented
          value={view}
          onChange={(v) => setView(v as 'flows' | 'featurecost3d' | 'servermap')}
          options={[
            { label: 'Business Flow Comparison', value: 'flows' },
            { label: 'YoY Feature Cost', value: 'featurecost3d' },
            { label: 'US Server Map', value: 'servermap' },
          ]}
        />
        <Button
          size="small"
          icon={<ReloadOutlined />}
          onClick={() => loadDashboardData(true)}
          title="Refresh dashboard data (cached data is reused automatically for a few minutes on revisit)"
        >
          Refresh
        </Button>
      </div>

      {view === 'servermap' ? (
        <ServerLocationMap />
      ) : view === 'flows' ? (
        <FlowDashboard flows={flowData} costData={flowCostData} costYear={COST_YEAR} devCostPoints={featureCostPoints} onFlowCostBarClick={handleFlowCostBarClick} featureCostFlowRequest={featureCostFlowRequest} onViewFullFeatureCost={() => setView('featurecost3d')} neighborhoodName={neighborhoodName} onViewDiagramClick={onViewDiagramClick} />
      ) : (
        <FeatureCost3DChart requestedFlow={featureCostFlowRequest} />
      )}
    </div>
  );
}

function CapabilityFlowRelationshipDashboard({ data, costData, costYear }: { data: CapabilityFlowRelationshipData | null; costData: CapabilityCostByYearItem[]; costYear: number }) {
  const [capLimit, setCapLimit] = useState<number>(20);
  const [flowLimit, setFlowLimit] = useState<number>(20);
  const fmtM = (n: number) => '$' + (n / 1_000_000).toFixed(1) + 'M';
  const relationshipLinks = data?.links || [];
  const hasRelationshipData = relationshipLinks.length > 0;

  const capabilityCostBarData = costData.map((capability) => ({
    name: capability.name.length > 28 ? capability.name.slice(0, 25) + '...' : capability.name,
    fullName: capability.name,
    opCost: capability.opCost,
    devCost: capability.devCost,
    totalCost: capability.totalCost,
    flowCount: capability.flowCount,
  }));

  const linkMap = useMemo(() => {
    const map = new Map<string, number>();
    for (const l of relationshipLinks) {
      map.set(`${l.capability}|||${l.businessFlow}`, l.count);
    }
    return map;
  }, [relationshipLinks]);

  const capabilitySummary = useMemo(() => {
    const byCapability = new Map<string, { flowSet: Set<string>; totalStrength: number; maxStrength: number }>();
    for (const l of relationshipLinks) {
      if (!byCapability.has(l.capability)) {
        byCapability.set(l.capability, { flowSet: new Set(), totalStrength: 0, maxStrength: 0 });
      }
      const row = byCapability.get(l.capability)!;
      row.flowSet.add(l.businessFlow);
      row.totalStrength += l.count;
      row.maxStrength = Math.max(row.maxStrength, l.count);
    }

    return [...byCapability.entries()]
      .map(([name, agg]) => ({
        name,
        flowCount: agg.flowSet.size,
        totalStrength: agg.totalStrength,
        maxStrength: agg.maxStrength,
      }))
      .sort((a, b) => {
        if (b.flowCount !== a.flowCount) return b.flowCount - a.flowCount;
        return b.totalStrength - a.totalStrength;
      });
  }, [relationshipLinks]);

  const selectedCapabilities = capabilitySummary.slice(0, capLimit);
  const selectedCapabilityNames = new Set(selectedCapabilities.map((c) => c.name));

  const topFlows = useMemo(() => {
    const strengthByFlow = new Map<string, number>();
    for (const l of relationshipLinks) {
      if (!selectedCapabilityNames.has(l.capability)) continue;
      strengthByFlow.set(l.businessFlow, (strengthByFlow.get(l.businessFlow) || 0) + l.count);
    }
    return [...strengthByFlow.entries()]
      .map(([name, strength]) => ({ name, strength }))
      .sort((a, b) => b.strength - a.strength)
      .slice(0, flowLimit)
      .map((f) => f.name);
  }, [relationshipLinks, selectedCapabilityNames, flowLimit]);

  const bubbleData = selectedCapabilities.map((c, i) => ({
    x: i + 1,
    y: c.flowCount,
    z: c.flowCount,
    capability: c.name,
    totalStrength: c.totalStrength,
    maxStrength: c.maxStrength,
  }));

  const heatRows = selectedCapabilities.map((c) => ({
    capability: c.name,
    flowCount: c.flowCount,
    cells: topFlows.map((flow) => ({
      flow,
      value: linkMap.get(`${c.name}|||${flow}`) || 0,
    })),
  }));

  const heatMax = Math.max(1, ...heatRows.flatMap((r) => r.cells.map((c) => c.value)));

  return (
    <>
      <Card title={`Top 10 Business Capabilities by Cost — ${costYear}`} size="small" style={{ marginBottom: 24 }}>
        {capabilityCostBarData.length > 0 ? (
          <ResponsiveContainer width="100%" height={360}>
            <BarChart data={capabilityCostBarData} layout="vertical" margin={{ top: 5, right: 30, left: 20, bottom: 20 }}>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis type="number" tickFormatter={fmtM} />
              <YAxis dataKey="name" type="category" width={240} tick={{ fontSize: 11 }} />
              <Tooltip content={({ payload }) => {
                if (!payload?.length) return null;
                const d = payload[0].payload;
                return <div style={{ background: '#fff', border: '1px solid #ccc', padding: 8, borderRadius: 4, fontSize: 12 }}>
                  <div style={{ fontWeight: 600 }}>{d.fullName}</div>
                  <div style={{ color: '#6e7681', fontSize: 11 }}>Supported by {d.flowCount} business flow{d.flowCount === 1 ? '' : 's'}</div>
                  <div style={{ color: '#1890ff' }}>Operation: {fmtM(d.opCost)}</div>
                  <div style={{ color: '#d29922' }}>Development: {fmtM(d.devCost)}</div>
                  <div style={{ fontWeight: 600 }}>Total: {fmtM(d.totalCost)}</div>
                </div>;
              }} />
              <Legend />
              <Bar dataKey="opCost" name="Operation Cost" stackId="a" fill="#1890ff" radius={[0, 0, 0, 0]} />
              <Bar dataKey="devCost" name="Development Cost" stackId="a" fill="#d29922" radius={[0, 4, 4, 0]} />
            </BarChart>
          </ResponsiveContainer>
        ) : (
          <Empty description={`No capability cost data for ${costYear}. Add capability mappings to diagrams to populate this chart.`} />
        )}
      </Card>

      {hasRelationshipData ? (
        <>
          <Row gutter={[16, 16]} style={{ marginBottom: 24 }}>
            <Col xs={12} sm={6}><Card size="small"><Statistic title="Diagrams" value={data!.totalDiagrams} /></Card></Col>
            <Col xs={12} sm={6}><Card size="small"><Statistic title="With Capabilities" value={data!.diagramsWithCapabilities} /></Card></Col>
            <Col xs={12} sm={6}><Card size="small"><Statistic title="Capabilities" value={data!.capabilityCount} /></Card></Col>
            <Col xs={12} sm={6}><Card size="small"><Statistic title="Relationships" value={data!.linkCount} /></Card></Col>
          </Row>

      <Card
        title="Capability Bubble Map"
        size="small"
        style={{ marginBottom: 24 }}
        extra={
          <div style={{ display: 'flex', gap: 8 }}>
            <Select
              size="small"
              value={capLimit}
              style={{ width: 170 }}
              options={[10, 20, 30, 50].map((n) => ({ label: `Top ${n} capabilities`, value: n }))}
              onChange={setCapLimit}
            />
            <Select
              size="small"
              value={flowLimit}
              style={{ width: 170 }}
              options={[10, 20, 30, 50].map((n) => ({ label: `Top ${n} flows`, value: n }))}
              onChange={setFlowLimit}
            />
          </div>
        }
      >
        <div style={{ color: '#64748b', fontSize: 12, marginBottom: 8 }}>
          Bubble size represents the number of distinct process flows supporting each capability.
        </div>
        <ResponsiveContainer width="100%" height={360}>
          <ScatterChart margin={{ top: 10, right: 20, left: 10, bottom: 20 }}>
            <CartesianGrid strokeDasharray="3 3" />
            <XAxis type="number" dataKey="x" tick={false} domain={[0, Math.max(12, capLimit + 1)]} name="Capability Rank" />
            <YAxis type="number" dataKey="y" allowDecimals={false} name="Supporting Process Flows" />
            <ZAxis type="number" dataKey="z" range={[80, 1200]} />
            <Tooltip
              cursor={{ strokeDasharray: '3 3' }}
              formatter={(value: any, name: any) => [value, name]}
              content={({ active, payload }) => {
                if (!active || !payload?.length) return null;
                const d: any = payload[0].payload;
                return (
                  <div style={{ background: '#fff', border: '1px solid #ccc', padding: 8, borderRadius: 4, fontSize: 12, maxWidth: 340 }}>
                    <div style={{ fontWeight: 700, marginBottom: 4 }}>{d.capability}</div>
                    <div>Supporting flows: {d.y}</div>
                    <div>Total strength: {d.totalStrength}</div>
                    <div>Max link strength: {d.maxStrength}</div>
                  </div>
                );
              }}
            />
            <Scatter data={bubbleData} fill="#1d4ed8" />
          </ScatterChart>
        </ResponsiveContainer>

        <Table
          style={{ marginTop: 12 }}
          rowKey={(r) => r.name}
          dataSource={selectedCapabilities.slice(0, 15)}
          size="small"
          pagination={false}
          columns={enhanceColumnsWithSortAndFilters([
            { title: 'Capability', dataIndex: 'name', key: 'name', ellipsis: true },
            { title: 'Supporting Flows', dataIndex: 'flowCount', key: 'flowCount', width: 140, sorter: (a, b) => a.flowCount - b.flowCount, defaultSortOrder: 'descend' as const },
            { title: 'Total Strength', dataIndex: 'totalStrength', key: 'totalStrength', width: 130, sorter: (a, b) => a.totalStrength - b.totalStrength },
          ], selectedCapabilities.slice(0, 15))}
        />
      </Card>

      <Card title="Capability x Business Flow Heatmap" size="small" style={{ marginBottom: 24 }}>
        <div style={{ overflowX: 'auto', border: '1px solid #e5e7eb', borderRadius: 8 }}>
          <table style={{ borderCollapse: 'collapse', width: '100%', minWidth: 900 }}>
            <thead>
              <tr style={{ background: '#f8fafc' }}>
                <th style={{ textAlign: 'left', padding: '8px 10px', borderBottom: '1px solid #e5e7eb', minWidth: 280 }}>Business Capability</th>
                {topFlows.map((flow) => (
                  <th key={flow} style={{ textAlign: 'center', padding: '8px 10px', borderBottom: '1px solid #e5e7eb', minWidth: 120, fontSize: 11 }} title={flow}>
                    {flow.length > 20 ? `${flow.slice(0, 17)}...` : flow}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {heatRows.map((row) => (
                <tr key={row.capability}>
                  <td style={{ padding: '8px 10px', borderBottom: '1px solid #f1f5f9', fontWeight: 600 }} title={row.capability}>
                    {row.capability.length > 42 ? `${row.capability.slice(0, 39)}...` : row.capability}
                  </td>
                  {row.cells.map((cell) => {
                    const ratio = cell.value / heatMax;
                    const background = cell.value > 0 ? `rgba(29, 78, 216, ${0.12 + ratio * 0.82})` : '#f8fafc';
                    const color = ratio > 0.55 ? '#ffffff' : '#0f172a';
                    return (
                      <td
                        key={`${row.capability}__${cell.flow}`}
                        title={`${row.capability} -> ${cell.flow}: ${cell.value}`}
                        style={{
                          textAlign: 'center',
                          padding: '8px 6px',
                          borderBottom: '1px solid #f1f5f9',
                          background,
                          color,
                          fontWeight: cell.value > 0 ? 700 : 500,
                        }}
                      >
                        {cell.value || '-'}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <Card title="Top Capability to Business Flow Relationships" size="small">
        <Table
          rowKey={(r) => `${r.capability}__${r.businessFlow}`}
          dataSource={relationshipLinks.slice(0, 100)}
          size="small"
          pagination={{ pageSize: 20, showSizeChanger: true, position: ['topRight'] }}
          columns={enhanceColumnsWithSortAndFilters([
            { title: 'Business Capability', dataIndex: 'capability', key: 'capability', ellipsis: true, sorter: (a, b) => a.capability.localeCompare(b.capability) },
            { title: 'Business Flow', dataIndex: 'businessFlow', key: 'businessFlow', ellipsis: true, sorter: (a, b) => a.businessFlow.localeCompare(b.businessFlow) },
            { title: 'Relationship Strength', dataIndex: 'count', key: 'count', width: 170, sorter: (a, b) => a.count - b.count, defaultSortOrder: 'descend' as const },
          ], relationshipLinks.slice(0, 100))}
        />
      </Card>
        </>
      ) : (
        <Card title="Capability to Business Flow Relationships" size="small">
          <Empty description="No capability-to-business-flow relationships found" />
        </Card>
      )}
    </>
  );
}

// ─── Task Dashboard ─────────────────────────────────────────
function TaskDashboard({ tasks, allTasks, costData, costYear }: { tasks: TaskProfile[]; allTasks: TaskProfile[]; costData: TaskCostByYearItem[]; costYear: number }) {
  if (!tasks.length) return <Empty description="No tasks with applications found" />;

  const topTasksByRisk = sortDescBy(tasks, (task) => task.riskScore).slice(0, 20);
  const topTasksByCompliance = sortDescBy(tasks, (task) => complianceYesTotal(task)).slice(0, 20);
  const topTasksByServerVulns = sortDescBy(tasks, (task) => task.serverVulnerabilities).slice(0, 20);
  const topTasksByDbVulns = sortDescBy(tasks, (task) => task.dbVulnerabilities).slice(0, 20);

  const fmtM = (n: number) => '$' + (n / 1_000_000).toFixed(1) + 'M';
  const costBarData = sortDescBy(costData, (task) => task.totalCost).slice(0, 20).map((t) => ({
    name: t.name.length > 25 ? t.name.slice(0, 22) + '...' : t.name,
    fullName: t.name,
    flow: t.businessFlow,
    opCost: t.opCost,
    devCost: t.devCost,
    totalCost: t.totalCost,
  }));

  // Risk score bar chart data
  const riskBarData = topTasksByRisk.map((t) => ({
    name: t.name.length > 25 ? t.name.slice(0, 22) + '...' : t.name,
    fullName: t.name,
    riskScore: t.riskScore,
    appCount: t.appCount,
  }));

  // Compliance comparison data (stacked bar showing yes count per compliance field)
  const complianceBarData = topTasksByCompliance.map((t) => {
    const row: any = { name: t.name.length > 25 ? t.name.slice(0, 22) + '...' : t.name, fullName: t.name };
    for (const field of COMPLIANCE_FIELDS) {
      row[field] = (t[field] as YNCount).yes;
    }
    return row;
  });
  const serverVulnerabilityBarData = topTasksByServerVulns.map((t) => ({
    name: t.name.length > 25 ? t.name.slice(0, 22) + '...' : t.name,
    fullName: t.name,
    serverVulnerabilities: t.serverVulnerabilities,
  }));
  const dbVulnerabilityBarData = topTasksByDbVulns.map((t) => ({
    name: t.name.length > 25 ? t.name.slice(0, 22) + '...' : t.name,
    fullName: t.name,
    dbVulnerabilities: t.dbVulnerabilities,
  }));

  // Radar data for top 5 tasks
  const radarTasks = topTasksByRisk.slice(0, 5);
  const [radarTaskSelected, setRadarTaskSelected] = useState<string[]>([]);
  const radarTasksFiltered = radarTaskSelected.length > 0
    ? allTasks.filter((t) => radarTaskSelected.includes(t.name)).slice(0, 5)
    : radarTasks;
  const radarTaskTitle = radarTaskSelected.length > 0 ? 'Compliance Radar — Selected Tasks' : 'Compliance Radar — Top 5 Riskiest Tasks';
  const radarData = COMPLIANCE_FIELDS.map((field) => {
    const point: any = { subject: COMPLIANCE_LABELS[field] };
    radarTasksFiltered.forEach((t, i) => {
      point[`task${i}`] = (t[field] as YNCount).yes;
    });
    return point;
  });

  // Summary stats
  const totalApps = new Set(tasks.flatMap((t) => [])).size; // placeholder
  const avgRisk = tasks.length ? Math.round(tasks.reduce((s, t) => s + t.riskScore, 0) / tasks.length) : 0;
  const maxRisk = tasks.length ? Math.max(...tasks.map((t) => t.riskScore)) : 0;
  const highRiskCount = tasks.filter((t) => t.riskScore > 15).length;

  // Criticality pie — filterable by task (uses full allTasks list, independent of top flow filter)
  const [critTasks, setCritTasks] = useState<string[]>([]);
  const tasksForPie = critTasks.length > 0 ? allTasks.filter((t) => critTasks.includes(t.name)) : allTasks;
  const taskCritAgg: Record<string, number> = {};
  for (const t of tasksForPie) {
    for (const [k, v] of Object.entries(t.criticality)) {
      taskCritAgg[k] = (taskCritAgg[k] || 0) + v;
    }
  }
  const taskCritPieData = Object.entries(taskCritAgg)
    .filter(([k]) => k !== 'Unknown')
    .map(([name, value]) => ({ name, value }))
    .sort((a, b) => b.value - a.value);

  return (
    <>
      {/* Cost Bar Chart — first */}
      {costBarData.length > 0 && (
        <Card title={`Top 20 Tasks by Cost — ${costYear}`} size="small" style={{ marginBottom: 24 }}>
          <ResponsiveContainer width="100%" height={350}>
            <BarChart data={costBarData} margin={{ top: 5, right: 30, left: 20, bottom: 80 }}>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis dataKey="name" angle={-45} textAnchor="end" interval={0} height={80} tick={{ fontSize: 11 }} />
              <YAxis tickFormatter={(v) => fmtM(v)} width={70} />
              <Tooltip content={({ payload }) => {
                if (!payload?.length) return null;
                const d = payload[0].payload;
                return <div style={{ background: '#fff', border: '1px solid #ccc', padding: 8, borderRadius: 4, fontSize: 12 }}>
                  <div style={{ fontWeight: 600 }}>{d.fullName}</div>
                  <div style={{ color: '#6e7681', fontSize: 11 }}>{d.flow}</div>
                  <div style={{ color: '#1890ff' }}>Operation: {fmtM(d.opCost)}</div>
                  <div style={{ color: '#d29922' }}>Development: {fmtM(d.devCost)}</div>
                  <div style={{ fontWeight: 600 }}>Total: {fmtM(d.totalCost)}</div>
                </div>;
              }} />
              <Legend />
              <Bar dataKey="opCost" name="Operation Cost" stackId="a" fill="#1890ff" radius={[0, 0, 0, 0]} />
              <Bar dataKey="devCost" name="Development Cost" stackId="a" fill="#d29922" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </Card>
      )}

      {/* Summary cards */}
      <Row gutter={[16, 16]} style={{ marginBottom: 24 }}>
        <Col xs={12} sm={6}><Card size="small"><Statistic title="Tasks" value={tasks.length} /></Card></Col>
        <Col xs={12} sm={6}><Card size="small"><Statistic title="Avg Risk Score" value={avgRisk} /></Card></Col>
        <Col xs={12} sm={6}><Card size="small"><Statistic title="Max Risk Score" value={maxRisk} valueStyle={{ color: riskLevel(maxRisk).color }} /></Card></Col>
        <Col xs={12} sm={6}><Card size="small"><Statistic title="High+ Risk Tasks" value={highRiskCount} valueStyle={{ color: highRiskCount > 0 ? '#f5222d' : '#52c41a' }} /></Card></Col>
      </Row>

      {/* Risk Score Bar Chart */}
      <Card title="Top 20 Tasks by Risk Score" size="small" style={{ marginBottom: 24 }}>
        <ResponsiveContainer width="100%" height={350}>
          <BarChart data={riskBarData} margin={{ top: 5, right: 30, left: 10, bottom: 80 }}>
            <CartesianGrid strokeDasharray="3 3" />
            <XAxis dataKey="name" angle={-45} textAnchor="end" interval={0} height={80} tick={{ fontSize: 11 }} />
            <YAxis />
            <Tooltip content={({ payload }) => {
              if (!payload?.length) return null;
              const d = payload[0].payload;
              return <div style={{ background: '#fff', border: '1px solid #ccc', padding: 8, borderRadius: 4 }}>
                <div style={{ fontWeight: 600 }}>{d.fullName}</div>
                <div>Risk Score: {d.riskScore}</div>
                <div>Applications: {d.appCount}</div>
              </div>;
            }} />
            <Bar dataKey="riskScore" fill="#f5222d" radius={[4, 4, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </Card>

      {/* Compliance Stacked Bar */}
      <Card title="Compliance Flags per Task (Top 20 by Compliance)" size="small" style={{ marginBottom: 24 }}>
        <ResponsiveContainer width="100%" height={350}>
          <BarChart data={complianceBarData} margin={{ top: 5, right: 30, left: 10, bottom: 80 }}>
            <CartesianGrid strokeDasharray="3 3" />
            <XAxis dataKey="name" angle={-45} textAnchor="end" interval={0} height={80} tick={{ fontSize: 11 }} />
            <YAxis />
            <Tooltip />
            <Legend />
            {COMPLIANCE_FIELDS.map((field, i) => (
              <Bar key={field} dataKey={field} name={COMPLIANCE_LABELS[field]} stackId="a" fill={COLORS[i % COLORS.length]} />
            ))}
          </BarChart>
        </ResponsiveContainer>
      </Card>

      <Row gutter={[16, 16]} style={{ marginBottom: 24 }}>
        <Col xs={24} md={12}>
          <Card title="Server Vulnerabilities per Task (Top 20 by Server Vulnerabilities)" size="small">
            <ResponsiveContainer width="100%" height={320}>
              <BarChart data={serverVulnerabilityBarData} margin={{ top: 5, right: 30, left: 10, bottom: 80 }}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="name" angle={-45} textAnchor="end" interval={0} height={80} tick={{ fontSize: 11 }} />
                <YAxis />
                <Tooltip content={({ payload }) => {
                  if (!payload?.length) return null;
                  const d = payload[0].payload;
                  return <div style={{ background: '#fff', border: '1px solid #ccc', padding: 8, borderRadius: 4 }}>
                    <div style={{ fontWeight: 600 }}>{d.fullName}</div>
                    <div>Server Vulnerabilities: {d.serverVulnerabilities}</div>
                  </div>;
                }} />
                <Legend />
                <Bar dataKey="serverVulnerabilities" name={VULNERABILITY_LABELS.serverVulnerabilities} fill="#ff7a45" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </Card>
        </Col>
        <Col xs={24} md={12}>
          <Card title="DB Vulnerabilities per Task (Top 20 by DB Vulnerabilities)" size="small">
            <ResponsiveContainer width="100%" height={320}>
              <BarChart data={dbVulnerabilityBarData} margin={{ top: 5, right: 30, left: 10, bottom: 80 }}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="name" angle={-45} textAnchor="end" interval={0} height={80} tick={{ fontSize: 11 }} />
                <YAxis />
                <Tooltip content={({ payload }) => {
                  if (!payload?.length) return null;
                  const d = payload[0].payload;
                  return <div style={{ background: '#fff', border: '1px solid #ccc', padding: 8, borderRadius: 4 }}>
                    <div style={{ fontWeight: 600 }}>{d.fullName}</div>
                    <div>DB Vulnerabilities: {d.dbVulnerabilities}</div>
                  </div>;
                }} />
                <Legend />
                <Bar dataKey="dbVulnerabilities" name={VULNERABILITY_LABELS.dbVulnerabilities} fill="#36cfc9" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </Card>
        </Col>
      </Row>

      {/* Criticality Pie + Radar Row */}
      <Row gutter={[16, 16]} style={{ marginBottom: 24 }}>
        <Col xs={24} md={12}>
          <Card
            title="Application Criticality Distribution"
            size="small"
            extra={
              <Select
                mode="multiple"
                allowClear
                placeholder="All tasks"
                style={{ minWidth: 200, maxWidth: 340 }}
                maxTagCount={2}
                value={critTasks}
                onChange={setCritTasks}
                showSearch
                filterOption={(input, opt) => (opt?.label as string ?? '').toLowerCase().includes(input.toLowerCase())}
                options={[...new Set(allTasks.map((t) => t.name))].sort().map((name) => ({ label: name, value: name }))}
              />
            }
          >
            <ResponsiveContainer width="100%" height={300}>
              <PieChart>
                <Pie data={taskCritPieData} dataKey="value" nameKey="name" cx="50%" cy="50%" outerRadius={100} label={({ name, percent }) => `${name} (${((percent ?? 0) * 100).toFixed(0)}%)`} labelLine>
                  {taskCritPieData.map((_, i) => <Cell key={i} fill={COLORS[i % COLORS.length]} />)}
                </Pie>
                <Tooltip />
              </PieChart>
            </ResponsiveContainer>
          </Card>
        </Col>

        <Col xs={24} md={12}>
          <Card
            title={radarTaskTitle}
            size="small"
            extra={
              <Select
                mode="multiple"
                allowClear
                placeholder="Top 5 by risk"
                style={{ minWidth: 200, maxWidth: 340 }}
                maxTagCount={2}
                value={radarTaskSelected}
                onChange={(vals) => setRadarTaskSelected(vals.slice(0, 5))}
                showSearch
                filterOption={(input, opt) => (opt?.label as string ?? '').toLowerCase().includes(input.toLowerCase())}
                options={[...new Set(allTasks.map((t) => t.name))].sort().map((name) => ({ label: name, value: name }))}
              />
            }
          >
            {radarTasksFiltered.length < 2 ? (
              <div style={{ height: 300, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#8b949e' }}>
                Select at least 2 tasks to display the radar
              </div>
            ) : (
              <ResponsiveContainer width="100%" height={300}>
                <RadarChart data={radarData}>
                  <PolarGrid />
                  <PolarAngleAxis dataKey="subject" tick={{ fontSize: 11 }} />
                  <PolarRadiusAxis />
                  {radarTasksFiltered.map((t, i) => (
                    <Radar
                      key={t._id}
                      name={t.name.length > 20 ? t.name.slice(0, 17) + '...' : t.name}
                      dataKey={`task${i}`}
                      stroke={COLORS[i]}
                      fill={COLORS[i]}
                      fillOpacity={0.15}
                    />
                  ))}
                  <Legend />
                  <Tooltip />
                </RadarChart>
              </ResponsiveContainer>
            )}
          </Card>
        </Col>
      </Row>

      {/* Task Risk Table */}
      <Card title="All Tasks — Risk & Compliance Summary" size="small">
        <Table
          dataSource={[...tasks].sort((a, b) => b.riskScore - a.riskScore)}
          rowKey="_id"
          size="small"
          pagination={{ pageSize: 15, showSizeChanger: true, position: ['topRight'] }}
          scroll={{ x: 900 }}
          columns={enhanceColumnsWithSortAndFilters([
            { title: 'Task', dataIndex: 'name', key: 'name', ellipsis: true, width: 180, sorter: (a, b) => a.name.localeCompare(b.name) },
            { title: 'Business Flow', dataIndex: 'businessFlow', key: 'bflow', ellipsis: true, width: 160 },
            { title: 'Apps', dataIndex: 'appCount', key: 'apps', width: 60, sorter: (a, b) => a.appCount - b.appCount },
            {
              title: 'Risk', dataIndex: 'riskScore', key: 'risk', width: 80,
              sorter: (a, b) => a.riskScore - b.riskScore,
              defaultSortOrder: 'descend',
              render: (v: number) => { const r = riskLevel(v); return <Tag color={r.color}>{v} ({r.label})</Tag>; },
            },
            { title: 'CPNI', key: 'cpni', width: 55, render: (_, r) => r.cpni.yes || '-' },
            { title: 'SPI', key: 'spi', width: 55, render: (_, r) => (r.handleSpi.yes + r.storeSpi.yes) || '-' },
            { title: 'PCI', key: 'pci', width: 55, render: (_, r) => (r.pciData.yes + r.pciDataStored.yes) || '-' },
            { title: 'SOX', key: 'sox', width: 55, render: (_, r) => r.soxFsa.yes || '-' },
            { title: 'Cust.', key: 'cf', width: 55, render: (_, r) => r.customerFacing.yes || '-' },
            { title: 'Inet.', key: 'if', width: 55, render: (_, r) => r.internetFacing.yes || '-' },
            { title: 'Srv Vulns', dataIndex: 'serverVulnerabilities', key: 'sv', width: 90, sorter: (a, b) => a.serverVulnerabilities - b.serverVulnerabilities },
            { title: 'DB Vulns', dataIndex: 'dbVulnerabilities', key: 'dv', width: 90, sorter: (a, b) => a.dbVulnerabilities - b.dbVulnerabilities },
          ], [...tasks].sort((a, b) => b.riskScore - a.riskScore))}
        />
      </Card>
    </>
  );
}

// ─── Flow Dashboard ─────────────────────────────────────────
function FlowDashboard({ flows, costData, costYear, devCostPoints, onFlowCostBarClick, featureCostFlowRequest, onViewFullFeatureCost, neighborhoodName, onViewDiagramClick }: { flows: FlowProfile[]; costData: CostByYearItem[]; costYear: number; devCostPoints: FeatureCostPoint[]; onFlowCostBarClick?: (flowName: string) => void; featureCostFlowRequest?: { flow: string; nonce: number } | null; onViewFullFeatureCost?: () => void; neighborhoodName?: string; onViewDiagramClick?: (businessFlowName: string, neighborhoodName: string) => void }) {
  if (!flows.length) return <Empty description="No business flows with tasks/applications found" />;

  const topFlowsByRisk = sortDescBy(flows, (flow) => flow.riskScore).slice(0, 20);
  const topFlowsByCompliance = sortDescBy(flows, (flow) => complianceYesTotal(flow)).slice(0, 20);
  const topFlowsByServerVulns = sortDescBy(flows, (flow) => flow.serverVulnerabilities).slice(0, 20);
  const topFlowsByDbVulns = sortDescBy(flows, (flow) => flow.dbVulnerabilities).slice(0, 20);

  const fmtM = (n: number) => '$' + (n / 1_000_000).toFixed(1) + 'M';

  // Top 20 flows by total dev cost across every year the ApplicationFeatureDevCost
  // data covers (same source as the YoY Feature Cost 3D chart), not just one
  // fixed year — replaces the old op+dev cost-for-costYear-only chart below.
  const devCostByFlow = new Map<string, number>();
  devCostPoints.forEach((p) => {
    devCostByFlow.set(p.businessFlow, (devCostByFlow.get(p.businessFlow) || 0) + p.cost);
  });
  const devCostBarData = [...devCostByFlow.entries()]
    .map(([name, devCost]) => ({ name, devCost }))
    .sort((a, b) => b.devCost - a.devCost)
    .slice(0, 20)
    .map((f) => ({
      name: f.name.length > 25 ? f.name.slice(0, 22) + '...' : f.name,
      fullName: f.name,
      devCost: f.devCost,
    }));

  // Risk bar data
  const riskBarData = topFlowsByRisk.map((f) => ({
    name: f.name.length > 25 ? f.name.slice(0, 22) + '...' : f.name,
    fullName: f.name,
    riskScore: f.riskScore,
    taskCount: f.taskCount,
    appCount: f.appCount,
  }));

  // Compliance bar data
  const complianceBarData = topFlowsByCompliance.map((f) => {
    const row: any = { name: f.name.length > 25 ? f.name.slice(0, 22) + '...' : f.name, fullName: f.name };
    for (const field of COMPLIANCE_FIELDS) {
      row[field] = (f[field] as YNCount).yes;
    }
    return row;
  });
  const serverVulnerabilityBarData = topFlowsByServerVulns.map((f) => ({
    name: f.name.length > 25 ? f.name.slice(0, 22) + '...' : f.name,
    fullName: f.name,
    serverVulnerabilities: f.serverVulnerabilities,
  }));
  const dbVulnerabilityBarData = topFlowsByDbVulns.map((f) => ({
    name: f.name.length > 25 ? f.name.slice(0, 22) + '...' : f.name,
    fullName: f.name,
    dbVulnerabilities: f.dbVulnerabilities,
  }));

  // Criticality pie — filterable by flow
  const [critFlows, setCritFlows] = useState<string[]>([]);
  const flowsForPie = critFlows.length > 0 ? flows.filter((f) => critFlows.includes(f.name)) : flows;
  const critAgg: Record<string, number> = {};
  for (const f of flowsForPie) {
    for (const [k, v] of Object.entries(f.criticality)) {
      critAgg[k] = (critAgg[k] || 0) + v;
    }
  }
  const critPieData = Object.entries(critAgg)
    .filter(([k]) => k !== 'Unknown')
    .map(([name, value]) => ({ name, value }))
    .sort((a, b) => b.value - a.value);

  // Radar — filterable by flow (max 5 for readability)
  const [radarSelected, setRadarSelected] = useState<string[]>([]);
  const radarFlows = radarSelected.length > 0
    ? flows.filter((f) => radarSelected.includes(f.name)).slice(0, 5)
    : topFlowsByRisk.slice(0, 5);
  const radarData = COMPLIANCE_FIELDS.map((field) => {
    const point: any = { subject: COMPLIANCE_LABELS[field] };
    radarFlows.forEach((f, i) => {
      point[`flow${i}`] = (f[field] as YNCount).yes;
    });
    return point;
  });
  const radarTitle = radarSelected.length > 0 ? 'Compliance Radar — Selected Flows' : 'Compliance Radar — Top 5 Riskiest Flows';

  // Summary
  const avgRisk = flows.length ? Math.round(flows.reduce((s, f) => s + f.riskScore, 0) / flows.length) : 0;
  const maxRisk = flows.length ? Math.max(...flows.map((f) => f.riskScore)) : 0;
  const totalApps = flows.reduce((s, f) => s + f.appCount, 0);

  // ─── 3x3 grid resizing ────────────────────────────────────────
  // colWidths are the 3 columns' widths as %s of the grid's own width
  // (sum to 100, shared by all 3 rows so the vertical boundaries line up
  // straight down the grid); rowHeights are the 3 rows' heights in px.
  // Each of the grid's 4 interior boundaries (2 vertical, 2 horizontal) is
  // its own drag handle, resizing just the pair of columns/rows on either
  // side of it (their combined size stays fixed — a plain zero-sum
  // drag-resize, the same pattern used elsewhere in this app for the
  // properties panel width and factory table column widths, not a new
  // dependency).
  const [colWidths, setColWidths] = useState<[number, number, number]>([100 / 3, 100 / 3, 100 / 3]);
  const [rowHeights, setRowHeights] = useState<[number, number, number]>([QUADRANT_HEIGHT, QUADRANT_HEIGHT, QUADRANT_HEIGHT]);
  const quadrantGridRef = useRef<HTMLDivElement>(null);

  // Columns already fill 100% of the grid's width (flex-grow based), so
  // "cover the entire screen evenly" only needs the rows' starting heights
  // fixed — QUADRANT_HEIGHT above was just a flat guess, unrelated to the
  // viewport. Size all 3 rows evenly to fill whatever vertical space is
  // actually left below the grid's own top, the same
  // measure-from-here-to-window-bottom pattern ServerLocationMap.tsx uses
  // for its own fit-to-screen button. Runs once per mount (this component is
  // unmounted/remounted by the Segmented switch above, not kept alive) and
  // again on window resize; a manual drag afterward isn't overwritten until
  // the next resize.
  useEffect(() => {
    const fitGridToScreen = () => {
      if (typeof window === 'undefined' || !quadrantGridRef.current) return;
      const top = quadrantGridRef.current.getBoundingClientRect().top;
      const rowDividerCount = 3; // row0/row1, row1/row2, and the bottom-edge handle
      const bottomMargin = 16; // matches the outer Dashboard() wrapper's own padding
      const available = window.innerHeight - top - rowDividerCount * 10 - bottomMargin;
      const perRow = Math.max(180, Math.floor(available / 3));
      setRowHeights([perRow, perRow, perRow]);
    };

    fitGridToScreen();
    window.addEventListener('resize', fitGridToScreen);
    return () => window.removeEventListener('resize', fitGridToScreen);
  }, []);
  const quadrantDragRef = useRef<{
    mode: 'col' | 'row' | 'rowEdge';
    index: 0 | 1; // which interior boundary: 0 = between item 0/1, 1 = between item 1/2 (unused for 'rowEdge')
    startX: number;
    startY: number;
    startA: number; // size of item[index] at drag start ('rowEdge': row 2's own height)
    startB: number; // size of item[index + 1] at drag start (unused for 'rowEdge')
    containerWidth: number;
  } | null>(null);

  const handleQuadrantPointerMove = (e: PointerEvent) => {
    const drag = quadrantDragRef.current;
    if (!drag) return;
    const pairTotal = drag.startA + drag.startB;
    if (drag.mode === 'col') {
      const deltaPercent = ((e.clientX - drag.startX) / drag.containerWidth) * 100;
      const nextA = Math.max(MIN_COL_WIDTH_PERCENT, Math.min(pairTotal - MIN_COL_WIDTH_PERCENT, drag.startA + deltaPercent));
      setColWidths((current) => {
        const next = [...current] as [number, number, number];
        next[drag.index] = nextA;
        next[drag.index + 1] = pairTotal - nextA;
        return next;
      });
    } else if (drag.mode === 'row') {
      const deltaY = e.clientY - drag.startY;
      const nextA = Math.max(MIN_QUADRANT_SIZE, Math.min(pairTotal - MIN_QUADRANT_SIZE, drag.startA + deltaY));
      setRowHeights((current) => {
        const next = [...current] as [number, number, number];
        next[drag.index] = nextA;
        next[drag.index + 1] = pairTotal - nextA;
        return next;
      });
    } else {
      // 'rowEdge' — the bottom edge of the last row. Nothing below it to
      // balance against, so this just grows/shrinks row 3 directly instead
      // of trading space with a neighbor.
      const deltaY = e.clientY - drag.startY;
      const nextA = Math.max(MIN_QUADRANT_SIZE, drag.startA + deltaY);
      setRowHeights((current) => {
        const next = [...current] as [number, number, number];
        next[2] = nextA;
        return next;
      });
    }
  };

  const handleQuadrantPointerUp = () => {
    quadrantDragRef.current = null;
    window.removeEventListener('pointermove', handleQuadrantPointerMove);
    window.removeEventListener('pointerup', handleQuadrantPointerUp);
  };

  const startColDrag = (index: 0 | 1) => (e: React.PointerEvent) => {
    e.preventDefault();
    quadrantDragRef.current = {
      mode: 'col',
      index,
      startX: e.clientX,
      startY: e.clientY,
      startA: colWidths[index],
      startB: colWidths[index + 1],
      containerWidth: quadrantGridRef.current?.getBoundingClientRect().width || 1000,
    };
    window.addEventListener('pointermove', handleQuadrantPointerMove);
    window.addEventListener('pointerup', handleQuadrantPointerUp);
  };

  const startRowDrag = (index: 0 | 1) => (e: React.PointerEvent) => {
    e.preventDefault();
    quadrantDragRef.current = {
      mode: 'row',
      index,
      startX: e.clientX,
      startY: e.clientY,
      startA: rowHeights[index],
      startB: rowHeights[index + 1],
      containerWidth: 0,
    };
    window.addEventListener('pointermove', handleQuadrantPointerMove);
    window.addEventListener('pointerup', handleQuadrantPointerUp);
  };

  // Bottom edge of the last row — grows/shrinks the whole grid's total
  // height, rather than trading space with a sibling row.
  const startRowEdgeDrag = (e: React.PointerEvent) => {
    e.preventDefault();
    quadrantDragRef.current = {
      mode: 'rowEdge',
      index: 0,
      startX: e.clientX,
      startY: e.clientY,
      startA: rowHeights[2],
      startB: 0,
      containerWidth: 0,
    };
    window.addEventListener('pointermove', handleQuadrantPointerMove);
    window.addEventListener('pointerup', handleQuadrantPointerUp);
  };

  const colDividerStyle: React.CSSProperties = {
    flex: '0 0 10px',
    cursor: 'col-resize',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    touchAction: 'none',
  };
  const rowDividerStyle: React.CSSProperties = {
    height: 10,
    cursor: 'row-resize',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    touchAction: 'none',
  };
  const colGripStyle: React.CSSProperties = { width: 3, height: 36, background: '#d9d9d9', borderRadius: 2 };
  const rowGripStyle: React.CSSProperties = { height: 3, width: 36, background: '#d9d9d9', borderRadius: 2 };

  const renderEmptyCell = (height: number) => (
    <Card size="small" style={{ height }} bodyStyle={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <span style={{ color: '#bfbfbf', fontSize: 12 }}>Empty</span>
    </Card>
  );

  const renderDevCostCell = (height: number) => (
    <Card title="Top 20 Business Flows by Dev Cost — All Years" size="small" style={{ height }}>
      {devCostBarData.length > 0 ? (
        <ResponsiveContainer width="100%" height={Math.max(150, height - CHART_HEIGHT_OFFSET)}>
          <BarChart data={devCostBarData} margin={{ top: 5, right: 30, left: 20, bottom: 80 }}>
            <CartesianGrid strokeDasharray="3 3" />
            <XAxis dataKey="name" angle={-45} textAnchor="end" interval={0} height={80} tick={{ fontSize: 11 }} />
            <YAxis tickFormatter={(v) => fmtM(v)} width={70} />
            <Tooltip content={({ payload }) => {
              if (!payload?.length) return null;
              const d = payload[0].payload;
              const isSelected = d.fullName === featureCostFlowRequest?.flow;
              return <div style={{ background: '#fff', border: '1px solid #ccc', padding: 8, borderRadius: 4, fontSize: 12 }}>
                <div style={{ fontWeight: 600 }}>{d.fullName}</div>
                <div style={{ color: isSelected ? '#1677ff' : '#d29922' }}>Development Cost: {fmtM(d.devCost)}</div>
                {onFlowCostBarClick && <div style={{ color: '#999', marginTop: 4 }}>Click to view YoY Feature Cost →</div>}
              </div>;
            }} />
            <Bar
              dataKey="devCost"
              name="Development Cost"
              radius={[4, 4, 0, 0]}
              cursor={onFlowCostBarClick ? 'pointer' : undefined}
              onClick={(data: any) => onFlowCostBarClick?.(data.fullName)}
            >
              {devCostBarData.map((entry) => {
                const isSelected = entry.fullName === featureCostFlowRequest?.flow;
                return (
                  <Cell
                    key={entry.fullName}
                    fill={isSelected ? '#1677ff' : '#d29922'}
                    stroke={isSelected ? '#0958d9' : undefined}
                    strokeWidth={isSelected ? 2 : 0}
                  />
                );
              })}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      ) : (
        <Empty description="No dev cost data available" style={{ marginTop: 48 }} />
      )}
    </Card>
  );

  const renderFeatureCostCell = (height: number) => (
    <Card
      title={onViewFullFeatureCost ? (
        <a
          onClick={onViewFullFeatureCost}
          title="Open the full YoY Feature Cost view for this business flow"
        >
          YoY Feature Cost
        </a>
      ) : 'YoY Feature Cost'}
      size="small"
      style={{ height }}
      bodyStyle={{ height: `calc(100% - 40px)` }}
    >
      <div style={{ height: '100%' }}>
        <FeatureCost3DChart requestedFlow={featureCostFlowRequest} autoSelectDefaultFlow={false} />
      </div>
    </Card>
  );

  // (1,3) — the BPMN2.0 diagram for whichever flow was last clicked in the
  // dev-cost chart (same trigger as the YoY Feature Cost cell above, driven
  // by the same featureCostFlowRequest). Looked up via the flow→diagram id
  // map and rendered read-only through BpmnMiniViewer (no palette/properties
  // panel — a NavigatedViewer, not a Modeler — since this is a display-only
  // embed, not an editing surface).
  const [diagramXml, setDiagramXml] = useState<string | null>(null);
  const [diagramFlowName, setDiagramFlowName] = useState<string | null>(featureCostFlowRequest?.flow || null);
  const [diagramLoading, setDiagramLoading] = useState(Boolean(featureCostFlowRequest));
  const [diagramNotFound, setDiagramNotFound] = useState(false);

  useEffect(() => {
    if (!featureCostFlowRequest) return;
    let cancelled = false;
    setDiagramFlowName(featureCostFlowRequest.flow);
    setDiagramLoading(true);
    setDiagramNotFound(false);
    (async () => {
      try {
        const flowMap = await getCachedBusinessFlowMap(neighborhoodName || '__default__');
        const diagramId = flowMap[featureCostFlowRequest.flow];
        if (!diagramId) {
          if (!cancelled) { setDiagramXml(null); setDiagramNotFound(true); }
          return;
        }
        const xml = await getCachedDiagramXml(diagramId);
        if (!cancelled) setDiagramXml(xml);
      } catch {
        if (!cancelled) { setDiagramXml(null); setDiagramNotFound(true); }
      } finally {
        if (!cancelled) setDiagramLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [featureCostFlowRequest]);

  const canOpenDiagramTab = Boolean(diagramFlowName && diagramXml && !diagramNotFound && onViewDiagramClick && neighborhoodName);

  const renderDiagramCell = (height: number) => (
    <Card
      title={canOpenDiagramTab ? (
        <a
          onClick={() => onViewDiagramClick!(diagramFlowName!, neighborhoodName!)}
          title="Open this diagram in the Diagrams tab"
        >
          Business Process Flow Diagram
        </a>
      ) : 'Business Process Flow Diagram'}
      size="small"
      style={{ height }}
      bodyStyle={{ height: `calc(100% - 40px)`, padding: 0 }}
    >
      {!diagramFlowName ? (
        <Empty description="Click a bar in the Top 20 Business Flows chart to view its diagram" style={{ marginTop: 48 }} />
      ) : diagramLoading ? (
        <div style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}><Spin /></div>
      ) : diagramNotFound || !diagramXml ? (
        <Empty description={`No diagram found for "${diagramFlowName}"`} style={{ marginTop: 48 }} />
      ) : (
        <BpmnMiniViewer xml={diagramXml} diagramName={diagramFlowName} />
      )}
    </Card>
  );

  // (row, col), both 0-indexed — (0,0)/(0,1)/(0,2) are (1,1)/(1,2)/(1,3) in
  // the 1-indexed terms the grid is described in above. Every other cell is
  // empty for now.
  const gridCellRenderers: ((height: number) => React.ReactNode)[][] = [
    [renderDevCostCell, renderFeatureCostCell, renderDiagramCell],
    [renderEmptyCell, renderEmptyCell, renderEmptyCell],
    [renderEmptyCell, renderEmptyCell, renderEmptyCell],
  ];

  return (
    <>
      {/* ─── 3x3 grid ────────────────────────────────────────────
          (1,1) dev cost (same ApplicationFeatureDevCost source as the YoY
          Feature Cost 3D chart, summed across every available year).
          (1,2) that same YoY Feature Cost 3D chart, embedded live.
          Every other cell is left empty for now. Every interior boundary —
          both vertical lines between columns and both horizontal lines
          between rows — is its own drag handle; grab one to resize just
          the two cells on either side of it. */}
      <div ref={quadrantGridRef}>
        {([0, 1, 2] as const).map((rowIdx) => (
          <Fragment key={rowIdx}>
            <div style={{ display: 'flex' }}>
              {([0, 1, 2] as const).map((colIdx) => (
                <Fragment key={colIdx}>
                  {/* overflow: hidden keeps a cell's own content (e.g. the YoY
                      Feature Cost chart, which enforces a minimum plot height)
                      from visually bleeding past its fixed-height Card into the
                      row divider strip directly below it — otherwise that
                      overflowing content sits on top of the divider and steals
                      its drag events, making that stretch of the handle
                      unresponsive. */}
                  <div style={{ flex: `${colWidths[colIdx]} 0 0%`, minWidth: 0, height: rowHeights[rowIdx], overflow: 'hidden' }}>
                    {gridCellRenderers[rowIdx][colIdx](rowHeights[rowIdx])}
                  </div>
                  {colIdx < 2 && (
                    <div style={colDividerStyle} onPointerDown={startColDrag(colIdx as 0 | 1)} title="Drag to resize columns">
                      <div style={colGripStyle} />
                    </div>
                  )}
                </Fragment>
              ))}
            </div>
            {rowIdx < 2 && (
              <div style={rowDividerStyle} onPointerDown={startRowDrag(rowIdx as 0 | 1)} title="Drag to resize rows">
                <div style={rowGripStyle} />
              </div>
            )}
          </Fragment>
        ))}
        <div style={rowDividerStyle} onPointerDown={startRowEdgeDrag} title="Drag to resize the bottom row's height">
          <div style={rowGripStyle} />
        </div>
      </div>
    </>
  );
}
