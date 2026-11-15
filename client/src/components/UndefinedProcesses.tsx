import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, Button, Collapse, Empty, Segmented, Spin, Table, Tag, Tooltip } from 'antd';
import {
  DownloadOutlined, ExpandOutlined, LinkOutlined, QuestionCircleOutlined, ReloadOutlined, ZoomInOutlined, ZoomOutOutlined, PartitionOutlined,
} from '@ant-design/icons';
import BpmnEditor from './BpmnEditor';
import type { BpmnEditorHandle } from './BpmnEditor';
import { getUndefinedProcesses } from '../api';
import type { ApplicationItem, UndefinedProcess, UndefinedProcessesResponse } from '../types';

/**
 * Business Processes › Undefined Processes.
 *
 * Traffic that carries NO business context (no bpmn.* baggage — an empty
 * header, or users working outside the modeled flows) is grouped into cases by
 * session.id, mapped to the API catalog, and compared with every established
 * flow (GET /api/undefined-processes):
 *   - an exact match is that flow, run without business context;
 *   - a close match is that flow with deviations (skipped, reordered, repeated steps);
 *   - anything else is clustered into an undefined process, rebuilt as BPMN.
 * Same canvas and layout as Discovered Processes.
 */

const GRAFANA_URL = (import.meta.env.VITE_GRAFANA_URL as string | undefined) || 'http://localhost:3000';
const DEVIATION_LABEL: Record<string, string> = { missing: 'skipped', 'out-of-order': 'out of order', repeated: 'repeated', extra: 'extra step' };

const formatGap = (ms: number) => (ms >= 60000 ? `${(ms / 60000).toFixed(1)} min` : ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : ms > 0 ? `${ms} ms` : '—');
const formatWhen = (iso: string) => new Date(iso).toLocaleString();

function grafanaSessionUrl(sessionId: string) {
  const left = {
    datasource: 'tempo',
    queries: [{ refId: 'A', datasource: { type: 'tempo', uid: 'tempo' }, queryType: 'traceql', query: `{ span.session.id = "${sessionId}" }` }],
    range: { from: 'now-24h', to: 'now' },
  };
  return `${GRAFANA_URL}/explore?orgId=1&left=${encodeURIComponent(JSON.stringify(left))}`;
}

interface UndefinedProcessesProps {
  allApplications?: ApplicationItem[];
  /** Open established flows on the Processes sub-tab. */
  onOpenBusinessFlows?: (flows: string[], label: string) => void;
}

