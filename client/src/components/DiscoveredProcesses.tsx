import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, Button, Empty, Spin, Table, Tag, Tooltip } from 'antd';
import {
  DownloadOutlined, ExpandOutlined, LinkOutlined, ReloadOutlined, ZoomInOutlined, ZoomOutOutlined,
  RadarChartOutlined, PartitionOutlined,
} from '@ant-design/icons';
import BpmnEditor from './BpmnEditor';
import type { BpmnEditorHandle } from './BpmnEditor';
import { getDiscoveredProcesses } from '../api';
import type { ApplicationItem, DiscoveredProcess, DiscoveredProcessesResponse } from '../types';

/**
 * Business Processes › Discovered Processes.
 *
 * A process is "discovered" when production telemetry (OpenTelemetry traces in
 * Grafana Tempo) carries a bpmn.process.name that has no diagram in BPMN IQ.
 * The server rebuilds its BPMN 2.0 model from the spans
 * (GET /api/discovered-processes); this view shows it on the same canvas as
 * the Processes tab, with the evidence it was rebuilt from.
 */

const GRAFANA_URL = (import.meta.env.VITE_GRAFANA_URL as string | undefined) || 'http://localhost:3000';

interface DiscoveredProcessesProps {
  allApplications?: ApplicationItem[];
}

const MATCH_LABEL: Record<string, string> = { diagramId: 'diagram id', processId: 'BPMN process id', name: 'name' };

const formatDuration = (ms: number) => (ms >= 60000 ? `${(ms / 60000).toFixed(1)} min` : ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${ms} ms`);
const formatWhen = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : '—');

function grafanaTracesUrl(flowName: string) {
  const left = {
    datasource: 'tempo',
    queries: [{ refId: 'A', datasource: { type: 'tempo', uid: 'tempo' }, queryType: 'traceql', query: `{ name =~ "process .*" && span.bpmn.process.name = "${flowName.replace(/"/g, '\\"')}" }` }],
    range: { from: 'now-24h', to: 'now' },
  };
  return `${GRAFANA_URL}/explore?orgId=1&left=${encodeURIComponent(JSON.stringify(left))}`;
}

