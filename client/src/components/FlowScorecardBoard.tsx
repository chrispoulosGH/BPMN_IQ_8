import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { Alert, Button, Empty, Input, Segmented, Select, Spin, Tooltip, Typography } from 'antd';
import { ReloadOutlined, SearchOutlined } from '@ant-design/icons';
import { getFlowScorecards, getProcessChangeRadar } from '../api';
import type { FlowScorecard } from '../types';
import { computeFlowExposure, normalizeDomainLabel, RAG_COLOR, type FlowExposure } from '../utils/domainExposure';

const { Title, Text } = Typography;

type Level = 'red' | 'amber' | 'green' | 'none';
const LEVEL_COLOR: Record<Level, string> = { ...RAG_COLOR, none: '#d9d9d9' };
const LEVEL_RANK: Record<Level, number> = { red: 0, amber: 1, green: 2, none: 3 };
const LEVEL_LABEL: Record<Level, string> = { red: 'Critical', amber: 'Needs attention', green: 'Healthy', none: 'No data' };

// ─── Per-measure status rules (also shown in the legend) ───
function changeLevel(exposure: FlowExposure | undefined, radarAvailable: boolean): Level {
  if (!radarAvailable || !exposure || !exposure.issueCount) return 'none';
  return exposure.rag;
}
function soxLevel(sox: FlowScorecard['sox']): Level {
  if (!sox.inScope) return 'none';
  if ((sox.compliancePct ?? 100) < 75 || sox.bySeverity.High >= 3) return 'red';
  if (sox.openDeviations > 0) return 'amber';
  return 'green';
}
function securityLevel(security: FlowScorecard['security']): Level {
  if (!security) return 'none';
  if (security.probability >= 25) return 'red';
  if (security.probability >= 15) return 'amber';
  return 'green';
}
function defectLevel(defect: FlowScorecard['defect']): Level {
  if (!defect) return 'none';
  if (defect.probability >= 15) return 'red';
  if (defect.probability >= 10) return 'amber';
  return 'green';
}
const worst = (levels: Level[]): Level => levels.reduce((w, l) => (LEVEL_RANK[l] < LEVEL_RANK[w] ? l : w), 'none' as Level);
// Overall tile health: a composite, not simply the worst measure — each
// measure flags 10–30% of flows red on its own, so "worst of four" would
// call most flows critical. Critical = 2+ measures red; Needs attention =
// one red or 2+ amber; Healthy = otherwise (No data if nothing is rated).
function overallLevel(levels: Level[]): Level {
  const red = levels.filter((l) => l === 'red').length;
  const amber = levels.filter((l) => l === 'amber').length;
  if (red >= 2) return 'red';
  if (red === 1 || amber >= 2) return 'amber';
  return levels.some((l) => l !== 'none') ? 'green' : 'none';
}

const money = (n: number) => {
  if (!n) return '$0';
  if (Math.abs(n) >= 1e6) return `$${(n / 1e6).toFixed(n >= 1e7 ? 1 : 2)}M`;
  if (Math.abs(n) >= 1e3) return `$${Math.round(n / 1e3)}K`;
  return `$${Math.round(n)}`;
};

interface Tile {
  card: FlowScorecard;
  exposure?: FlowExposure;
  levels: { change: Level; sox: Level; security: Level; defect: Level };
  overall: Level;
  tcoChangePct: number | null;
}

type SortKey = 'health' | 'tco' | 'security' | 'defect' | 'sox' | 'change' | 'name';
const SORTS: Array<{ value: SortKey; label: string }> = [
  { value: 'health', label: 'Overall health (worst first)' },
  { value: 'tco', label: 'TCO (highest first)' },
  { value: 'security', label: 'Security risk (highest first)' },
  { value: 'defect', label: 'Defect risk (highest first)' },
  { value: 'sox', label: 'SOX deviations (most first)' },
  { value: 'change', label: 'Change exposure (most points first)' },
  { value: 'name', label: 'Name' },
];
function compareTiles(sort: SortKey) {
  return (a: Tile, b: Tile): number => {
    const byName = a.card.name.localeCompare(b.card.name);
    switch (sort) {
      case 'tco': return b.card.tco.total - a.card.tco.total || byName;
      case 'security': return (b.card.security?.probability ?? -1) - (a.card.security?.probability ?? -1) || byName;
      case 'defect': return (b.card.defect?.probability ?? -1) - (a.card.defect?.probability ?? -1) || byName;
      case 'sox': return (b.card.sox.bySeverity.High - a.card.sox.bySeverity.High) || (b.card.sox.openDeviations - a.card.sox.openDeviations) || byName;
      case 'change': return (b.exposure?.totalPoints ?? 0) - (a.exposure?.totalPoints ?? 0) || byName;
      case 'name': return byName;
      default: {
        const redCount = (t: Tile) => Object.values(t.levels).filter((l) => l === 'red').length;
        return LEVEL_RANK[a.overall] - LEVEL_RANK[b.overall] || redCount(b) - redCount(a) || byName;
      }
    }
  };
}

