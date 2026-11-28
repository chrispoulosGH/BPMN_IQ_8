import { useCallback, useEffect, useMemo, useState } from 'react';
import { Alert, Button, DatePicker, Input, Modal, Segmented, Select, Spin, Table, Tabs, Tag, Tooltip, message } from 'antd';
import { EditOutlined, InfoCircleOutlined, ReloadOutlined } from '@ant-design/icons';
import { CartesianGrid, Legend, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip as RTooltip, XAxis, YAxis } from 'recharts';
import dayjs from 'dayjs';
import {
  getVendorSupport, getVendorSupportAssets, getVendorSupportProducts, setVendorSupportOverride,
  type SupportAsset, type SupportCheckpoint, type SupportDriver, type SupportFlow, type SupportProduct, type SupportRating,
  type SupportResponse, type SupportTimelinePoint,
} from '../api';

/**
 * Vendor Support: when the hardware, operating systems and software behind
 * each business flow lose vendor support — now and forecast up to 3 years
 * out — plus the vendor support register (one row per model / OS version /
 * software version) where administrators can enter the vendor's date.
 */

// Validated categorical slots 1–2 (dataviz default palette, light mode).
const SERVER_COLOR = '#2a78d6';
const SOFTWARE_COLOR = '#eb6834';
const RATING_TAG: Record<SupportRating, { color: string; label: string }> = {
  red: { color: 'red', label: 'Critical' },
  amber: { color: 'gold', label: 'Needs attention' },
  green: { color: 'green', label: 'Supported' },
  'no data': { color: 'default', label: 'No data' },
};
const KIND_LABEL = { hardware: 'Hardware', os: 'Operating system', software: 'Software' } as const;
const HORIZONS = ['Now', '+1 year', '+2 years', '+3 years'];

const fmtDate = (d?: string | null) => (d ? dayjs(d).format('MMM D, YYYY') : '—');
const fmtQuarter = (d: string) => {
  const x = dayjs(d);
  return `${x.format('MMM')} ’${x.format('YY')}`;
};
const pct = (n: number) => `${Math.round(n)}%`;

function Bar({ value, color }: { value: number; color: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
      <div style={{ width: 54, height: 6, borderRadius: 3, background: '#eef1f4', overflow: 'hidden' }}>
        <div style={{ width: `${Math.min(100, value)}%`, height: '100%', background: color, borderRadius: 3 }} />
      </div>
      <span style={{ fontVariantNumeric: 'tabular-nums', color: '#334155', minWidth: 34 }}>{pct(value)}</span>
    </div>
  );
}

function StatTile({ title, value, sub, tip }: { title: string; value: string; sub?: string; tip?: string }) {
  return (
    <div style={{ flex: '1 1 180px', background: '#fff', border: '1px solid #e2e8f0', borderRadius: 8, padding: '12px 14px' }}>
      <div style={{ fontSize: 12, color: '#64748b', display: 'flex', gap: 6, alignItems: 'center' }}>
        {title}
        {tip && <Tooltip title={tip}><InfoCircleOutlined style={{ color: '#94a3b8' }} /></Tooltip>}
      </div>
      <div style={{ fontSize: 24, fontWeight: 600, color: '#0f172a', fontVariantNumeric: 'tabular-nums' }}>{value}</div>
      {sub && <div style={{ fontSize: 12, color: '#64748b' }}>{sub}</div>}
    </div>
  );
}

