import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type React from 'react';
import { Alert, Button, Empty, Segmented, Select, Spin, Tag, Tooltip, message } from 'antd';
import { CopyOutlined, DownloadOutlined, DownOutlined, InfoCircleOutlined, NodeIndexOutlined, UpOutlined } from '@ant-design/icons';
import { getApiSequence } from '../api';
import type { ApiSequenceCall, ApiSequenceFragment, ApiSequenceResponse, ApiSequenceStep } from '../types';
import { DataObjectTag } from './IntegrationMap';

/**
 * API sequence for the business flow(s) on the Diagrams canvas: a UML-style
 * sequence diagram with one lifeline per application and one arrow per API
 * call, in the order of the diagram's sequence flows, grouped by task.
 *
 * Arrows follow the data: provider → consumer, as recorded on each API. In
 * these flows the consumer of one step is usually the provider of the next,
 * so the arrows read as one hand-off chain.
 *
 * Clicking a call selects it (details on the right) and selects its task on
 * the BPMN canvas; selecting a task on the canvas highlights its calls here.
 */

const COLOR = {
  ink: '#0f172a',
  inkMuted: '#64748b',
  inkFaint: '#94a3b8',
  arrow: '#334155',
  internal: '#94a3b8',
  active: '#2563eb',
  lifeline: '#cbd5e1',
  bandA: '#ffffff',
  bandB: '#f8fafc',
  bandActive: '#eff6ff',
  headerFill: '#f1f5f9',
  headerStroke: '#cbd5e1',
  fragment: '#7c3aed',
};

const GUTTER = 230; // task labels
const COL_W = 168;
const HEADER_H = 50;
const CALL_H = 46;
const BAND_PAD = 8;
const FRAGMENT_HEAD = 22;

interface ApiSequencePanelProps {
  /** Diagrams on the canvas, in stacking order (index = composite section). */
  diagramIds: string[];
  /** Task currently selected on the BPMN canvas, if any. */
  highlightTaskName?: string | null;
  /** Select the task on the BPMN canvas. */
  onFocusTask?: (taskName: string, sectionIndex: number) => void;
}

type Row =
  | { kind: 'band'; step: ApiSequenceStep; y: number; height: number; band: number }
  | { kind: 'call'; call: ApiSequenceCall; step: ApiSequenceStep; y: number }
  | { kind: 'fragment'; fragment: ApiSequenceFragment; y: number; height: number; separators: Array<{ y: number; label: string }> };

const norm = (value: string) => String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const truncate = (value: string, max: number) => (value.length > max ? `${value.slice(0, max - 1)}…` : value);
/** Endpoints share a long prefix (/api/v1/<domain>/<subdomain>/<flow>/…); keep the meaningful tail. */
const shortEndpoint = (endpoint: string, max = 36) => {
  if (!endpoint || endpoint.length <= max) return endpoint;
  const last = endpoint.split('/').filter(Boolean).pop() || endpoint;
  return truncate(`…/${last}`, max);
};

function wrap(text: string, max: number, lines = 2): string[] {
  const words = text.split(/\s+/);
  const out: string[] = [];
  let current = '';
  for (const word of words) {
    if (!current) current = word;
    else if (`${current} ${word}`.length <= max) current = `${current} ${word}`;
    else {
      out.push(current);
      current = word;
    }
  }
  if (current) out.push(current);
  if (out.length > lines) return [...out.slice(0, lines - 1), truncate(out.slice(lines - 1).join(' '), max)];
  return out;
}

function objectSummary(call: ApiSequenceCall, objects: ApiSequenceResponse['dataObjects']): string {
  const req = objects[call.requestObject]?.name || '';
  const res = objects[call.responseObject]?.name || '';
  if (req && res && req !== res) return `${req} → ${res}`;
  if (req && res) return req;
  if (res) return `→ ${res}`;
  return req;
}

/** Steps in display order, flattening fragments. */
function allSteps(sequence: ApiSequenceResponse): ApiSequenceStep[] {
  return sequence.items.flatMap((item) => (item.kind === 'step' ? [item.step] : item.fragment.branches.flatMap((b) => b.steps)));
}

