import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { Alert, Button, Collapse, Empty, Input, Spin, Tag, Typography } from 'antd';
import { SearchOutlined, UndoOutlined } from '@ant-design/icons';
import BpmnEditor, { EMPTY_DIAGRAM, type BpmnEditorHandle } from './BpmnEditor';
import SpeedometerGauge from './SpeedometerGauge';
import { getApplicationRiskReference, getDashboardFeatureCost3D, getDiagram, getDiagramsForNeighborhood, getProcessChangeRadar } from '../api';
import type { ApplicationRiskProfile, FeatureCostPoint } from '../api';
import { normalizeDomainLabel } from '../utils/domainExposure';
import {
  buildRiskLookup, computeAggregateCost, computeAggregateDefectRisk,
  computeAggregateSecurityRisk, computeLiveJiraActivity,
} from '../utils/quantitativeModel';
import type { DiagramMeta, JiraImpactIssue, ProcessChangeRadarResponse } from '../types';

const { Title, Text } = Typography;

// Matches Dashboard.tsx's own COST_YEAR pin — Feature Dev Cost data runs
// 2021-2025, and the dashboard's other cost views default to the latest
// year rather than summing every year together.
const COST_YEAR = 2025;
const EDIT_DEBOUNCE_MS = 400;

interface GaugeReadings {
  cost: number;
  securityProbability: number;
  defectProbability: number;
  jiraCount: number;
}

const EMPTY_READINGS: GaugeReadings = { cost: 0, securityProbability: 0, defectProbability: 0, jiraCount: 0 };

interface DomainGroup {
  domain: string;
  diagrams: DiagramMeta[];
}

/**
 * "Quantitative Modeling" — a side-by-side what-if sandbox: the left canvas
 * is the selected flow exactly as saved (read-only baseline), the right is
 * the same flow, live-editable. Both start with identical gauge readings
 * (cost / security risk / defect risk / Jira activity); editing the right
 * side's tasks/applications recomputes *only* its own gauges in real time,
 * so the delta between the two panels *is* the answer to "what does this
 * change actually cost/risk."
 *
 * Nothing here is ever saved — this is a scratch comparison, not a new
 * diagram revision. Selecting a different flow discards any in-progress
 * what-if edit and starts a fresh baseline==live pair.
 *
 * Known limitation shared with the rest of this app: `readOnly` on
 * BpmnEditor hides editing chrome but doesn't make the underlying bpmn-js
 * Modeler non-interactive, so the left canvas could technically still be
 * dragged. That's harmless here specifically — the baseline gauges are
 * computed once from the freshly-fetched server record, not re-read from
 * the left editor's live state, so stray canvas fiddling can't skew the
 * numbers, only (cosmetically) the drawing.
 */