/** Share of servers / software unsupported over the quarters ahead. */
function ExposureChart({ timeline, totals, checkpoints, height = 260 }: {
  timeline: SupportTimelinePoint[]; totals: { servers: number; software: number }; checkpoints: SupportCheckpoint[]; height?: number;
}) {
  const data = timeline.map((t) => ({
    date: t.date,
    servers: totals.servers ? Math.round((t.serversAffected / totals.servers) * 1000) / 10 : 0,
    software: totals.software ? Math.round((t.software / totals.software) * 1000) / 10 : 0,
    serversN: t.serversAffected, softwareN: t.software, hardwareN: t.hardware, osN: t.os,
  }));
  // Direct label at the end of each line (value at the 3-year mark).
  const endLabel = (name: string, dy: number) => (props: { x?: unknown; y?: unknown; index?: number; value?: unknown }) => (
    props.index === data.length - 1
      ? <text x={Number(props.x || 0) + 8} y={Number(props.y || 0) + dy} fontSize={11} fill="#334155">{name} {pct(Number(props.value || 0))}</text>
      : <g />
  );
  return (
    <ResponsiveContainer width="100%" height={height}>
      <LineChart data={data} margin={{ top: 12, right: 92, bottom: 4, left: 0 }}>
        <CartesianGrid stroke="#eef1f4" vertical={false} />
        <XAxis dataKey="date" tickFormatter={fmtQuarter} tick={{ fontSize: 11, fill: '#64748b' }} axisLine={{ stroke: '#cbd5e1' }} tickLine={false} />
        <YAxis domain={[0, 100]} ticks={[0, 25, 50, 75, 100]} tickFormatter={(v) => `${v}%`} tick={{ fontSize: 11, fill: '#64748b' }} axisLine={false} tickLine={false} width={44} />
        {checkpoints.slice(1).map((c) => (
          <ReferenceLine key={c.label} x={data.reduce((best, d) => (Math.abs(dayjs(d.date).diff(c.date)) < Math.abs(dayjs(best).diff(c.date)) ? d.date : best), data[0]?.date)}
            stroke="#cbd5e1" strokeDasharray="3 3" label={{ value: c.label, position: 'top', fontSize: 10, fill: '#94a3b8' }} />
        ))}
        <RTooltip
          cursor={{ stroke: '#94a3b8', strokeWidth: 1 }}
          content={({ active, payload }) => {
            if (!active || !payload?.length) return null;
            const p = payload[0].payload as (typeof data)[number];
            return (
              <div style={{ background: '#fff', border: '1px solid #e2e8f0', borderRadius: 6, padding: '8px 10px', fontSize: 12, color: '#0f172a', boxShadow: '0 2px 8px rgba(15,23,42,.08)' }}>
                <div style={{ fontWeight: 600, marginBottom: 4 }}>{fmtDate(p.date)}</div>
                <div><span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: 4, background: SERVER_COLOR, marginRight: 6 }} />Servers unsupported: <b>{pct(p.servers)}</b> ({p.serversN.toLocaleString()})</div>
                <div style={{ color: '#64748b', paddingLeft: 14 }}>hardware {p.hardwareN.toLocaleString()} · OS {p.osN.toLocaleString()}</div>
                <div><span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: 4, background: SOFTWARE_COLOR, marginRight: 6 }} />Software past end of support: <b>{pct(p.software)}</b> ({p.softwareN.toLocaleString()})</div>
              </div>
            );
          }}
        />
        <Legend verticalAlign="top" align="left" height={28} iconType="plainline" wrapperStyle={{ fontSize: 12 }} formatter={(value) => <span style={{ color: '#334155' }}>{value}</span>} />
        <Line type="stepAfter" dataKey="servers" name="Servers with unsupported hardware or OS" stroke={SERVER_COLOR} strokeWidth={2} dot={{ r: 4, strokeWidth: 2, fill: '#fff' }} activeDot={{ r: 5 }}
          label={endLabel('Servers', 4)} />
        <Line type="stepAfter" dataKey="software" name="Software installs past end of support" stroke={SOFTWARE_COLOR} strokeWidth={2} dot={{ r: 4, strokeWidth: 2, fill: '#fff' }} activeDot={{ r: 5 }}
          label={endLabel('Software', 16)} />
      </LineChart>
    </ResponsiveContainer>
  );
}

function DriversTable({ drivers }: { drivers: SupportDriver[] }) {
  return (
    <Table<SupportDriver>
      size="small" pagination={false} rowKey={(d) => `${d.kind}|${d.vendor}|${d.product}|${d.version}`} dataSource={drivers}
      columns={[
        { title: 'Type', dataIndex: 'kind', width: 130, render: (k: SupportDriver['kind']) => KIND_LABEL[k] },
        { title: 'Product', render: (_, d) => <span><b>{d.product}</b> {d.version} <span style={{ color: '#64748b' }}>· {d.vendor}</span></span> },
        { title: 'Installs', dataIndex: 'installs', width: 80, align: 'right' },
        { title: 'Unsupported now', dataIndex: 'unsupportedNow', width: 120, align: 'right' },
        { title: 'Support ends', width: 210, render: (_, d) => (d.earliest === d.latest || !d.latest ? fmtDate(d.earliest) : `${fmtDate(d.earliest)} – ${fmtDate(d.latest)}`) },
      ]}
    />
  );
}