function layout(sequence: ApiSequenceResponse) {
  const rows: Row[] = [];
  let y = 0;
  let band = 0;
  const addStep = (step: ApiSequenceStep) => {
    const height = Math.max(step.calls.length, 1) * CALL_H + BAND_PAD * 2;
    rows.push({ kind: 'band', step, y, height, band: band++ });
    step.calls.forEach((call, i) => rows.push({ kind: 'call', call, step, y: y + BAND_PAD + i * CALL_H }));
    y += height;
  };
  for (const item of sequence.items) {
    if (item.kind === 'step') {
      addStep(item.step);
      continue;
    }
    const start = y;
    const separators: Array<{ y: number; label: string }> = [];
    const fragmentRow: Row = { kind: 'fragment', fragment: item.fragment, y: start, height: 0, separators };
    rows.push(fragmentRow);
    item.fragment.branches.forEach((branch, i) => {
      separators.push({ y, label: branch.label });
      y += i === 0 ? FRAGMENT_HEAD : FRAGMENT_HEAD - 4;
      branch.steps.forEach(addStep);
    });
    fragmentRow.height = y - start;
    y += 6;
  }
  return { rows, height: y + 12 };
}

/** Mermaid `sequenceDiagram` text for docs, Confluence and GitHub. */
function toMermaid(sequence: ApiSequenceResponse): string {
  const ids = new Map(sequence.participants.map((p) => [p.id, `P_${p.id.replace(/[^A-Za-z0-9]/g, '_')}`]));
  const clean = (value: string) => String(value || '').replace(/[;#]/g, ',').replace(/\s+/g, ' ').trim();
  const lines = ['sequenceDiagram', `  title ${clean(sequence.businessFlow || sequence.diagramName)}`, '  autonumber'];
  for (const p of sequence.participants) lines.push(`  participant ${ids.get(p.id)} as ${clean(p.acronym)}`);
  const stepLines = (step: ApiSequenceStep, indent: string) => {
    const label = clean(step.lane ? `${step.taskName} (${step.lane})` : step.taskName);
    const first = step.calls[0];
    if (!first) {
      const anyone = ids.get(sequence.participants[0]?.id || '');
      if (anyone) lines.push(`${indent}Note over ${anyone}: ${label}, no API`);
      return;
    }
    const over = first.from === first.to ? ids.get(first.from) : `${ids.get(first.from)},${ids.get(first.to)}`;
    lines.push(`${indent}Note over ${over}: ${label}`);
    for (const call of step.calls) {
      const objects = clean(objectSummary(call, sequence.dataObjects));
      const text = clean(`${call.method} ${shortEndpoint(call.endpoint, 60)}`) + (objects ? ` · ${objects}` : '');
      lines.push(`${indent}${ids.get(call.from)}->>${ids.get(call.to)}: ${text}`);
    }
  };
  for (const item of sequence.items) {
    if (item.kind === 'step') {
      stepLines(item.step, '  ');
      continue;
    }
    const { fragment } = item;
    const joiner = fragment.type === 'par' ? 'and' : 'else';
    fragment.branches.forEach((branch, i) => {
      lines.push(i === 0 ? `  ${fragment.type} ${clean(fragment.label)}: ${clean(branch.label)}` : `  ${joiner} ${clean(branch.label)}`);
      branch.steps.forEach((step) => stepLines(step, '    '));
    });
    lines.push('  end');
  }
  return `${lines.join('\n')}\n`;
}

export default function ApiSequencePanel({ diagramIds, highlightTaskName, onFocusTask }: ApiSequencePanelProps) {
  const [open, setOpen] = useState(false);
  const [heightPx, setHeightPx] = useState(340);
  const [activeId, setActiveId] = useState<string | null>(diagramIds[0] || null);
  const [sequences, setSequences] = useState<Record<string, ApiSequenceResponse>>({});
  const [loadingId, setLoadingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hoveredCall, setHoveredCall] = useState<number | null>(null);
  const [selectedCall, setSelectedCall] = useState<number | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!activeId || !diagramIds.includes(activeId)) setActiveId(diagramIds[0] || null);
  }, [diagramIds, activeId]);

  // Fetch on demand: the active flow, and every canvas flow so the selector can show names.
  useEffect(() => {
    let cancelled = false;
    const missing = diagramIds.filter((id) => !sequences[id]);
    if (!missing.length) return undefined;
    setError(null);
    setLoadingId(missing[0]);
    Promise.all(missing.map((id) => getApiSequence(id).then((s) => [id, s] as const)))
      .then((pairs) => {
        if (cancelled) return;
        setSequences((current) => ({ ...current, ...Object.fromEntries(pairs) }));
      })
      .catch((err) => {
        if (!cancelled) setError(err?.response?.data?.error || err?.message || 'Failed to load the API sequence');
      })
      .finally(() => {
        if (!cancelled) setLoadingId(null);
      });
    return () => {
      cancelled = true;
    };
  }, [diagramIds, sequences]);

  const sequence = activeId ? sequences[activeId] : undefined;
  const sectionIndex = activeId ? Math.max(diagramIds.indexOf(activeId), 0) : 0;

  useEffect(() => {
    setSelectedCall(null);
    setHoveredCall(null);
  }, [activeId]);

  const { rows, height } = useMemo(() => (sequence ? layout(sequence) : { rows: [] as Row[], height: 0 }), [sequence]);
  const columnX = useMemo(() => new Map((sequence?.participants || []).map((p, i) => [p.id, GUTTER + i * COL_W + COL_W / 2])), [sequence]);
  const width = GUTTER + (sequence?.participants.length || 0) * COL_W + 16;
  const calls = useMemo(() => (sequence ? allSteps(sequence).flatMap((s) => s.calls) : []), [sequence]);
  const callByNumber = useMemo(() => new Map(calls.map((c) => [c.number, c])), [calls]);

  // Canvas → sequence: a task selected on the BPMN canvas highlights its calls.
  const highlightedTask = useMemo(() => {
    if (!sequence || !highlightTaskName) return null;
    return allSteps(sequence).find((s) => norm(s.taskName) === norm(highlightTaskName)) || null;
  }, [sequence, highlightTaskName]);

  useEffect(() => {
    if (!highlightedTask || !open || !scrollRef.current) return;
    const band = rows.find((r) => r.kind === 'band' && r.step.taskId === highlightedTask.taskId);
    if (band) scrollRef.current.scrollTo({ top: Math.max(band.y - 40, 0), behavior: 'smooth' });
  }, [highlightedTask, open, rows]);

  const activeCall = (hoveredCall ?? selectedCall) !== null ? callByNumber.get((hoveredCall ?? selectedCall) as number) : undefined;
  const activeParticipants = new Set(activeCall ? [activeCall.from, activeCall.to] : []);
  const detailCall = selectedCall !== null ? callByNumber.get(selectedCall) : undefined;

  const selectCall = useCallback((call: ApiSequenceCall, step: ApiSequenceStep) => {
    setSelectedCall((current) => (current === call.number ? null : call.number));
    onFocusTask?.(step.taskName, sectionIndex);
  }, [onFocusTask, sectionIndex]);

  const mermaid = useMemo(() => (sequence ? toMermaid(sequence) : ''), [sequence]);
  const copyMermaid = async () => {
    try {
      await navigator.clipboard.writeText(mermaid);
      message.success('Mermaid sequence diagram copied');
    } catch {
      message.error('Could not copy to the clipboard');
    }
  };
  const downloadMermaid = () => {
    const blob = new Blob([mermaid], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${(sequence?.businessFlow || 'api-sequence').replace(/[^\w.-]+/g, '_')}.mmd`;
    a.click();
    URL.revokeObjectURL(url);
  };

  // Drag the top edge to resize.
  const startResize = (event: React.PointerEvent) => {
    const startY = event.clientY;
    const startHeight = heightPx;
    const parentHeight = panelRef.current?.parentElement?.clientHeight || 900;
    const move = (e: PointerEvent) => setHeightPx(Math.min(Math.max(startHeight + (startY - e.clientY), 180), parentHeight * 0.85));
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  if (!diagramIds.length) return null;

  const flowOptions = diagramIds.map((id, i) => ({ value: id, label: sequences[id]?.businessFlow || sequences[id]?.diagramName || `Flow ${i + 1}` }));

  const header = (
    <div className="flex items-center gap-2 border-0 border-t border-solid border-slate-200 bg-white px-3 py-1.5">
      <Button
        type="text"
        size="small"
        icon={open ? <DownOutlined /> : <UpOutlined />}
        onClick={() => setOpen((v) => !v)}
        className="font-medium text-slate-700"
        aria-expanded={open}
      >
        <NodeIndexOutlined className="text-slate-500" /> API sequence
      </Button>
      {diagramIds.length > 1 ? (
        diagramIds.length <= 3 ? (
          <Segmented size="small" value={activeId || undefined} options={flowOptions.map((o) => ({ ...o, label: truncate(o.label, 34) }))} onChange={(v) => setActiveId(String(v))} />
        ) : (
          <Select size="small" className="min-w-[260px]" value={activeId || undefined} options={flowOptions} onChange={setActiveId} />
        )
      ) : (
        <span className="truncate text-sm text-slate-600">{sequence?.businessFlow || ''}</span>
      )}
      {sequence ? (
        <span className="whitespace-nowrap text-xs text-slate-500">
          {sequence.callCount} calls · {sequence.participants.length} applications · {sequence.taskCount} tasks
          {sequence.tasksWithoutApi ? ` · ${sequence.tasksWithoutApi} without an API` : ''}
        </span>
      ) : null}
      {loadingId ? <Spin size="small" /> : null}
      <div className="ml-auto flex items-center gap-1">
        <Tooltip title={sequence ? `${sequence.directionNote} ${sequence.dataObjectNote}` : ''} overlayStyle={{ maxWidth: 360 }}>
          <InfoCircleOutlined className="text-slate-400" />
        </Tooltip>
        <Tooltip title="Copy as a Mermaid sequence diagram (renders in Confluence, GitHub and Markdown)">
          <Button size="small" type="text" icon={<CopyOutlined />} disabled={!sequence} onClick={copyMermaid}>Mermaid</Button>
        </Tooltip>
        <Tooltip title="Download the Mermaid source (.mmd)">
          <Button size="small" type="text" icon={<DownloadOutlined />} disabled={!sequence} onClick={downloadMermaid} aria-label="Download Mermaid" />
        </Tooltip>
      </div>
    </div>
  );

  const renderBand = (row: Extract<Row, { kind: 'band' }>) => {
    const isHighlighted = highlightedTask?.taskId === row.step.taskId;
    const lines = wrap(row.step.taskName, 30);
    return (
      <g key={`band-${row.step.taskId}`}>
        <rect x={0} y={row.y} width={width} height={row.height} fill={isHighlighted ? COLOR.bandActive : row.band % 2 ? COLOR.bandB : COLOR.bandA} />
        {isHighlighted ? <rect x={0} y={row.y} width={3} height={row.height} fill={COLOR.active} /> : null}
        <g
          className="cursor-pointer"
          onClick={() => onFocusTask?.(row.step.taskName, sectionIndex)}
        >
          <title>{`${row.step.taskName}${row.step.lane ? ` — ${row.step.lane}` : ''} (click to select on the diagram)`}</title>
          {lines.map((line, i) => (
            <text key={i} x={14} y={row.y + BAND_PAD + 15 + i * 15} fontSize={12} fontWeight={500} fill={COLOR.ink}>{line}</text>
          ))}
          {row.step.lane ? (
            <text x={14} y={row.y + BAND_PAD + 15 + lines.length * 15} fontSize={11} fill={COLOR.inkMuted}>{truncate(row.step.lane, 34)}</text>
          ) : null}
          {!row.step.calls.length ? (
            <text x={GUTTER + 8} y={row.y + BAND_PAD + 22} fontSize={11} fill={COLOR.inkFaint}>No API recorded for this task</text>
          ) : null}
        </g>
      </g>
    );
  };

  const renderCall = (row: Extract<Row, { kind: 'call' }>) => {
    const { call } = row;
    const x1 = columnX.get(call.from) ?? GUTTER;
    const x2 = columnX.get(call.to) ?? GUTTER;
    const isActive = activeCall?.number === call.number || highlightedTask?.taskId === row.step.taskId;
    const stroke = isActive ? COLOR.active : call.internal ? COLOR.internal : COLOR.arrow;
    const lineY = row.y + 28;
    const label = `${call.number}  ${call.method} ${shortEndpoint(call.endpoint) || call.id}`;
    const objects = truncate(objectSummary(call, sequence!.dataObjects), 44);
    const mid = call.internal ? x1 + 40 : (x1 + x2) / 2;
    // Keep labels inside the plot.
    const labelX = Math.min(Math.max(mid, GUTTER + 120), width - 130);
    return (
      <g
        key={`call-${call.number}`}
        className="cursor-pointer"
        onMouseEnter={() => setHoveredCall(call.number)}
        onMouseLeave={() => setHoveredCall(null)}
        onClick={() => selectCall(call, row.step)}
      >
        <rect x={GUTTER} y={row.y} width={width - GUTTER} height={CALL_H} fill="transparent" />
        {call.internal ? (
          <path d={`M${x1},${lineY - 6} h26 v12 h-22`} fill="none" stroke={stroke} strokeWidth={isActive ? 2 : 1.5} markerEnd={`url(#seq-arrow-${isActive ? 'active' : 'internal'})`} />
        ) : (
          <line x1={x1} y1={lineY} x2={x2 + (x2 > x1 ? -4 : 4)} y2={lineY} stroke={stroke} strokeWidth={isActive ? 2 : 1.5} markerEnd={`url(#seq-arrow-${isActive ? 'active' : 'default'})`} />
        )}
        <text x={labelX} y={lineY - 7} textAnchor="middle" fontSize={11} fill={isActive ? COLOR.active : COLOR.ink} fontWeight={isActive ? 600 : 400}>{label}</text>
        {objects ? <text x={labelX} y={lineY + 14} textAnchor="middle" fontSize={10.5} fill={COLOR.inkMuted}>{objects}</text> : null}
      </g>
    );
  };

  const renderFragment = (row: Extract<Row, { kind: 'fragment' }>) => (
    <g key={`frag-${row.y}`} pointerEvents="none">
      <rect x={GUTTER + 2} y={row.y + 2} width={width - GUTTER - 12} height={row.height - 2} fill="none" stroke={COLOR.fragment} strokeWidth={1.2} rx={4} />
      <rect x={GUTTER + 2} y={row.y + 2} width={34} height={16} fill={COLOR.fragment} rx={3} />
      <text x={GUTTER + 19} y={row.y + 14} textAnchor="middle" fontSize={10} fontWeight={600} fill="#ffffff">{row.fragment.type}</text>
      {row.separators.map((sep, i) => (
        <g key={i}>
          {i > 0 ? <line x1={GUTTER + 2} x2={width - 10} y1={sep.y} y2={sep.y} stroke={COLOR.fragment} strokeDasharray="5 4" /> : null}
          <text x={GUTTER + (i === 0 ? 42 : 8)} y={sep.y + 14} fontSize={11} fill={COLOR.fragment}>
            {i === 0 ? `${row.fragment.label}: [${sep.label}]` : `[${sep.label}]`}
          </text>
        </g>
      ))}
    </g>
  );

  const body = (
    <div className="flex min-h-0 flex-1">
      <div ref={scrollRef} className="relative min-h-0 min-w-0 flex-1 overflow-auto">
        {error ? <Alert type="error" showIcon message={error} className="m-3" /> : null}
        {!sequence && !error ? <div className="flex h-full items-center justify-center"><Spin /></div> : null}
        {sequence && !sequence.callCount ? <Empty className="mt-6" description="No APIs are recorded for this flow's tasks" /> : null}
        {sequence && sequence.callCount ? (
          <>
            {/* The task column stays put (sticky left) while the lifelines scroll; same for the header corner. */}
            <div className="sticky top-0 z-[2] flex bg-white" style={{ width }}>
              <svg width={GUTTER} height={HEADER_H} role="presentation" className="sticky left-0 z-[1] shrink-0 bg-white">
                <text x={14} y={HEADER_H - 14} fontSize={11} fill={COLOR.inkMuted}>Task · lane</text>
              </svg>
              <svg width={width - GUTTER} height={HEADER_H} viewBox={`${GUTTER} 0 ${width - GUTTER} ${HEADER_H}`} role="presentation" className="shrink-0">
                {sequence.participants.map((p) => {
                  const x = columnX.get(p.id)!;
                  const isActive = activeParticipants.has(p.id);
                  return (
                    <g key={p.id}>
                      <title>{`${p.acronym}${p.name ? ` — ${p.name}` : ''}${p.domain ? `\n${p.domain}` : ''}${p.criticality ? ` · ${p.criticality}` : ''}`}</title>
                      <rect
                        x={x - COL_W / 2 + 10}
                        y={6}
                        width={COL_W - 20}
                        height={HEADER_H - 12}
                        rx={6}
                        fill={isActive ? '#dbeafe' : COLOR.headerFill}
                        stroke={isActive ? COLOR.active : COLOR.headerStroke}
                        strokeDasharray={p.unassigned ? '4 3' : undefined}
                      />
                      <text x={x} y={23} textAnchor="middle" fontSize={12} fontWeight={600} fill={p.unassigned ? COLOR.inkMuted : COLOR.ink}>{truncate(p.acronym, 18)}</text>
                      <text x={x} y={37} textAnchor="middle" fontSize={10} fill={COLOR.inkMuted}>{truncate(p.domain || p.name, 24)}</text>
                    </g>
                  );
                })}
              </svg>
            </div>
            <div className="flex" style={{ width }}>
            <svg width={GUTTER} height={height} role="presentation" className="sticky left-0 z-[1] shrink-0">
              {rows.filter((r): r is Extract<Row, { kind: 'band' }> => r.kind === 'band').map(renderBand)}
              <line x1={GUTTER - 0.5} x2={GUTTER - 0.5} y1={0} y2={height} stroke={COLOR.lifeline} />
            </svg>
            <svg width={width - GUTTER} height={height} viewBox={`${GUTTER} 0 ${width - GUTTER} ${height}`} role="img" aria-label={`API sequence for ${sequence.businessFlow}`} className="shrink-0">
              <defs>
                {(['default', 'active', 'internal'] as const).map((kind) => (
                  <marker key={kind} id={`seq-arrow-${kind}`} viewBox="0 0 10 10" refX={9} refY={5} markerWidth={7} markerHeight={7} orient="auto-start-reverse">
                    <path d="M0,0 L10,5 L0,10 z" fill={kind === 'active' ? COLOR.active : kind === 'internal' ? COLOR.internal : COLOR.arrow} />
                  </marker>
                ))}
              </defs>
              {rows.filter((r): r is Extract<Row, { kind: 'band' }> => r.kind === 'band').map(renderBand)}
              {sequence.participants.map((p) => (
                <line key={p.id} x1={columnX.get(p.id)} x2={columnX.get(p.id)} y1={0} y2={height} stroke={activeParticipants.has(p.id) ? COLOR.active : COLOR.lifeline} strokeDasharray="4 4" />
              ))}
              {rows.filter((r): r is Extract<Row, { kind: 'fragment' }> => r.kind === 'fragment').map(renderFragment)}
              {rows.filter((r): r is Extract<Row, { kind: 'call' }> => r.kind === 'call').map(renderCall)}
            </svg>
            </div>
          </>
        ) : null}
      </div>
      {detailCall && sequence ? (
        <CallDetails call={detailCall} sequence={sequence} onClose={() => setSelectedCall(null)} />
      ) : null}
    </div>
  );

  return (
    <div ref={panelRef} className="flex shrink-0 flex-col bg-white" style={open ? { height: heightPx } : undefined}>
      {open ? (
        <div
          role="separator"
          aria-orientation="horizontal"
          aria-label="Resize the API sequence panel"
          onPointerDown={startResize}
          className="h-1.5 cursor-row-resize bg-slate-100 hover:bg-blue-200"
        />
      ) : null}
      {header}
      {open ? body : null}
    </div>
  );
}