export default function DiscoveredProcesses({ allApplications }: DiscoveredProcessesProps) {
  const [data, setData] = useState<DiscoveredProcessesResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedName, setSelectedName] = useState<string | null>(null);
  const [importTrigger, setImportTrigger] = useState(0);
  const editorRef = useRef<BpmnEditorHandle>(null);

  const load = useCallback(async (fresh = false) => {
    setLoading(true);
    setError(null);
    try {
      const response = await getDiscoveredProcesses(fresh);
      setData(response);
      setSelectedName((current) => (current && response.discovered.some((p) => p.name === current) ? current : response.discovered[0]?.name || null));
      setImportTrigger((t) => t + 1);
    } catch (err: any) {
      setError(err?.response?.data?.error || err?.message || 'Failed to load discovered processes');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(false);
  }, [load]);

  const selected: DiscoveredProcess | undefined = data?.discovered.find((p) => p.name === selectedName);

  const downloadXml = () => {
    if (!selected) return;
    const blob = new Blob([selected.xml], { type: 'application/xml' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${selected.name.replace(/[^\w.-]+/g, '_')}.bpmn`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const ribbon = [
    {
      key: 'discovery',
      title: 'Discover',
      actions: [
        { key: 'refresh', tooltip: 'Re-run discovery from the latest traces', icon: <ReloadOutlined />, onClick: () => void load(true) },
        { key: 'traces', tooltip: 'Open this process\'s traces in Grafana', icon: <LinkOutlined />, onClick: () => selected && window.open(grafanaTracesUrl(selected.name), '_blank', 'noopener'), disabled: !selected },
      ],
    },
    {
      key: 'file',
      title: 'File',
      actions: [{ key: 'download', tooltip: 'Download the discovered BPMN 2.0 file', icon: <DownloadOutlined />, onClick: downloadXml, disabled: !selected }],
    },
    {
      key: 'view',
      title: 'View',
      actions: [
        { key: 'zoom-in', tooltip: 'Zoom in', icon: <ZoomInOutlined />, onClick: () => editorRef.current?.zoomIn() },
        { key: 'zoom-out', tooltip: 'Zoom out', icon: <ZoomOutOutlined />, onClick: () => editorRef.current?.zoomOut() },
        { key: 'fit', tooltip: 'Fit the whole process to the screen', icon: <ExpandOutlined />, onClick: () => editorRef.current?.fitAll() },
      ],
    },
  ];

  const outcomeTags = selected ? Object.entries(selected.outcomes).sort((a, b) => b[1] - a[1]).map(([outcome, count]) => (
    <Tag key={outcome} color={outcome === 'completed' ? 'green' : outcome === 'abandoned' ? 'orange' : 'red'} className="m-0">{count} {outcome}</Tag>
  )) : null;

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
        <div className="w-[380px] shrink-0 min-h-0 overflow-y-auto border-0 border-r border-solid border-slate-200 bg-white p-3">
          <div className="mb-2 flex items-center justify-between">
            <div className="flex items-center gap-2 text-[15px] font-semibold text-slate-800">
              <RadarChartOutlined className="text-blue-600" /> Discovered Processes
            </div>
            {loading ? <Spin size="small" /> : null}
          </div>
          <div className="mb-3 text-xs leading-snug text-slate-500">
            Running in production but not modeled in BPMN IQ — rebuilt from OpenTelemetry traces.
            {data ? <> Observed {data.observedFlows.length} flows in the last {data.lookbackHours} h; {data.documentedFlowsObserved.length} already have diagrams.</> : null}
          </div>

          {data?.matches?.some((m) => m.documented) ? (
            <div className="mb-3 rounded-md border border-solid border-slate-200 bg-slate-50 px-2.5 py-2 text-xs">
              <div className="mb-1 font-semibold uppercase tracking-wide text-[10px] text-slate-500">Already modeled</div>
              {data.matches.filter((m) => m.documented).map((m) => (
                <div key={m.name} className="flex items-baseline justify-between gap-2 py-0.5">
                  <span className="truncate text-slate-700">{m.name}</span>
                  <Tooltip title={m.diagram ? `Matches diagram "${m.diagram.name}" (${m.diagram.id})` : ''}>
                    <span className="shrink-0 text-slate-500">by {MATCH_LABEL[m.matchedBy || ''] || m.matchedBy}</span>
                  </Tooltip>
                </div>
              ))}
            </div>
          ) : null}

          {error ? <Alert type="error" showIcon message="Discovery unavailable" description={error} className="mb-3" /> : null}
          {data && !data.discovered.length ? (
            <Empty description="No undiscovered processes: every flow seen in the traces already has a diagram." />
          ) : null}

          {data?.discovered.map((process) => {
            const isSelected = process.name === selectedName;
            return (
              <button
                key={process.name}
                type="button"
                onClick={() => { setSelectedName(process.name); setImportTrigger((t) => t + 1); }}
                className={`diagram-tile mb-3 w-full min-w-0 p-3 text-left ${isSelected ? 'diagram-tile-selected' : ''}`}
              >
                <div className="flex items-center gap-2 text-[14px] font-semibold text-slate-900">
                  <PartitionOutlined /> {process.name}
                </div>
                <div className="mt-1.5 flex flex-wrap gap-1">
                  <Tag color="purple" className="m-0">Discovered</Tag>
                  <Tag className="m-0">{process.instancesAnalyzed} instances</Tag>
                  <Tag className="m-0">{process.tasks.length} tasks</Tag>
                  <Tag className="m-0">{process.applications.length} apps</Tag>
                </div>
                <div className="mt-1.5 truncate text-xs text-slate-600">{process.domain} | {process.subdomain}</div>
              </button>
            );
          })}

          {selected ? (
            <div className="text-xs text-slate-700">
              <div className="mb-1 font-semibold uppercase tracking-wide text-[10px] text-slate-500">Evidence</div>
              <div className="mb-2 grid grid-cols-[96px_1fr] gap-y-1">
                <span className="text-slate-500">Process id</span><span className="font-mono break-all">{selected.processId}</span>
                <span className="text-slate-500">Why new</span>
                <span>
                  No BPMN IQ diagram matches its diagram id, process id or name.
                  {selected.matchNotes?.length ? <span className="block text-slate-500">{selected.matchNotes.join('; ')}</span> : null}
                </span>
                <span className="text-slate-500">Outcomes</span><span className="flex flex-wrap gap-1">{outcomeTags}</span>
                <span className="text-slate-500">Completion</span><span>{Math.round(selected.completionRate * 100)}%</span>
                <span className="text-slate-500">First seen</span><span>{formatWhen(selected.firstSeen)}</span>
                <span className="text-slate-500">Last seen</span><span>{formatWhen(selected.lastSeen)}</span>
                <span className="text-slate-500">Lanes</span><span>{selected.lanes.map((l) => l.name).join(', ')}</span>
                <span className="text-slate-500">Applications</span><span>{selected.applications.join(', ')}</span>
              </div>
              <div className="mb-1 font-semibold uppercase tracking-wide text-[10px] text-slate-500">Observed tasks</div>
              <Table
                size="small"
                pagination={false}
                rowKey="id"
                dataSource={selected.tasks}
                columns={[
                  { title: 'Task', dataIndex: 'name', render: (name: string, task) => <Tooltip title={`${task.lane} · ${task.applications.join(', ')} · ${task.apis.map((a) => `${a.method} ${a.route}`).join('; ')}`}><span>{name}</span></Tooltip> },
                  { title: 'Seen', dataIndex: 'observedCount', width: 52, align: 'right' as const },
                  { title: 'Median', dataIndex: 'medianDurationMs', width: 72, align: 'right' as const, render: (ms: number) => formatDuration(ms) },
                ]}
              />
              <div className="mt-2 text-[11px] leading-snug text-slate-400">
                {data?.note} &quot;Seen&quot; drops where customers declined or abandoned the offer. Edits on the canvas are not saved.
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
              diagramBreadcrumb={`${selected.domain} | ${selected.subdomain} | ${selected.name}`}
              diagramStatus="discovered"
            />
          ) : (
            <div className="flex h-full items-center justify-center bg-slate-50">
              {loading ? <Spin /> : <Empty description="No discovered process selected" />}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