function FlowDetail({ flow, onOpenFlow }: { flow: SupportFlow; onOpenFlow?: (diagramId: string) => void }) {
  const [detail, setDetail] = useState<SupportFlow | null>(null);
  const [assets, setAssets] = useState<SupportAsset[] | null>(null);
  const [kind, setKind] = useState<'all' | SupportAsset['kind']>('all');
  useEffect(() => {
    let live = true;
    getVendorSupport({ diagramId: flow.diagramId, drivers: true }).then((r) => { if (live) setDetail(r.flows[0] || null); }).catch(() => {});
    getVendorSupportAssets(flow.diagramId).then((r) => { if (live) setAssets(r.assets); }).catch(() => setAssets([]));
    return () => { live = false; };
  }, [flow.diagramId]);
  const shown = (assets || []).filter((a) => kind === 'all' || a.kind === kind);
  return (
    <div style={{ padding: '4px 8px 12px' }}>
      <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'center', marginBottom: 8, color: '#475569', fontSize: 12 }}>
        <span>Applications: {flow.applications.join(', ') || '—'}</span>
        {flow.uncataloguedApplications.length > 0 && (
          <Tooltip title="These applications are used by the flow but have no catalogued servers or software, so their infrastructure isn't counted.">
            <Tag color="orange">Not in catalog: {flow.uncataloguedApplications.join(', ')}</Tag>
          </Tooltip>
        )}
        {onOpenFlow && <Button size="small" type="link" onClick={() => onOpenFlow(flow.diagramId)}>Open flow in Business Processes</Button>}
      </div>
      {flow.totals.servers > 0 && <ExposureChart timeline={flow.timeline} totals={flow.totals} checkpoints={flow.checkpoints} height={210} />}
      <div style={{ fontWeight: 600, margin: '10px 0 6px', color: '#0f172a' }}>Products losing support within 3 years</div>
      {detail?.drivers ? <DriversTable drivers={detail.drivers} /> : <Spin size="small" />}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, margin: '14px 0 6px' }}>
        <span style={{ fontWeight: 600, color: '#0f172a' }}>Affected items {assets ? `(${shown.length})` : ''}</span>
        <Segmented size="small" value={kind} onChange={(v) => setKind(v as typeof kind)}
          options={[{ label: 'All', value: 'all' }, { label: 'Hardware', value: 'hardware' }, { label: 'OS', value: 'os' }, { label: 'Software', value: 'software' }]} />
      </div>
      {assets === null ? <Spin size="small" /> : (
        <Table<SupportAsset>
          size="small" dataSource={shown} rowKey={(a, i) => `${a.kind}|${a.serverId}|${a.softwareId || ''}|${i}`}
          pagination={{ pageSize: 10, size: 'small', showSizeChanger: false }}
          columns={[
            { title: 'Status', dataIndex: 'status', width: 110, render: (s: SupportAsset['status']) => (s === 'unsupported' ? <Tag color="red">Unsupported</Tag> : <Tag color="gold">Upcoming</Tag>) },
            { title: 'Type', dataIndex: 'kind', width: 120, render: (k: SupportAsset['kind']) => KIND_LABEL[k] },
            { title: 'Item', render: (_, a) => <span><b>{a.product}</b> {a.version}<div style={{ color: '#64748b', fontSize: 12 }}>{a.kind === 'software' ? `${a.asset} on ${a.serverId}` : a.serverId}</div></span> },
            { title: 'Application', dataIndex: 'application', width: 130 },
            {
              title: 'Support ends', width: 150, render: (_, a) => (
                <Tooltip title={a.contract === 'Expired' ? 'Support contract has expired' : a.dateBasis}>
                  <span>{a.contract === 'Expired' ? 'Contract expired' : fmtDate(a.endDate)}</span>
                </Tooltip>
              ),
            },
            { title: 'Warranty ends', width: 120, render: (_, a) => (a.kind === 'hardware' ? fmtDate(a.warrantyEnd) : '') },
          ]}
        />
      )}
    </div>
  );
}