interface FlowScorecardBoardProps {
  /** Open the flow's diagram (Diagrams tab — where its SOX shields show). */
  onOpenFlow?: (flow: { diagramId: string; neighborhoodName: string | null }) => void;
  /** Jump to Process Change Radar focused on the flow (change exposure row). */
  onOpenChangeRadar?: (flow: { diagramId: string; domain: string }) => void;
}

/**
 * Dashboard tab: one tile per business process flow, each showing several
 * measurements side by side — change exposure (live Jira, via Process Change
 * Radar), SOX compliance (controls and open deviations), security risk,
 * defect risk and total cost of ownership. Scorecards come from
 * GET /api/dashboard/flow-scorecards; change exposure is merged in from the
 * radar separately so a slow or unconfigured Jira never blocks the tiles.
 */
export default function FlowScorecardBoard({ onOpenFlow, onOpenChangeRadar }: FlowScorecardBoardProps) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [cards, setCards] = useState<FlowScorecard[]>([]);
  const [tcoYear, setTcoYear] = useState<number | null>(null);
  const [exposureById, setExposureById] = useState<Map<string, FlowExposure>>(new Map());
  const [radarState, setRadarState] = useState<'loading' | 'ok' | 'unavailable'>('loading');
  const [search, setSearch] = useState('');
  const [domain, setDomain] = useState<string>('__all__');
  const [sort, setSort] = useState<SortKey>('health');
  const [show, setShow] = useState<'all' | 'attention' | 'critical'>('all');

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    setRadarState('loading');
    getProcessChangeRadar()
      .then((radar) => {
        if (!radar.configured) { setRadarState('unavailable'); return; }
        setExposureById(new Map(computeFlowExposure(radar, new Date(radar.generatedAt)).map((e) => [e.diagramId, e])));
        setRadarState('ok');
      })
      .catch(() => setRadarState('unavailable'));
    try {
      const data = await getFlowScorecards();
      setCards(data.scorecards);
      setTcoYear(data.tcoYear);
    } catch (err: any) {
      setError(err?.response?.data?.error || err?.message || 'Failed to load flow scorecards');
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const tiles: Tile[] = useMemo(() => cards.map((card) => {
    const exposure = exposureById.get(card.diagramId);
    const levels = {
      change: changeLevel(exposure, radarState === 'ok'),
      sox: soxLevel(card.sox),
      security: securityLevel(card.security),
      defect: defectLevel(card.defect),
    };
    const prior = card.tco.priorYearTotal;
    return {
      card,
      exposure,
      levels,
      overall: overallLevel(Object.values(levels)),
      tcoChangePct: prior ? Math.round(((card.tco.total - prior) / prior) * 100) : null,
    };
  }), [cards, exposureById, radarState]);

  const domains = useMemo(() => [...new Set(cards.map((c) => normalizeDomainLabel(c.domain)))].sort(), [cards]);

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    return tiles.filter((t) => {
      if (domain !== '__all__' && normalizeDomainLabel(t.card.domain) !== domain) return false;
      if (show === 'critical' && t.overall !== 'red') return false;
      if (show === 'attention' && t.overall !== 'red' && t.overall !== 'amber') return false;
      if (!q) return true;
      return [t.card.name, t.card.domain, t.card.subdomain || '', ...t.card.applications].some((v) => v.toLowerCase().includes(q));
    });
  }, [tiles, search, domain, show]);

  // Group by domain; domains with the worst tiles first.
  const groups = useMemo(() => {
    const byDomain = new Map<string, Tile[]>();
    for (const t of visible) {
      const key = normalizeDomainLabel(t.card.domain);
      if (!byDomain.has(key)) byDomain.set(key, []);
      byDomain.get(key)!.push(t);
    }
    return [...byDomain.entries()]
      .map(([name, list]) => ({ name, tiles: list.sort(compareTiles(sort)), worst: worst(list.map((t) => t.overall)), red: list.filter((t) => t.overall === 'red').length }))
      .sort((a, b) => LEVEL_RANK[a.worst] - LEVEL_RANK[b.worst] || b.red - a.red || a.name.localeCompare(b.name));
  }, [visible, sort]);

  const kpis = useMemo(() => ({
    flows: visible.length,
    red: visible.filter((t) => t.overall === 'red').length,
    amber: visible.filter((t) => t.overall === 'amber').length,
    tco: visible.reduce((s, t) => s + t.card.tco.total, 0),
    soxOpen: visible.reduce((s, t) => s + t.card.sox.openDeviations, 0),
    soxHigh: visible.reduce((s, t) => s + t.card.sox.bySeverity.High, 0),
    changing: visible.filter((t) => (t.exposure?.issueCount || 0) > 0).length,
  }), [visible]);

  return (
    <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <Title level={4} style={{ margin: 0 }}>Process Flow Scorecards</Title>
          <Text type="secondary">One tile per business process flow — change exposure, SOX compliance, security risk, defect risk and total cost of ownership.</Text>
        </div>
        <Button icon={<ReloadOutlined />} onClick={() => void load()} loading={loading}>Refresh</Button>
      </div>

      {/* KPI strip */}
      <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        {[
          { label: 'Flows shown', value: kpis.flows.toLocaleString() },
          { label: 'Critical', value: kpis.red.toLocaleString(), color: LEVEL_COLOR.red },
          { label: 'Needs attention', value: kpis.amber.toLocaleString(), color: '#d48806' },
          { label: `Total TCO${tcoYear ? ` (${tcoYear})` : ''}`, value: money(kpis.tco) },
          { label: 'Open SOX deviations', value: `${kpis.soxOpen}${kpis.soxHigh ? ` · ${kpis.soxHigh} high` : ''}`, color: kpis.soxHigh ? LEVEL_COLOR.red : undefined },
          { label: 'Flows with in-flight change', value: radarState === 'ok' ? kpis.changing.toLocaleString() : radarState === 'loading' ? '…' : 'n/a' },
        ].map((k) => (
          <div key={k.label} className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2">
            <div className="text-[11px] uppercase tracking-wide text-slate-500">{k.label}</div>
            <div className="text-lg font-semibold" style={{ color: k.color || '#0f172a' }}>{k.value}</div>
          </div>
        ))}
      </div>

      {/* Controls */}
      <div className="mt-4 flex flex-wrap items-center gap-2">
        <Input allowClear prefix={<SearchOutlined />} placeholder="Search flow, domain or application" value={search} onChange={(e) => setSearch(e.target.value)} style={{ width: 280 }} />
        <Select value={domain} onChange={setDomain} style={{ width: 240 }} options={[{ value: '__all__', label: 'All domains' }, ...domains.map((d) => ({ value: d, label: d }))]} />
        <Select value={sort} onChange={setSort} style={{ width: 260 }} options={SORTS} />
        <Segmented value={show} onChange={(v) => setShow(v as typeof show)} options={[{ value: 'all', label: 'All' }, { value: 'attention', label: 'Needs attention' }, { value: 'critical', label: 'Critical' }]} />
      </div>

      {/* Legend */}
      <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-slate-500">
        {(['red', 'amber', 'green', 'none'] as Level[]).map((l) => (
          <span key={l} className="inline-flex items-center gap-1"><span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: LEVEL_COLOR[l] }} />{LEVEL_LABEL[l]}</span>
        ))}
        <Tooltip
          title={(
            <div className="text-xs leading-5">
              <div><b>Change</b>: Process Change Radar jeopardy (overdue / due-soon story points).</div>
              <div><b>SOX</b>: red = under 75% of controls free of open deviations, or 3+ High deviations; amber = any open deviation; green = in scope, none open.</div>
              <div><b>Security</b>: red = breach probability ≥ 25%; amber ≥ 15%.</div>
              <div><b>Defect</b>: red = failure probability ≥ 15%; amber ≥ 10%.</div>
              <div><b>TCO</b>: allocated application run cost + server hosting + software maintenance + the flow's feature dev spend. Not rated — shown with year-over-year change.</div>
              <div><b>Overall</b>: Critical = 2 or more measures red; Needs attention = 1 red or 2+ amber; otherwise Healthy.</div>
            </div>
          )}
        >
          <span className="cursor-help underline decoration-dotted">How are tiles rated?</span>
        </Tooltip>
        {radarState === 'unavailable' && <span className="text-amber-600">Change exposure unavailable (Jira not reachable or not configured).</span>}
      </div>

      {error && <Alert className="mt-4" type="error" showIcon message={error} />}
      {loading && !cards.length ? (
        <div className="flex justify-center py-16"><Spin /></div>
      ) : !groups.length ? (
        <Empty className="py-10" description="No flows match the current filters" />
      ) : (
        <div className="mt-4 flex flex-col gap-6">
          {groups.map((group) => (
            <div key={group.name} className="rounded-xl border border-slate-300 bg-slate-200 p-3">
              <div className="mb-2.5 flex items-center gap-2">
                <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: LEVEL_COLOR[group.worst] }} />
                <span className="text-sm font-semibold text-slate-800">{group.name}</span>
                <span className="text-xs text-slate-500">{group.tiles.length} flow{group.tiles.length === 1 ? '' : 's'}{group.red ? ` · ${group.red} critical` : ''}</span>
              </div>
              <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))' }}>
                {group.tiles.map((tile) => (
                  <FlowTile key={tile.card.diagramId} tile={tile} radarState={radarState} onOpenFlow={onOpenFlow} onOpenChangeRadar={onOpenChangeRadar} />
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function MeasureRow({ label, level, value, detail, bar, onClick }: { label: string; level: Level; value: ReactNode; detail: ReactNode; bar?: number | null; onClick?: () => void }) {
  return (
    <Tooltip title={detail} placement="right" mouseEnterDelay={0.25}>
      <div
        className={`flex items-center gap-2 py-1 ${onClick ? 'cursor-pointer hover:bg-slate-50 rounded' : ''}`}
        onClick={onClick ? (e) => { e.stopPropagation(); onClick(); } : undefined}
      >
        <span className="w-[62px] flex-shrink-0 text-[11px] text-slate-500">{label}</span>
        <span className="inline-block h-2.5 w-2.5 flex-shrink-0 rounded-full" style={{ background: LEVEL_COLOR[level] }} />
        {bar != null && (
          <span className="relative h-1.5 w-12 flex-shrink-0 overflow-hidden rounded bg-slate-100">
            <span className="absolute inset-y-0 left-0 rounded" style={{ width: `${Math.min(100, Math.max(2, bar))}%`, background: LEVEL_COLOR[level] }} />
          </span>
        )}
        <span className="min-w-0 truncate text-xs text-slate-800">{value}</span>
      </div>
    </Tooltip>
  );
}

function FlowTile({ tile, radarState, onOpenFlow, onOpenChangeRadar }: { tile: Tile; radarState: 'loading' | 'ok' | 'unavailable'; onOpenFlow?: FlowScorecardBoardProps['onOpenFlow']; onOpenChangeRadar?: FlowScorecardBoardProps['onOpenChangeRadar'] }) {
  const { card, exposure, levels, overall, tcoChangePct } = tile;
  const { sox, security, defect, tco } = card;
  return (
    <div
      className="flex flex-col rounded-lg border border-slate-300 bg-white shadow transition-shadow hover:shadow-lg"
      style={{ borderTop: `4px solid ${LEVEL_COLOR[overall]}`, cursor: onOpenFlow ? 'pointer' : 'default' }}
      onClick={() => onOpenFlow?.({ diagramId: card.diagramId, neighborhoodName: card.neighborhoodName })}
      title={onOpenFlow ? 'Open this flow on the Diagrams tab' : undefined}
    >
      <div className="border-b border-slate-100 px-3 pb-2 pt-2.5">
        <div className="flex items-start justify-between gap-2">
          <div className="text-sm font-semibold leading-5 text-slate-900" style={{ display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>{card.name}</div>
          <span className="mt-0.5 flex-shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold" style={{ background: LEVEL_COLOR[overall], color: overall === 'red' ? '#fff' : '#0f172a' }}>{LEVEL_LABEL[overall]}</span>
        </div>
        <div className="mt-0.5 truncate text-[11px] text-slate-500" title={card.applications.join(', ')}>
          {card.subdomain || card.domain} · {card.applications.length} app{card.applications.length === 1 ? '' : 's'}: {card.applications.join(', ')}
        </div>
      </div>
      <div className="flex flex-col px-3 py-1.5">
        <MeasureRow
          label="Change"
          level={levels.change}
          value={radarState === 'loading' ? 'Loading…' : radarState === 'unavailable' ? 'Unavailable' : exposure?.issueCount
            ? <>{exposure.totalPoints} pts · {exposure.issueCount} issue{exposure.issueCount === 1 ? '' : 's'}{exposure.overdueCount ? <b className="text-red-600"> · {exposure.overdueCount} overdue</b> : ''}</>
            : <span className="text-slate-400">No in-flight change</span>}
          detail={exposure?.issueCount ? (
            <div className="text-xs leading-5">
              <div><b>Change exposure</b> (live Jira) — {exposure.issueCount} issue(s), {exposure.totalPoints} story points</div>
              <div>On track {exposure.onTrackPoints} · due ≤7d {exposure.dueSoon7Points} · overdue {exposure.overduePoints} pts</div>
              {exposure.nearestDue && <div>Nearest due: {exposure.nearestDue}</div>}
              {onOpenChangeRadar && <div className="mt-1 italic">Click to open in Process Change Radar</div>}
            </div>
          ) : 'No Jira issues currently touch this flow'}
          onClick={exposure?.issueCount && onOpenChangeRadar ? () => onOpenChangeRadar({ diagramId: card.diagramId, domain: normalizeDomainLabel(card.domain) }) : undefined}
        />
        <MeasureRow
          label="SOX"
          level={levels.sox}
          bar={sox.compliancePct}
          value={sox.inScope
            ? <>{sox.compliancePct}% · {sox.controlCount} ctrl{sox.openDeviations ? <b style={{ color: sox.bySeverity.High ? '#cf1322' : '#d46b08' }}> · ⚠ {sox.openDeviations}</b> : ''}</>
            : <span className="text-slate-400">Not in SOX scope</span>}
          detail={sox.inScope ? (
            <div className="text-xs leading-5">
              <div><b>SOX compliance</b> — {sox.compliancePct}% of {sox.controlCount} controls ({sox.keyControlCount} key) have no open deviation</div>
              <div>{sox.flowInScope ? 'Flow is in SOX process scope' : 'In scope via its applications’ IT general controls only'}</div>
              <div>Open deviations: {sox.openDeviations} (High {sox.bySeverity.High} · Medium {sox.bySeverity.Medium} · Low {sox.bySeverity.Low}) on {sox.controlsWithDeviations} control(s)</div>
              {sox.overdueDeviations > 0 && <div style={{ color: '#ff7875' }}>{sox.overdueDeviations} past remediation target date</div>}
              <div className="mt-1 italic">Open the flow to see the SOX shields on the diagram</div>
            </div>
          ) : 'No SOX controls attach to this flow or its applications'}
        />
        <MeasureRow
          label="Security"
          level={levels.security}
          bar={security?.probability ?? null}
          value={security ? <>{security.probability}% breach · {security.severity}</> : <span className="text-slate-400">No data</span>}
          detail={security ? (
            <div className="text-xs leading-5">
              <div><b>Security risk</b> — {security.probability}% estimated breach probability, {security.severity} severity</div>
              <div>{security.atRiskAssets} of {security.assets} servers/software at risk (patching, compliance, CVEs, end-of-life)</div>
            </div>
          ) : 'No application infrastructure linked to this flow'}
        />
        <MeasureRow
          label="Defect"
          level={levels.defect}
          bar={defect?.probability ?? null}
          value={defect ? <>{defect.probability}% failure · {defect.criticality}</> : <span className="text-slate-400">No data</span>}
          detail={defect ? (
            <div className="text-xs leading-5">
              <div><b>Defect risk</b> — {defect.probability}% estimated failure probability, {defect.criticality} criticality</div>
              <div>{defect.atRiskAssets} of {defect.assets} servers/software at risk (warranty/firmware, capacity, backups, end-of-support)</div>
            </div>
          ) : 'No application infrastructure linked to this flow'}
        />
        <MeasureRow
          label={`TCO${tco.year ? ` '${String(tco.year).slice(2)}` : ''}`}
          level="none"
          value={<>
            <b>{money(tco.total)}</b>
            {tcoChangePct != null && tcoChangePct !== 0 && (
              <span className="ml-1" style={{ color: tcoChangePct > 0 ? '#cf1322' : '#389e0d' }}>{tcoChangePct > 0 ? '▲' : '▼'} {Math.abs(tcoChangePct)}%</span>
            )}
          </>}
          detail={(
            <div className="text-xs leading-5">
              <div><b>Total cost of ownership{tco.year ? ` (${tco.year})` : ''}</b>: {money(tco.total)}</div>
              <div>Application run cost: {money(tco.application)}</div>
              <div>Server hosting: {money(tco.infrastructure)}</div>
              <div>Software maintenance: {money(tco.software)}</div>
              <div>Feature development: {money(tco.development)} (prior year {money(tco.developmentPriorYear)})</div>
              <div className="mt-1 italic">Shared applications are allocated to flows by their share of task usage.{tco.uncostedApplications ? ` ${tco.uncostedApplications} application(s) not in the catalog have no run cost.` : ''}</div>
            </div>
          )}
        />
      </div>
    </div>
  );
}
