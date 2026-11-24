import { useCallback, useEffect, useMemo, useState } from 'react';
import { Alert, Button, Empty, Segmented, Select, Spin, Table, Tag, Timeline, Tooltip } from 'antd';
import { ReloadOutlined, LoginOutlined, LogoutOutlined, EyeOutlined, EditOutlined, WarningOutlined, ThunderboltOutlined, LockOutlined } from '@ant-design/icons';
import type { ColumnsType } from 'antd/es/table';
import { getUserSessionDetail, getUserSessions, type UserActivityEvent, type UserSessionSummary, type UserSessionsResponse } from '../api';

/**
 * Admin only: who signed in, when, from where, and what they did in each
 * session. Data: server/services/activityLog.js (usersessions, useractivities).
 */

const PERIODS = [
  { label: '24 h', value: 1 },
  { label: '7 days', value: 7 },
  { label: '30 days', value: 30 },
  { label: '90 days', value: 90 },
];
const STATUS: Record<UserSessionSummary['status'], { color: string; label: string; hint: string }> = {
  active: { color: 'green', label: 'Active', hint: 'Did something in the last 15 minutes' },
  idle: { color: 'gold', label: 'Idle', hint: 'Still signed in, nothing in the last 15 minutes' },
  'signed out': { color: 'default', label: 'Signed out', hint: 'Signed out with the sign-out button' },
  expired: { color: 'default', label: 'Expired', hint: 'The 8-hour session ended without a sign-out' },
};
const KIND_FILTERS = [
  { label: 'All', value: 'all' },
  { label: 'Pages', value: 'view' },
  { label: 'Changes', value: 'change' },
  { label: 'Sign-in', value: 'auth' },
];

const fmtDateTime = (iso: string | null) => (iso ? new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '');
const fmtTime = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' });
function fmtDuration(ms: number) {
  const minutes = Math.round(ms / 60000);
  if (minutes < 1) return '< 1 min';
  if (minutes < 60) return `${minutes} min`;
  const h = Math.floor(minutes / 60);
  return `${h} h ${minutes % 60} min`;
}
function device(ua: string) {
  if (!ua) return '';
  const browser = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : /curl|node|axios/i.test(ua) ? 'Script' : 'Other';
  const os = /Windows/.test(ua) ? 'Windows' : /iPhone|iPad/.test(ua) ? 'iOS' : /Mac OS X/.test(ua) ? 'macOS' : /Android/.test(ua) ? 'Android' : /Linux/.test(ua) ? 'Linux' : '';
  return os ? `${browser} · ${os}` : browser;
}

function eventIcon(e: UserActivityEvent) {
  if (e.kind === 'auth') {
    if (e.action === 'Signed in') return <LoginOutlined style={{ color: '#16a34a' }} />;
    if (e.action === 'Signed out') return <LogoutOutlined style={{ color: '#64748b' }} />;
    return <LockOutlined style={{ color: '#64748b' }} />;
  }
  if (e.kind === 'change') return e.status && e.status >= 400 ? <WarningOutlined style={{ color: '#dc2626' }} /> : <EditOutlined style={{ color: '#2563eb' }} />;
  if (e.kind === 'view') return <EyeOutlined style={{ color: '#94a3b8' }} />;
  return <ThunderboltOutlined style={{ color: '#94a3b8' }} />;
}

function Kpi({ label, value, hint, tone }: { label: string; value: number | string; hint: string; tone?: 'alert' }) {
  return (
    <Tooltip title={hint}>
      <div className="rounded-lg border border-solid border-slate-200 bg-white px-4 py-3">
        <div className="text-xs text-slate-500">{label}</div>
        <div className={`mt-1 text-2xl font-semibold tabular-nums ${tone === 'alert' ? 'text-red-600' : 'text-slate-800'}`}>{value}</div>
      </div>
    </Tooltip>
  );
}