function Register({ canEdit }: { canEdit: boolean }) {
  const [rows, setRows] = useState<SupportProduct[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [kind, setKind] = useState<'all' | SupportProduct['kind']>('all');
  const [q, setQ] = useState('');
  const [editing, setEditing] = useState<SupportProduct | null>(null);
  const [date, setDate] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const load = useCallback(() => {
    setRows(null);
    getVendorSupportProducts().then(setRows).catch((e) => setError(e?.response?.data?.error || e.message));
  }, []);
  useEffect(load, [load]);
  const shown = (rows || []).filter((r) => (kind === 'all' || r.kind === kind)
    && (!q || `${r.vendor} ${r.product} ${r.version}`.toLowerCase().includes(q.toLowerCase())));
  const save = async (clear = false) => {
    if (!editing) return;
    setSaving(true);
    try {
      await setVendorSupportOverride(editing.key, clear ? null : date, note);
      message.success(clear ? 'Vendor date removed' : 'Vendor date saved');
      setEditing(null);
      load();
    } catch (e: unknown) {
      const err = e as { response?: { data?: { error?: string } }; message?: string };
      message.error(err.response?.data?.error || err.message || 'Save failed');
    } finally {
      setSaving(false);
    }
  };
  const statusTag = (s: string) => {
    const color = s === 'unsupported' ? 'red' : s === 'partly unsupported' ? 'volcano' : s === 'within 12 months' ? 'gold' : s === 'unknown' ? 'default' : 'green';
    return <Tag color={color}>{s[0].toUpperCase() + s.slice(1)}</Tag>;
  };
  if (error) return <Alert type="error" message={error} />;
  return (
    <div>
      <div style={{ display: 'flex', gap: 12, alignItems: 'center', marginBottom: 10, flexWrap: 'wrap' }}>
        <Segmented value={kind} onChange={(v) => setKind(v as typeof kind)}
          options={[{ label: 'All', value: 'all' }, { label: 'Hardware', value: 'hardware' }, { label: 'Operating systems', value: 'os' }, { label: 'Software', value: 'software' }]} />
        <Input.Search allowClear placeholder="Vendor, product or version" style={{ width: 260 }} onChange={(e) => setQ(e.target.value)} />
        <span style={{ color: '#64748b', fontSize: 12 }}>
          {rows ? `${shown.length} of ${rows.length} products` : ''} · synced from the System Components catalog
          {canEdit ? ' · use the pencil to enter a vendor-published date' : ''}
        </span>
      </div>
      <Table<SupportProduct>
        size="small" loading={!rows} dataSource={shown} rowKey="key" pagination={{ pageSize: 25, showSizeChanger: false }}
        columns={[
          { title: 'Type', dataIndex: 'kind', width: 130, render: (k: SupportProduct['kind']) => KIND_LABEL[k], sorter: (a, b) => a.kind.localeCompare(b.kind) },
          { title: 'Vendor', dataIndex: 'vendor', width: 170, sorter: (a, b) => a.vendor.localeCompare(b.vendor) },
          { title: 'Product', render: (_, r) => <span><b>{r.product}</b> {r.version}</span>, sorter: (a, b) => a.product.localeCompare(b.product) },
          {
            title: 'Unsupported from', width: 230, defaultSortOrder: 'ascend',
            sorter: (a, b) => (a.endOfSupportEarliest || '9999').localeCompare(b.endOfSupportEarliest || '9999'),
            render: (_, r) => (
              <Tooltip title={r.override ? `Vendor date entered by ${r.override.by || 'an administrator'}${r.override.note ? `: ${r.override.note}` : ''}` : r.dateBasis}>
                <span>
                  {r.endOfSupportEarliest === r.endOfSupportLatest || !r.endOfSupportLatest ? fmtDate(r.endOfSupportEarliest) : `${fmtDate(r.endOfSupportEarliest)} – ${fmtDate(r.endOfSupportLatest)}`}
                  {r.override ? <Tag color="blue" style={{ marginLeft: 6 }}>Vendor date</Tag> : r.kind === 'hardware' ? <Tag style={{ marginLeft: 6 }}>Estimate</Tag> : null}
                </span>
              </Tooltip>
            ),
          },
          { title: 'Status', dataIndex: 'status', width: 150, render: statusTag, filters: ['unsupported', 'partly unsupported', 'within 12 months', 'supported', 'unknown'].map((s) => ({ text: s, value: s })), onFilter: (v, r) => r.status === v },
          { title: 'Installs', dataIndex: 'installs', width: 90, align: 'right', sorter: (a, b) => a.installs - b.installs },
          { title: 'Apps', dataIndex: 'applicationCount', width: 70, align: 'right' },
          {
            title: 'History', width: 80, render: (_, r) => (r.history?.length ? (
              <Tooltip title={<div>{r.history.map((h, i) => <div key={i}>{fmtDate(h.at)}: {h.field === 'endOfSupportOverride' ? 'vendor date' : 'date'} {h.from || '—'} → {h.to || '—'}{h.by ? ` (${h.by})` : ''}</div>)}</div>}>
                <Tag>{r.history.length}</Tag>
              </Tooltip>
            ) : null),
          },
          ...(canEdit ? [{
            title: '', width: 48, render: (_: unknown, r: SupportProduct) => (
              <Button size="small" type="text" icon={<EditOutlined />} aria-label={`Edit vendor date for ${r.product} ${r.version}`}
                onClick={() => { setEditing(r); setDate(r.override?.date || r.endOfSupportEarliest); setNote(r.override?.note || ''); }} />
            ),
          }] : []),
        ]}
      />
      <Modal
        open={Boolean(editing)} title={editing ? `Vendor support date: ${editing.product} ${editing.version}` : ''} onCancel={() => setEditing(null)}
        footer={[
          editing?.override ? <Button key="clear" danger onClick={() => save(true)} loading={saving}>Remove vendor date</Button> : null,
          <Button key="cancel" onClick={() => setEditing(null)}>Cancel</Button>,
          <Button key="save" type="primary" disabled={!date} loading={saving} onClick={() => save(false)}>Save</Button>,
        ]}
      >
        {editing && (
          <div style={{ display: 'grid', gap: 10 }}>
            <div style={{ color: '#475569', fontSize: 13 }}>
              Currently: {fmtDate(editing.endOfSupportEarliest)} ({editing.override ? 'vendor date' : editing.dateBasis}). The date you enter replaces it for all {editing.installs} installs and is recorded in the product's history.
            </div>
            <DatePicker value={date ? dayjs(date) : null} onChange={(d) => setDate(d ? d.format('YYYY-MM-DD') : null)} style={{ width: 200 }} />
            <Input.TextArea rows={2} placeholder="Source, e.g. vendor lifecycle page or support notice" value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} />
          </div>
        )}
      </Modal>
    </div>
  );
}