export default function QuantitativeModeling() {
  // ---- sidebar: search + diagram list ----
  const [diagrams, setDiagrams] = useState<DiagramMeta[]>([]);
  const [loadingDiagrams, setLoadingDiagrams] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedDiagramId, setSelectedDiagramId] = useState<string | null>(null);

  // ---- reference data, fetched once ----
  const [riskLookup, setRiskLookup] = useState<Map<string, ApplicationRiskProfile>>(new Map());
  const [costPoints, setCostPoints] = useState<FeatureCostPoint[]>([]);
  const [radarData, setRadarData] = useState<ProcessChangeRadarResponse | null>(null);
  const [refLoading, setRefLoading] = useState(true);
  const [refError, setRefError] = useState<string | null>(null);

  // ---- selected diagram + its two panels ----
  const [selectedMeta, setSelectedMeta] = useState<{ name: string; businessFlow: string } | null>(null);
  const [baselineXml, setBaselineXml] = useState<string>(EMPTY_DIAGRAM);
  const [importTrigger, setImportTrigger] = useState(0);
  const [diagramLoading, setDiagramLoading] = useState(false);
  const [diagramError, setDiagramError] = useState<string | null>(null);
  const [baselineAppNames, setBaselineAppNames] = useState<string[]>([]);
  const [liveAppNames, setLiveAppNames] = useState<string[]>([]);

  const editEditorRef = useRef<BpmnEditorHandle>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ---- load the pickable diagram list (all neighborhoods) ----
  useEffect(() => {
    setLoadingDiagrams(true);
    getDiagramsForNeighborhood('__all__')
      .then(setDiagrams)
      .catch(() => setDiagrams([]))
      .finally(() => setLoadingDiagrams(false));
  }, []);

  // ---- load the three reference datasets the gauges are built from ----
  useEffect(() => {
    setRefLoading(true);
    setRefError(null);
    Promise.all([
      getApplicationRiskReference().then((r) => setRiskLookup(buildRiskLookup(r.applications))),
      getDashboardFeatureCost3D().then((r) => setCostPoints(r.points)),
      getProcessChangeRadar().then(setRadarData).catch(() => setRadarData(null)), // Jira may be unconfigured — degrade gracefully, don't block the rest
    ])
      .catch((err) => setRefError(err?.response?.data?.error || err?.message || 'Failed to load reference data.'))
      .finally(() => setRefLoading(false));
  }, []);

  // ---- select a flow: load it fresh, reset both panels to its baseline ----
  const selectDiagram = useCallback(async (diagram: DiagramMeta) => {
    setSelectedDiagramId(diagram._id);
    setDiagramLoading(true);
    setDiagramError(null);
    try {
      const full = await getDiagram(diagram._id);
      const businessFlow = full.businessFlow || full.name;
      setSelectedMeta({ name: full.name, businessFlow });
      setBaselineXml(full.xml);
      setImportTrigger((t) => t + 1);
      const appNames = (full.tasks || []).flatMap((t) => (t.applications || []).map((a) => a.name)).filter(Boolean);
      setBaselineAppNames(appNames);
      setLiveAppNames(appNames);
    } catch (err: any) {
      setDiagramError(err?.response?.data?.error || err?.message || 'Failed to load this diagram.');
    } finally {
      setDiagramLoading(false);
    }
  }, []);

  // ---- live recompute as the right-hand editor is edited ----
  const handleEditDirty = useCallback(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      const tasks = editEditorRef.current?.getTaskApplications() || [];
      setLiveAppNames(tasks.flatMap((t) => t.apps));
    }, EDIT_DEBOUNCE_MS);
  }, []);
  useEffect(() => () => { if (debounceRef.current) clearTimeout(debounceRef.current); }, []);

  const handleResetWhatIf = useCallback(() => {
    setImportTrigger((t) => t + 1); // re-imports baselineXml into both panels
    setLiveAppNames(baselineAppNames);
  }, [baselineAppNames]);

  // ---- gauge math ----
  const referenceDate = useMemo(() => (radarData ? new Date(radarData.generatedAt) : new Date()), [radarData]);

  const flowSourcedIssues = useMemo<JiraImpactIssue[]>(() => {
    if (!radarData || !selectedDiagramId) return [];
    const summary = radarData.diagrams.find((d) => d.diagramId === selectedDiagramId);
    return (summary?.issues || []).filter((i) => i.source === 'businessFlow');
  }, [radarData, selectedDiagramId]);

  const computeReadings = useCallback((appNames: string[]): GaugeReadings => {
    if (!selectedMeta) return EMPTY_READINGS;
    const cost = computeAggregateCost(appNames, selectedMeta.businessFlow, costPoints, COST_YEAR);
    const security = computeAggregateSecurityRisk(appNames, riskLookup);
    const defect = computeAggregateDefectRisk(appNames, riskLookup);
    const jira = radarData ? computeLiveJiraActivity(appNames, flowSourcedIssues, radarData.issuesByApplicationName, referenceDate) : null;
    return { cost, securityProbability: security.probability, defectProbability: defect.probability, jiraCount: jira?.issueCount || 0 };
  }, [selectedMeta, costPoints, riskLookup, radarData, flowSourcedIssues, referenceDate]);

  const baselineReadings = useMemo(() => computeReadings(baselineAppNames), [computeReadings, baselineAppNames]);
  const liveReadings = useMemo(() => computeReadings(liveAppNames), [computeReadings, liveAppNames]);

  // Fixed per selection, shared by both panels' matching gauge so the two
  // stay visually comparable even as the live needle moves.
  const gaugeMax = useMemo(() => ({
    cost: Math.max(baselineReadings.cost * 2, 5000),
    jira: Math.max(baselineReadings.jiraCount * 2, 10),
  }), [baselineReadings]);

  // ---- sidebar: search + domain grouping (same pattern as Process Change Radar/Heat Map) ----
  const filteredDiagrams = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return diagrams;
    return diagrams.filter((d) => {
      const flow = (d.businessFlow || d.name || '').toLowerCase();
      const domain = normalizeDomainLabel(d.domain).toLowerCase();
      return flow.includes(q) || domain.includes(q);
    });
  }, [diagrams, searchQuery]);

  const groupedDiagrams = useMemo<DomainGroup[]>(() => {
    const byDomain = new Map<string, DiagramMeta[]>();
    for (const d of filteredDiagrams) {
      const domain = normalizeDomainLabel(d.domain);
      if (!byDomain.has(domain)) byDomain.set(domain, []);
      byDomain.get(domain)!.push(d);
    }
    return Array.from(byDomain.entries())
      .map(([domain, ds]) => ({ domain, diagrams: ds.sort((a, b) => (a.businessFlow || a.name).localeCompare(b.businessFlow || b.name)) }))
      .sort((a, b) => a.domain.localeCompare(b.domain));
  }, [filteredDiagrams]);

  return (
    <div className="flex h-full w-full min-h-0 flex-col">
      <div className="flex items-center justify-between gap-3 border-b border-slate-200 bg-slate-50 px-4 py-2.5">
        <div>
          <Title level={5} className="!mb-0.5">Quantitative Modeling</Title>
          <Text type="secondary" className="text-xs">
            {selectedMeta ? <>What-if sandbox for <b>{selectedMeta.businessFlow}</b> — edit the right canvas, watch its gauges move.</> : 'Pick a flow to compare its baseline against a live what-if edit.'}
          </Text>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {selectedMeta && (
            <Button size="small" icon={<UndoOutlined />} onClick={handleResetWhatIf}>Reset what-if</Button>
          )}
        </div>
      </div>

      {refError && <div className="p-3"><Alert type="warning" showIcon closable message="Some reference data failed to load" description={refError} /></div>}

      <div className="flex min-h-0 flex-1">
        {/* ---- sidebar ---- */}
        <div className="flex w-72 shrink-0 flex-col border-r border-slate-200 bg-white">
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
            {loadingDiagrams ? (
              <div className="flex justify-center py-8"><Spin size="small" /></div>
            ) : !filteredDiagrams.length ? (
              <Empty description="No flows match your search" className="mt-8" />
            ) : (
              <Collapse
                ghost
                size="small"
                defaultActiveKey={groupedDiagrams.map((g) => g.domain)}
                items={groupedDiagrams.map((group) => ({
                  key: group.domain,
                  label: <span className="text-sm font-medium text-slate-700">{group.domain} <Tag className="!m-0 !ml-1">{group.diagrams.length}</Tag></span>,
                  children: (
                    <div className="flex flex-col gap-1">
                      {group.diagrams.map((d) => (
                        <button
                          key={d._id}
                          type="button"
                          onClick={() => void selectDiagram(d)}
                          className={`rounded px-2 py-1.5 text-left text-xs transition-colors ${
                            d._id === selectedDiagramId ? 'border border-blue-200 bg-blue-50' : 'border border-transparent hover:bg-slate-50'
                          }`}
                        >
                          <div className="truncate font-medium text-slate-800">{d.businessFlow || d.name}</div>
                          <div className="text-[10px] text-slate-400">{(d.tasks || []).length} task{(d.tasks || []).length === 1 ? '' : 's'}</div>
                        </button>
                      ))}
                    </div>
                  ),
                }))}
              />
            )}
          </div>
        </div>

        {/* ---- comparison panels ---- */}
        <div className="relative min-h-0 flex-1">
          {!selectedMeta && !diagramLoading && (
            <div className="flex h-full items-center justify-center p-8">
              <Empty description="Select a flow from the list to start modeling." />
            </div>
          )}
          {diagramError && (
            <div className="p-4"><Alert type="error" showIcon message="Couldn't load this diagram" description={diagramError} /></div>
          )}
          {selectedMeta && (
            <div className="grid h-full min-h-0 grid-rows-2 divide-y divide-slate-200">
              <ComparisonPanel
                title="Baseline"
                subtitle="Read-only — as currently saved"
                readings={baselineReadings}
                gaugeMax={gaugeMax}
                xml={baselineXml}
                importTrigger={importTrigger}
                diagramName={selectedMeta.name}
                loading={diagramLoading}
                readOnly
              />
              <ComparisonPanel
                title="What-If"
                subtitle="Editable — change tasks/applications to see live impact"
                readings={liveReadings}
                baselineForDelta={baselineReadings}
                gaugeMax={gaugeMax}
                xml={baselineXml}
                importTrigger={importTrigger}
                diagramName={selectedMeta.name}
                loading={diagramLoading}
                editorRef={editEditorRef}
                onDirty={handleEditDirty}
              />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

interface ComparisonPanelProps {
  title: string;
  subtitle: string;
  readings: GaugeReadings;
  baselineForDelta?: GaugeReadings;
  gaugeMax: { cost: number; jira: number };
  xml: string;
  importTrigger: number;
  diagramName: string;
  loading: boolean;
  readOnly?: boolean;
  editorRef?: RefObject<BpmnEditorHandle>;
  onDirty?: () => void;
}

function ComparisonPanel({ title, subtitle, readings, baselineForDelta, gaugeMax, xml, importTrigger, diagramName, loading, readOnly, editorRef, onDirty }: ComparisonPanelProps) {
  return (
    <div className="flex min-h-0 flex-col">
      <div className="border-b border-slate-100 bg-slate-50 px-3 py-2">
        <div className="flex items-center gap-2">
          <span className="text-[13px] font-semibold text-slate-700">{title}</span>
          <Tag className="!m-0" color={readOnly ? 'default' : 'blue'}>{subtitle}</Tag>
        </div>
      </div>

      <div className="grid grid-cols-4 gap-1 border-b border-slate-100 bg-white px-1 py-1">
        <SpeedometerGauge
          label="Cost"
          value={readings.cost}
          max={gaugeMax.cost}
          reference={baselineForDelta?.cost}
          prefix="$"
          valueFormat=".3~s"
        />
        <SpeedometerGauge
          label="Security Risk"
          value={readings.securityProbability}
          max={100}
          reference={baselineForDelta?.securityProbability}
          suffix="%"
          valueFormat=".0f"
        />
        <SpeedometerGauge
          label="Defect Risk"
          value={readings.defectProbability}
          max={100}
          reference={baselineForDelta?.defectProbability}
          suffix="%"
          valueFormat=".0f"
        />
        <SpeedometerGauge
          label="Jira Activity"
          value={readings.jiraCount}
          max={gaugeMax.jira}
          reference={baselineForDelta?.jiraCount}
          suffix=" issues"
          valueFormat=".0f"
        />
      </div>

      <div className="relative min-h-0 flex-1">
        {loading && (
          <div className="absolute inset-0 z-10 flex items-center justify-center bg-white/70">
            <Spin size="large" />
          </div>
        )}
        <BpmnEditor
          ref={editorRef}
          xml={xml}
          importTrigger={importTrigger}
          showProperties={false}
          readOnly={readOnly}
          diagramName={diagramName}
          onDirty={onDirty}
        />
      </div>
    </div>
  );
}