function SessionTimeline({ sessionId }: { sessionId: string }) {
  const [data, setData] = useState<{ session: UserSessionSummary; activities: UserActivityEvent[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [kind, setKind] = useState('all');

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    getUserSessionDetail(sessionId)
      .then((d) => { if (!cancelled) setData(d); })
      .catch((err) => { if (!cancelled) setError(err?.response?.data?.error || err?.message || 'Failed to load the session'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [sessionId]);

  const events = useMemo(() => (data?.activities || []).filter((e) => kind === 'all' || e.kind === kind), [data, kind]);

  if (error) return <Alert type="error" showIcon message={error} />;
  if (!data) return <div className="flex justify-center py-10"><Spin /></div>;
  const s = data.session;
  return (
    <div>
      <div className="mb-3 border-b border-solid border-slate-200 pb-3" style={{ borderWidth: '0 0 1px 0' }}>
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-base font-semibold text-slate-800">{s.displayName || s.userId}</span>
          {s.displayName && s.displayName !== s.userId ? <span className="text-xs text-slate-500">{s.userId}</span> : null}
          {s.role ? <Tag>{s.role}</Tag> : null}
          <Tooltip title={STATUS[s.status].hint}><Tag color={STATUS[s.status].color}>{STATUS[s.status].label}</Tag></Tooltip>
        </div>
        <div className="mt-1 text-xs leading-5 text-slate-500">
          Signed in {fmtDateTime(s.loginAt)}
          {s.logoutAt ? ` · signed out ${fmtDateTime(s.logoutAt)}` : ` · last active ${fmtDateTime(s.lastActivityAt)}`}
          {` · ${fmtDuration(s.durationMs)}`}
          <br />
          {[device(s.userAgent), s.ip, s.authMode === 'easyauth' ? 'Entra ID' : ''].filter(Boolean).join(' · ')}
        </div>
      </div>
      <div className="mb-3 flex items-center gap-2">
        <Segmented size="small" options={KIND_FILTERS} value={kind} onChange={(v) => setKind(String(v))} />
        <span className="text-xs text-slate-500">{events.length} of {data.activities.length} events</span>
        {loading ? <Spin size="small" /> : null}
      </div>
      {events.length ? (
        <Timeline
          items={events.map((e) => ({
            dot: eventIcon(e),
            children: (
              <div className="text-sm leading-5">
                <span className="mr-2 tabular-nums text-xs text-slate-400">{fmtTime(e.at)}</span>
                <span className="text-slate-800">{e.action}</span>
                {e.target?.name ? <span className="text-slate-600">: <strong className="font-medium">{e.target.name}</strong></span> : null}
                {e.detail ? <span className={`ml-1 text-xs ${e.status && e.status >= 400 ? 'text-red-600' : 'text-slate-500'}`}>({e.detail})</span> : null}
                {e.method ? (
                  <div className="font-mono text-[11px] text-slate-400">
                    {e.method} {e.path}{e.status ? ` → ${e.status}` : ''}{e.durationMs != null ? ` · ${e.durationMs} ms` : ''}
                  </div>
                ) : null}
              </div>
            ),
          }))}
        />
      ) : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="No events of this kind" />}
    </div>
  );
}

export default function UserActivityPage() {
  const [days, setDays] = useState(7);
  const [userId, setUserId] = useState<string | undefined>(undefined);
  const [data, setData] = useState<UserSessionsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const result = await getUserSessions(days, userId);
      setData(result);
      setError(null);
      setSelected((current) => (current && result.sessions.some((s) => s.id === current) ? current : result.sessions[0]?.id || null));
    } catch (err: any) {
      setError(err?.response?.data?.error || err?.message || 'Failed to load user activity');
    } finally {
      setLoading(false);
    }
  }, [days, userId]);

  useEffect(() => { void load(); }, [load]);

  const columns: ColumnsType<UserSessionSummary> = [
    {
      title: 'User',
      key: 'user',
      render: (_, s) => (
        <div>
          <div className="font-medium text-slate-800">{s.displayName || s.userId}</div>
          <div className="text-xs text-slate-500">{s.role || 'no role'}</div>
        </div>
      ),
      sorter: (a, b) => (a.displayName || a.userId).localeCompare(b.displayName || b.userId),
    },
    {
      title: 'Signed in',
      dataIndex: 'loginAt',
      render: (v: string) => <span className="whitespace-nowrap">{fmtDateTime(v)}</span>,
      sorter: (a, b) => new Date(a.loginAt).getTime() - new Date(b.loginAt).getTime(),
      defaultSortOrder: 'descend',
    },
    {
      title: 'Duration',
      dataIndex: 'durationMs',
      render: (v: number) => <span className="whitespace-nowrap">{fmtDuration(v)}</span>,
      sorter: (a, b) => a.durationMs - b.durationMs,
    },
    {
      title: 'Status',
      dataIndex: 'status',
      render: (v: UserSessionSummary['status']) => <Tooltip title={STATUS[v].hint}><Tag color={STATUS[v].color}>{STATUS[v].label}</Tag></Tooltip>,
      filters: Object.entries(STATUS).map(([value, s]) => ({ text: s.label, value })),
      onFilter: (value, s) => s.status === value,
    },
    { title: 'Pages', dataIndex: 'viewCount', align: 'right', sorter: (a, b) => a.viewCount - b.viewCount },
    {
      title: 'Changes',
      dataIndex: 'changeCount',
      align: 'right',
      render: (v: number) => (v ? <span className="font-medium text-blue-700">{v}</span> : <span className="text-slate-400">0</span>),
      sorter: (a, b) => a.changeCount - b.changeCount,
    },
    {
      title: 'Device',
      key: 'device',
      responsive: ['xl'],
      render: (_, s) => (
        <Tooltip title={s.userAgent}>
          <div className="text-xs text-slate-600">{device(s.userAgent)}<div className="text-slate-400">{s.ip}</div></div>
        </Tooltip>
      ),
    },
  ];

  const summary = data?.summary;
  return (
    <div className="flex flex-col gap-4 p-4">
      <div className="flex flex-wrap items-center gap-3">
        <div>
          <div className="text-lg font-semibold text-slate-800">User Activity</div>
          <div className="text-xs text-slate-500">
            Who signed in, and what they viewed and changed in each session
            {data ? ` · updated ${new Date(data.generatedAt).toLocaleTimeString()}` : ''}
          </div>
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <Select
            allowClear
            showSearch
            size="small"
            placeholder="All users"
            style={{ minWidth: 200 }}
            value={userId}
            onChange={(v) => setUserId(v || undefined)}
            options={(data?.users || []).map((u) => ({ label: u, value: u }))}
          />
          <Segmented size="small" options={PERIODS} value={days} onChange={(v) => setDays(Number(v))} />
          <Button size="small" icon={<ReloadOutlined />} loading={loading} onClick={() => void load()}>Refresh</Button>
        </div>
      </div>

      {error ? <Alert type="error" showIcon message="User activity unavailable" description={error} /> : null}

      {summary ? (
        <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))' }}>
          <Kpi label="Users" value={summary.users} hint="People who signed in during the period" />
          <Kpi label="Sessions" value={summary.sessions} hint="Sign-ins during the period (or still active in it)" />
          <Kpi label="Active now" value={summary.activeNow} hint="Signed in and did something in the last 15 minutes" />
          <Kpi label="Pages viewed" value={summary.views} hint="Pages, sub-pages and diagrams opened" />
          <Kpi label="Changes" value={summary.changes} hint="Requests that changed data: saves, edits, deletes, uploads, runs" />
          <Kpi label="Failed sign-ins" value={summary.failedSignIns} hint="Unknown user or wrong password" tone={summary.failedSignIns ? 'alert' : undefined} />
        </div>
      ) : null}

      {data ? (
        <div className="grid gap-4" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 420px), 1fr))', alignItems: 'start' }}>
          <div className="min-w-0 rounded-lg border border-solid border-slate-200 bg-white p-3">
            <div className="mb-2 text-sm font-semibold text-slate-700">Sessions</div>
            <Table<UserSessionSummary>
              size="small"
              rowKey="id"
              columns={columns}
              dataSource={data.sessions}
              pagination={{ pageSize: 15, hideOnSinglePage: true, showSizeChanger: false }}
              locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="No sign-ins in this period" /> }}
              onRow={(s) => ({ onClick: () => setSelected(s.id), style: { cursor: 'pointer' } })}
              rowClassName={(s) => (s.id === selected ? 'ant-table-row-selected' : '')}
              scroll={{ x: true }}
            />
          </div>
          <div className="min-w-0 rounded-lg border border-solid border-slate-200 bg-white p-3">
            <div className="mb-2 text-sm font-semibold text-slate-700">Session activity</div>
            {selected ? <SessionTimeline key={selected} sessionId={selected} /> : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="Select a session" />}
          </div>
        </div>
      ) : loading ? <div className="flex justify-center py-16"><Spin size="large" /></div> : null}

      {data?.failedSignIns.length ? (
        <div className="rounded-lg border border-solid border-slate-200 bg-white p-3">
          <div className="mb-2 text-sm font-semibold text-slate-700">Failed sign-ins</div>
          <Table
            size="small"
            rowKey="id"
            dataSource={data.failedSignIns}
            pagination={{ pageSize: 10, hideOnSinglePage: true, showSizeChanger: false }}
            columns={[
              { title: 'When', dataIndex: 'at', render: (v: string) => fmtDateTime(v) },
              { title: 'User ID tried', dataIndex: 'userId' },
              { title: 'Reason', dataIndex: 'reason' },
              { title: 'IP address', dataIndex: 'ip' },
            ]}
          />
        </div>
      ) : null}
    </div>
  );
}