function CallDetails({ call, sequence, onClose }: { call: ApiSequenceCall; sequence: ApiSequenceResponse; onClose: () => void }) {
  const byId = new Map(sequence.participants.map((p) => [p.id, p]));
  const from = byId.get(call.from);
  const to = byId.get(call.to);
  const host = sequence.hosts[call.host];
  const request = sequence.dataObjects[call.requestObject];
  const response = sequence.dataObjects[call.responseObject];
  const row = (label: string, value: React.ReactNode) => (
    <div className="flex gap-2 py-0.5">
      <span className="w-20 shrink-0 text-slate-500">{label}</span>
      <span className="min-w-0 break-words text-slate-800">{value || '—'}</span>
    </div>
  );
  return (
    <div className="w-[320px] shrink-0 overflow-auto border-0 border-l border-solid border-slate-200 p-3 text-xs">
      <div className="mb-2 flex items-start justify-between gap-2">
        <div>
          <div className="text-slate-500">Call {call.number}</div>
          <div className="text-sm font-semibold text-slate-900">{call.name}</div>
        </div>
        <Button size="small" type="text" onClick={onClose} aria-label="Close call details">✕</Button>
      </div>
      {row('API', <span className="font-mono">{call.id}</span>)}
      {row('Request', <span><Tag className="m-0 mr-1">{call.method}</Tag><span className="font-mono">{call.endpoint}</span></span>)}
      {row('Type', `${call.type}${call.lifecycle ? ` · ${call.lifecycle}` : ''}`)}
      {row('From', from ? `${from.acronym} (provider)` : call.from)}
      {row('To', call.internal ? 'Same application (internal)' : to ? `${to.acronym} (consumer)` : call.to)}
      {row('Host', host ? `${host.name} · ${host.role}${host.city ? ` · ${host.city}` : ''}` : call.host)}
      {row('Sends', request ? <DataObjectTag object={request} /> : <span className="text-slate-400">No request body</span>)}
      {row('Returns', response ? <DataObjectTag object={response} /> : null)}
      <div className="mt-2 text-[11px] leading-snug text-slate-400">Host servers are derived and data objects are generated (illustrative). Hover a data object to see its fields.</div>
    </div>
  );
}
