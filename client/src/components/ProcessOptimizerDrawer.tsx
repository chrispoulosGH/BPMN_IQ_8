import { Collapse, Drawer, Empty, Tag, Typography } from 'antd';
import { MinusCircleOutlined, PlusCircleOutlined, RobotOutlined, SwapOutlined } from '@ant-design/icons';
import type { ProcessOptimizationProposal, ProcessOptimizerTaskDiffEntry } from '../types';

const { Text, Paragraph } = Typography;

interface ProcessOptimizerDrawerProps {
  open: boolean;
  onClose: () => void;
  proposal: ProcessOptimizationProposal | null;
}

const OP_META: Record<ProcessOptimizerTaskDiffEntry['op'], { label: string; color: string; icon: React.ReactNode }> = {
  remove: { label: 'Remove step', color: 'red', icon: <MinusCircleOutlined /> },
  retarget_application: { label: 'Retarget application', color: 'blue', icon: <SwapOutlined /> },
  add: { label: 'Add step', color: 'green', icon: <PlusCircleOutlined /> },
  rename: { label: 'Rename', color: 'default', icon: <SwapOutlined /> },
};

function fmtDelta(n: number | undefined, unit: string): string | null {
  if (!n) return null;
  const sign = n > 0 ? '+' : '';
  return `${sign}${n.toLocaleString()}${unit}`;
}

/**
 * Shows one ProcessOptimizationProposal — the result of running a business
 * flow through server/services/processOptimizerAgent.js. Purely a report of
 * what the agent found; nothing here ever edits the diagram (see the
 * model's own doc comment — that stays a deliberate, separate step for a
 * human to take later).
 */
export default function ProcessOptimizerDrawer({ open, onClose, proposal }: ProcessOptimizerDrawerProps) {
  return (
    <Drawer
      title={(
        <div className="flex items-center gap-2">
          <RobotOutlined />
          <span>Process Optimizer{proposal?.diagramName ? ` — ${proposal.diagramName}` : ''}</span>
        </div>
      )}
      open={open}
      onClose={onClose}
      width={460}
    >
      {!proposal ? (
        <Empty description="No analysis yet." />
      ) : (
        <div className="flex flex-col gap-4">
          <div className="flex flex-wrap items-center gap-2">
            {typeof proposal.confidence === 'number' && (
              <Tag color={proposal.confidence >= 70 ? 'green' : proposal.confidence >= 40 ? 'gold' : 'default'}>
                {proposal.confidence}% confidence
              </Tag>
            )}
            {proposal.model && <Tag>{proposal.model}</Tag>}
            <Text type="secondary" className="text-xs">{new Date(proposal.createdAt).toLocaleString()}</Text>
          </div>

          <Paragraph className="!mb-0 text-sm">{proposal.summary}</Paragraph>

          {proposal.rationale.length > 0 && (
            <div>
              <div className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-slate-500">Rationale</div>
              <ul className="flex list-disc flex-col gap-1.5 pl-4 text-sm text-slate-700">
                {proposal.rationale.map((r, i) => <li key={i}>{r}</li>)}
              </ul>
            </div>
          )}

          <div>
            <div className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-slate-500">
              Proposed changes {proposal.taskDiff.length > 0 && `(${proposal.taskDiff.length})`}
            </div>
            {proposal.taskDiff.length === 0 ? (
              <Empty
                image={Empty.PRESENTED_IMAGE_SIMPLE}
                description="No changes proposed — this flow was reviewed and no eliminable waste was found."
              />
            ) : (
              <div className="flex flex-col gap-2">
                {proposal.taskDiff.map((entry, i) => {
                  const meta = OP_META[entry.op] || OP_META.rename;
                  return (
                    <div key={i} className="rounded-lg border border-slate-200 bg-slate-50 p-2.5">
                      <div className="flex items-center gap-2">
                        <Tag icon={meta.icon} color={meta.color} className="!m-0">{meta.label}</Tag>
                        {entry.taskName && <span className="text-sm font-medium text-slate-800">{entry.taskName}</span>}
                      </div>
                      {entry.actor && <div className="mt-1 text-xs text-slate-500">Actor: {entry.actor}</div>}
                      {entry.detail && Object.keys(entry.detail).length > 0 && (
                        <div className="mt-1 text-xs text-slate-500">
                          {Object.entries(entry.detail).map(([k, v]) => (
                            <div key={k}><span className="font-medium">{k}:</span> {String(v)}</div>
                          ))}
                        </div>
                      )}
                      <div className="mt-1.5 text-xs text-slate-600">{entry.reason}</div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {(proposal.projectedImpact.costDeltaUsd || proposal.projectedImpact.securityRiskDelta || proposal.projectedImpact.defectRiskDelta || proposal.projectedImpact.jiraActivityDelta) ? (
            <div>
              <div className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-slate-500">Agent's own impact estimate</div>
              <div className="flex flex-wrap gap-1.5">
                {fmtDelta(proposal.projectedImpact.costDeltaUsd, ' cost') && <Tag>{fmtDelta(proposal.projectedImpact.costDeltaUsd, ' cost')}</Tag>}
                {fmtDelta(proposal.projectedImpact.securityRiskDelta, '% security risk') && <Tag>{fmtDelta(proposal.projectedImpact.securityRiskDelta, '% security risk')}</Tag>}
                {fmtDelta(proposal.projectedImpact.defectRiskDelta, '% defect risk') && <Tag>{fmtDelta(proposal.projectedImpact.defectRiskDelta, '% defect risk')}</Tag>}
                {fmtDelta(proposal.projectedImpact.jiraActivityDelta, ' Jira issues') && <Tag>{fmtDelta(proposal.projectedImpact.jiraActivityDelta, ' Jira issues')}</Tag>}
              </div>
            </div>
          ) : null}

          {proposal.toolCallLog && proposal.toolCallLog.length > 0 && (
            <Collapse
              ghost
              size="small"
              items={[{
                key: 'log',
                label: <span className="text-xs text-slate-500">Agent's investigation ({proposal.toolCallLog.length} tool calls)</span>,
                children: (
                  <div className="flex max-h-64 flex-col gap-1.5 overflow-y-auto text-xs">
                    {proposal.toolCallLog.map((call, i) => (
                      <div key={i} className="rounded border border-slate-100 bg-slate-50 p-1.5">
                        <div className="font-mono font-medium text-slate-700">{call.tool}</div>
                        <div className="truncate text-slate-500">{JSON.stringify(call.args)}</div>
                      </div>
                    ))}
                  </div>
                ),
              }]}
            />
          )}

          <Text type="secondary" className="text-xs">
            This is advisory only — nothing on the canvas has been changed. A human still decides whether to act on it.
          </Text>
        </div>
      )}
    </Drawer>
  );
}