export default function UndefinedProcesses({ allApplications, onOpenBusinessFlows }: UndefinedProcessesProps) {
  const [hours, setHours] = useState(6);
  const [data, setData] = useState<UndefinedProcessesResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [importTrigger, setImportTrigger] = useState(0);
  const editorRef = useRef<BpmnEditorHandle>(null);

  const load = useCallback(async (fresh = false) => {
    setLoading(true);
    setError(null);
    try {
      const response = await getUndefinedProcesses(fresh, hours);
      setData(response);
      setSelectedId((cur) => (cur && response.undefinedProcesses.some((p) => p.id === cur) ? cur : response.undefinedProcesses[0]?.id || null));
      setImportTrigger((t) => t + 1);
    } catch (err: any) {
      setError(err?.response?.data?.error || err?.message || 'Failed to load undefined processes');
    } finally {
      setLoading(false);
    }
  }, [hours]);

  useEffect(() => { void load(false); }, [load]);

  const selected: UndefinedProcess | undefined = data?.undefinedProcesses.find((p) => p.id === selectedId);

  const downloadXml = () => {
    if (!selected) return;
    const url = URL.createObjectURL(new Blob([selected.xml], { type: 'application/xml' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `${selected.processId}.bpmn`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const ribbon = [
    {
      key: 'discovery', title: 'Discover', actions: [
        { key: 'refresh', tooltip: 'Re-analyse the latest untagged traffic', icon: <ReloadOutlined />, onClick: () => void load(true) },
        { key: 'traces', tooltip: 'Open a sample session\'s traces in Grafana', icon: <LinkOutlined />, onClick: () => selected?.sampleSessions[0] && window.open(grafanaSessionUrl(selected.sampleSessions[0]), '_blank', 'noopener'), disabled: !selected?.sampleSessions.length },
      ],
    },
    { key: 'file', title: 'File', actions: [{ key: 'download', tooltip: 'Download the inferred BPMN 2.0 file', icon: <DownloadOutlined />, onClick: downloadXml, disabled: !selected }] },
    {
      key: 'view', title: 'View', actions: [
        { key: 'zoom-in', tooltip: 'Zoom in', icon: <ZoomInOutlined />, onClick: () => editorRef.current?.zoomIn() },
        { key: 'zoom-out', tooltip: 'Zoom out', icon: <ZoomOutOutlined />, onClick: () => editorRef.current?.zoomOut() },
        { key: 'fit', tooltip: 'Fit the whole process to the screen', icon: <ExpandOutlined />, onClick: () => editorRef.current?.fitAll() },
      ],
    },
  ];

  const s = data?.sessions;

  return (
    <div className="flex h-full w-full min-h-0">
      <div className="bpmn-ribbon w-[92px] shrink-0 px-2 py-3 overflow-y-auto">
        <div className="flex flex-col gap-3">
          {ribbon.map((group) => (
            <div key={group.key} className="bpmn-ribbon-group px-2 py-2">
              <div className="bpmn-ribbon-title mb-2 text-center text-[10px] font-semibold uppercase tracking-[0.14em]">{group.title}</div>
              <div className="flex flex-col items-center gap-1.5">
                {group.actions.map((action) => (
                  <Tooltip key={action.key} title={action.tooltip} placement="right">
                    <Button
                      type="text"
                      icon={action.icon}
                      onClick={action.onClick}
                      disabled={(action as { disabled?: boolean }).disabled}
                      className="bpmn-ribbon-btn flex h-9 w-9 items-center justify-center rounded-lg border-0"
                      aria-label={action.tooltip}
                    />
                  </Tooltip>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="flex min-h-0 flex-1 min-w-0">
        <div className="w-[400px] shrink-0 min-h-0 overflow-y-auto border-0 border-r border-solid border-slate-200 bg-white p-3">
          <div className="mb-2 flex items-center justify-between gap-2">
            <div className="flex items-center gap-2 text-[15px] font-semibold text-slate-800">
              <QuestionCircleOutlined className="text-amber-600" /> Undefined Processes
            </div>
            {loading ? <Spin size="small" /> : null}
            <Segmented size="small" value={hours} onChange={(v) => setHours(Number(v))} options={[{ label: '6 h', value: 6 }, { label: '24 h', value: 24 }, { label: '7 d', value: 168 }]} />
          </div>
          <div className="mb-3 text-xs leading-snug text-slate-500">
            Traffic with <b>no business context</b> (no process/task baggage), grouped into cases by <code>{data?.caseIdAttribute || 'session.id'}</code> and compared with every established flow by its sequence of applications and APIs.
          </div>

          {error ? <Alert type="error" showIcon message="Analysis unavailable" description={error} className="mb-3" /> : null}

          {s ? (
            <div className="mb-3 rounded-md border border-solid border-slate-200 bg-slate-50 px-2.5 py-2 text-xs">
              <div className="mb-1.5 font-semibold uppercase tracking-wide text-[10px] text-slate-500">Untagged sessions, last {hours >= 168 ? '7 days' : `${hours} h`}</div>
              <div className="flex flex-wrap gap-1">
                <Tag className="m-0">{s.analysed} analysed</Tag>
                <Tag color="green" className="m-0">{s.conformant} match an established flow</Tag>
                <Tag color="gold" className="m-0">{s.deviating} established, with deviations</Tag>
                <Tag color="orange" className="m-0">{s.undefined} undefined</Tag>
                {s.inProgress ? <Tag className="m-0">{s.inProgress} still in progress</Tag> : null}
              </div>
              {data?.matched.length ? (
                <Collapse
                  ghost
                  size="small"
                  className="mt-1 [&_.ant-collapse-header]:!px-0 [&_.ant-collapse-content-box]:!px-0"
                  items={[{
                    key: 'matched',
                    label: <span className="text-slate-600">Accounted to {data.matched.length} established flows</span>,
                    children: (
                      <div className="max-h-[260px] overflow-y-auto">
                        {data.matched.map((m) => (
                          <div key={m.flow} className="border-0 border-b border-solid border-slate-100 py-1">
                            <div className="flex items-baseline justify-between gap-2">
                              <button type="button" className="truncate border-0 bg-transparent p-0 text-left text-blue-700 hover:underline" onClick={() => onOpenBusinessFlows?.([m.flow], m.flow)}>{m.flow}</button>
                              <span className="shrink-0 text-slate-500">{m.conformant} exact · {m.deviating} deviating</span>
                            </div>
                            {m.deviations.length ? (
                              <div className="text-[11px] text-slate-500">
                                {m.deviations.slice(0, 3).map((d) => `${d.task} ${DEVIATION_LABEL[d.type] || d.type}${d.count > 1 ? ` ×${d.count}` : ''}`).join(' · ')}
                              </div>
                            ) : null}
                          </div>
                        ))}
                      </div>
                    ),
                  }]}
                />
              ) : null}
            </div>
          ) : null}

          {data && !data.undefinedProcesses.length ? (
            <Empty description="No undefined processes: every untagged session matched an established flow." />
          ) : null}

          {data?.undefinedProcesses.map((process) => (
            <button
              key={process.id}
              type="button"
              onClick={() => { setSelectedId(process.id); setImportTrigger((t) => t + 1); }}
              className={`diagram-tile mb-3 w-full min-w-0 p-3 text-left ${process.id === selectedId ? 'diagram-tile-selected' : ''}`}
            >
              <div className="flex items-start gap-2 text-[14px] font-semibold text-slate-900">
                <PartitionOutlined className="mt-1" /> <span>{process.name}</span>
              </div>
              <div className="mt-1.5 flex flex-wrap gap-1">
                <Tag color="orange" className="m-0">Undefined</Tag>
                <Tag className="m-0">{process.instancesAnalyzed} sessions</Tag>
                <Tag className="m-0">{process.tasks.length} steps</Tag>
                <Tag className="m-0">{process.applications.length} apps</Tag>
                {process.variants.length > 1 ? <Tag className="m-0">{process.variants.length} variants</Tag> : null}
              </div>
              <div className="mt-1.5 truncate text-xs text-slate-600">{process.domain || 'Unknown domain'} | spans {process.sourceFlows.length} established flows</div>
            </button>
          ))}

          {selected ? (
            <div className="text-xs text-slate-700">
              <div className="mb-1 font-semibold uppercase tracking-wide text-[10px] text-slate-500">Evidence</div>
              <div className="mb-2 grid grid-cols-[96px_1fr] gap-y-1">
                <span className="text-slate-500">Why undefined</span>
                <span>
                  No established flow matches its sequence.
                  {selected.closest ? (
                    <> Closest: <button type="button" className="border-0 bg-transparent p-0 text-blue-700 hover:underline" onClick={() => onOpenBusinessFlows?.([selected.closest!.flow], selected.closest!.flow)}>{selected.closest.flow}</button> at {Math.round(selected.closest.score * 100)}% (needs {Math.round((data?.thresholds.deviation || 0.6) * 100)}%).</>
                  ) : null}
                </span>
                <span className="text-slate-500">Built from</span><span>{selected.sourceFlows.join(', ') || '—'}</span>
                <span className="text-slate-500">Sessions</span><span>{selected.instancesAnalyzed}{selected.variants.length > 1 ? ` in ${selected.variants.length} variants` : ''}</span>
                <span className="text-slate-500">First seen</span><span>{formatWhen(selected.firstSeen)}</span>
                <span className="text-slate-500">Last seen</span><span>{formatWhen(selected.lastSeen)}</span>
                <span className="text-slate-500">Applications</span><span>{selected.applications.join(', ')}</span>
              </div>
              <div className="mb-1 font-semibold uppercase tracking-wide text-[10px] text-slate-500">Observed steps</div>
              <Table
                size="small"
                pagination={false}
                rowKey="id"
                dataSource={selected.tasks}
                columns={[
                  {
                    title: 'Step',
                    dataIndex: 'name',
                    render: (name: string, t) => (
                      <Tooltip title={`${t.lane} · ${t.apis.map((a) => a.label).join('; ')}${t.sourceFlow ? ` · built for "${t.sourceFlow}"` : ''}`}>
                        <span>{name}</span>
                        <div className="text-[11px] text-slate-400">{t.lane}{t.sourceFlow ? ` · from ${t.sourceFlow}` : ''}</div>
                      </Tooltip>
                    ),
                  },
                  { title: 'Seen', dataIndex: 'observedCount', width: 52, align: 'right' as const },
                  { title: 'Gap', dataIndex: 'medianGapMs', width: 70, align: 'right' as const, render: (ms: number) => formatGap(ms) },
                ]}
              />
              <div className="mt-2 text-[11px] leading-snug text-slate-400">
                Lanes are the applications that served each step (untagged traffic carries no actor/lane). &quot;Gap&quot; is the median time since the previous step. {data?.note} Edits on the canvas are not saved.
              </div>
            </div>
          ) : null}
        </div>

        <div className="min-h-0 min-w-0 flex-1">
          {selected ? (
            <BpmnEditor
              ref={editorRef}
              xml={selected.xml}
              importTrigger={importTrigger}
              allApplications={allApplications}
              diagramName={selected.name}
              diagramBreadcrumb={`${selected.domain || 'Unknown domain'} | ${selected.subdomain}`}
              diagramStatus="undefined"
            />
          ) : (
            <div className="flex h-full items-center justify-center bg-slate-50">
              {loading ? <Spin /> : <Empty description="No undefined process selected" />}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