export default function VendorSupport({ onOpenFlow, canEdit = false }: { onOpenFlow?: (diagramId: string) => void; canEdit?: boolean }) {
  const [data, setData] = useState<SupportResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [horizon, setHorizon] = useState(0);
  const [domain, setDomain] = useState<string | undefined>();
  const [rating, setRating] = useState<SupportRating | undefined>();
  const [q, setQ] = useState('');

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    getVendorSupport().then(setData).catch((e) => setError(e?.response?.data?.error || e.message)).finally(() => setLoading(false));
  }, []);
  useEffect(load, [load]);

  const flows = useMemo(() => (data?.flows || [])
    .filter((f) => (!domain || f.domain === domain) && (!rating || f.rating === rating)
      && (!q || `${f.name} ${f.applications.join(' ')}`.toLowerCase().includes(q.toLowerCase())))
    .sort((a, b) => (b.checkpoints[horizon]?.serversPct || 0) - (a.checkpoints[horizon]?.serversPct || 0)
      || (b.checkpoints[horizon]?.softwarePct || 0) - (a.checkpoints[horizon]?.softwarePct || 0)), [data, domain, rating, q, horizon]);

  if (error) return <div style={{ padding: 16 }}><Alert type="error" message="Couldn't load vendor support data" description={error} /></div>;
  if (!data) return <div style={{ padding: 48, textAlign: 'center' }}><Spin /></div>;

  const L = data.landscape;
  const at = L.checkpoints[horizon];
  const now = L.checkpoints[0];

  const overview = (
    <div style={{ display: 'grid', gap: 14 }}>
      <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
        <span style={{ color: '#475569', fontSize: 13 }}>View</span>
        <Segmented value={horizon} onChange={(v) => setHorizon(Number(v))} options={HORIZONS.map((label, i) => ({ label: i ? `${label} (${dayjs(L.checkpoints[i].date).format('MMM YYYY')})` : `Now (${dayjs(data.asOf).format('MMM D, YYYY')})`, value: i }))} />
      </div>
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
        <StatTile title={`Servers unsupported · ${HORIZONS[horizon].toLowerCase()}`} value={`${at.serversAffected.toLocaleString()}`}
          sub={`${pct(at.serversPct)} of ${L.totals.servers.toLocaleString()} · hardware ${at.hardware.toLocaleString()}, OS ${at.os.toLocaleString()}${horizon ? ` · now ${now.serversAffected.toLocaleString()}` : ''}`}
          tip="A server counts once if its hardware model or its operating system is past vendor support." />
        <StatTile title={`Software past end of support · ${HORIZONS[horizon].toLowerCase()}`} value={at.software.toLocaleString()}
          sub={`${pct(at.softwarePct)} of ${L.totals.software.toLocaleString()} installs${horizon ? ` · now ${now.software.toLocaleString()}` : ''}`}
          tip={`${L.totals.unknownDates} items have no end-of-support date in the catalog ("N/A") and are not counted.`} />
        <StatTile title="Applications affected" value={at.appsAffected.toLocaleString()} sub={`with at least one unsupported item ${horizon ? `by ${dayjs(at.date).format('MMM YYYY')}` : 'now'}`} />
        <StatTile title="Flow ratings (now)" value={`${L.ratings.red} critical`} sub={`${L.ratings.amber} need attention · ${L.ratings.green} supported · ${L.ratings['no data']} no data`} tip={data.ratingRule} />
        <StatTile title={`Out of warranty · ${HORIZONS[horizon].toLowerCase()}`} value={at.outOfWarranty.toLocaleString()} sub="servers; not counted as unsupported"
          tip="WARRANTY_EXPIRY has passed. Support contracts normally continue past warranty, so this is shown for information only." />
      </div>
      <div style={{ background: '#fff', border: '1px solid #e2e8f0', borderRadius: 8, padding: '12px 14px' }}>
        <div style={{ fontWeight: 600, color: '#0f172a' }}>Share of the estate out of vendor support, next 3 years</div>
        <div style={{ fontSize: 12, color: '#64748b', marginBottom: 4 }}>Quarterly from {fmtDate(data.asOf)}. Hover for counts.</div>
        <ExposureChart timeline={L.timeline} totals={L.totals} checkpoints={L.checkpoints} />
      </div>
      <div style={{ background: '#fff', border: '1px solid #e2e8f0', borderRadius: 8, padding: '12px 14px' }}>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', marginBottom: 10 }}>
          <span style={{ fontWeight: 600, color: '#0f172a' }}>Business flows</span>
          <Input.Search allowClear placeholder="Flow or application" style={{ width: 220 }} onChange={(e) => setQ(e.target.value)} />
          <Select allowClear placeholder="All domains" style={{ width: 240 }} value={domain} onChange={setDomain}
            options={data.byDomain.map((d) => ({ value: d.domain, label: `${d.domain} (${d.flows})` }))} />
          <Select allowClear placeholder="All ratings" style={{ width: 170 }} value={rating} onChange={setRating}
            options={(Object.keys(RATING_TAG) as SupportRating[]).map((r) => ({ value: r, label: `${RATING_TAG[r].label} (${L.ratings[r]})` }))} />
          <span style={{ color: '#64748b', fontSize: 12 }}>{flows.length} flows · sorted by servers unsupported {HORIZONS[horizon].toLowerCase()} · click a row for detail</span>
        </div>
        <Table<SupportFlow>
          size="small" dataSource={flows} rowKey="diagramId" pagination={{ pageSize: 20, showSizeChanger: false }}
          expandable={{ expandRowByClick: true, expandedRowRender: (f) => <FlowDetail flow={f} onOpenFlow={onOpenFlow} /> }}
          columns={[
            { title: 'Flow', render: (_, f) => <span><b>{f.name}</b><div style={{ fontSize: 12, color: '#64748b' }}>{f.domain}</div></span> },
            {
              title: <Tooltip title={data.ratingRule}><span>Rating <InfoCircleOutlined style={{ color: '#94a3b8' }} /></span></Tooltip>, width: 140,
              render: (_, f) => <Tag color={RATING_TAG[f.rating].color}>{RATING_TAG[f.rating].label}</Tag>,
            },
            { title: 'Servers', width: 80, align: 'right', render: (_, f) => f.totals.servers },
            ...HORIZONS.map((label, i) => ({
              title: <span style={{ fontWeight: i === horizon ? 700 : 500 }}>{label}<div style={{ fontSize: 11, fontWeight: 400, color: '#64748b' }}>servers · software</div></span>,
              width: 200,
              onCell: () => ({ style: { background: i === horizon ? '#f8fafc' : undefined } }),
              render: (_: unknown, f: SupportFlow) => (f.totals.servers ? (
                <Tooltip title={`${f.checkpoints[i].serversAffected} servers (hardware ${f.checkpoints[i].hardware}, OS ${f.checkpoints[i].os}) · ${f.checkpoints[i].software} of ${f.totals.software} software installs`}>
                  <div style={{ display: 'grid', gap: 3 }}>
                    <Bar value={f.checkpoints[i].serversPct} color={SERVER_COLOR} />
                    <Bar value={f.checkpoints[i].softwarePct} color={SOFTWARE_COLOR} />
                  </div>
                </Tooltip>
              ) : <span style={{ color: '#94a3b8' }}>—</span>),
            })),
            {
              title: 'Next to lose support', width: 230,
              render: (_, f) => (f.nextLoss ? (
                <span>{fmtDate(f.nextLoss.date)}<div style={{ fontSize: 12, color: '#64748b' }}>{KIND_LABEL[f.nextLoss.kind as keyof typeof KIND_LABEL]}: {f.nextLoss.product} {f.nextLoss.version}</div></span>
              ) : '—'),
            },
          ]}
        />
      </div>
      <div style={{ background: '#fff', border: '1px solid #e2e8f0', borderRadius: 8, padding: '12px 14px' }}>
        <div style={{ fontWeight: 600, color: '#0f172a', marginBottom: 6 }}>Products losing support across the estate (next 3 years, most installs first)</div>
        <DriversTable drivers={L.drivers} />
      </div>
      <div style={{ fontSize: 12, color: '#64748b' }}>
        <div><b>Hardware:</b> {data.sources.hardware}</div>
        <div><b>Operating systems:</b> {data.sources.os}. <b>Software:</b> {data.sources.software}.</div>
      </div>
    </div>
  );

  return (
    <div style={{ padding: 16, background: '#f8fafc', minHeight: '100%' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 8 }}>
        <div style={{ fontSize: 18, fontWeight: 600, color: '#0f172a' }}>Vendor Support</div>
        <span style={{ color: '#64748b', fontSize: 13 }}>When the hardware, operating systems and software behind each business flow lose vendor support</span>
        <Button size="small" icon={<ReloadOutlined />} loading={loading} onClick={load} style={{ marginLeft: 'auto' }}>Refresh</Button>
      </div>
      <Tabs
        className="factory-tabs"
        items={[
          { key: 'flows', label: 'By business flow', children: overview },
          { key: 'register', label: 'Vendor support register', children: <Register canEdit={canEdit} /> },
        ]}
      />
    </div>
  );
}
