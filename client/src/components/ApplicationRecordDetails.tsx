import { useEffect, useState } from 'react';
import { Spin } from 'antd';
import { getApplicationRecord } from '../api';

/**
 * Every field of an application's catalog record (System Components ›
 * Applications), grouped into sections, for the application details card on
 * a diagram canvas. Column names like "BUSINESS_CRITICALITY Aggregator" are
 * shown as "Business criticality"; Excel-serial dates and costs are formatted.
 */

type Field = { key: string; label: string; value: string; long: boolean };

const SECTIONS: Array<{ title: string; columns: string[] }> = [
  { title: 'Overview', columns: ['BUSINESS_DOMAIN', 'SUB_DOMAIN', 'APPLICATION_CATEGORY', 'APPLICATION_TYPE', 'BUSINESS_CRITICALITY', 'OPERATIONAL_STATUS', 'LIFE_CYCLE_STAGE', 'VALUE_CONTRIBUTION'] },
  { title: 'Ownership & users', columns: ['APPLICATION_OWNER', 'IT_OWNER', 'BUSINESS_OWNER', 'DEPARTMENT', 'PRIMARY_USERS', 'USER_BASE_SIZE'] },
  { title: 'Technology & integration', columns: ['TECHNOLOGY_STACK', 'PLATFORM', 'ARCHITECTURE_TYPE', 'HOSTING_MODEL', 'VENDOR', 'SUPPORT_VENDOR', 'INTEGRATION_TYPE', 'UPSTREAM_SYSTEMS', 'DOWNSTREAM_SYSTEMS'] },
  { title: 'Data, security & compliance', columns: ['DATA_CLASSIFICATION', 'DATA_ENTITIES', 'SECURITY_CLASSIFICATION', 'COMPLIANCE_REQUIREMENTS', 'CUSTOMER_FACING', 'INTERNET_FACING', 'DISASTER_RECOVERY_TIER', 'RTO_HOURS', 'RPO_HOURS'] },
  { title: 'Cost & lifecycle', columns: ['COST_CENTER', 'ANNUAL_COST', 'INSTALL_DATE', 'GO_LIVE_DATE', 'NEXT_MAJOR_UPGRADE', 'PLANNED_RETIREMENT_DATE'] },
];
// Shown elsewhere on the card (title, name, description) or not useful to read.
const SKIP = new Set(['APP_ACRONYM', 'APP_NAME', 'SHORT_DESCRIPTION', 'DETAILED_DESCRIPTION']);
const LABEL_OVERRIDES: Record<string, string> = {
  APP_ID: 'App ID', IT_OWNER: 'IT owner', RTO_HOURS: 'Recovery time (RTO)', RPO_HOURS: 'Recovery point (RPO)',
  SUB_DOMAIN: 'Subdomain', LIFE_CYCLE_STAGE: 'Lifecycle stage', USER_BASE_SIZE: 'Users',
};

/** "BUSINESS_CRITICALITY Aggregator" → "BUSINESS_CRITICALITY" */
const columnName = (key: string) => key.replace(/\s+(Qualifier|Aggregator|Component)$/i, '').trim();
const humanize = (column: string) => LABEL_OVERRIDES[column]
  || column.toLowerCase().split('_').map((w, i) => (i === 0 ? w.charAt(0).toUpperCase() + w.slice(1) : w)).join(' ')
    .replace(/\bid\b/g, 'ID').replace(/\bapi\b/gi, 'API').replace(/\bit\b/g, 'IT');

function formatValue(column: string, raw: unknown): string {
  if (raw === null || raw === undefined) return '';
  if (typeof raw === 'number') {
    if (/DATE$/.test(column) && raw > 20000 && raw < 80000) {
      // Excel serial day number → calendar date
      const d = new Date(Math.round((raw - 25569) * 86400 * 1000));
      return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' });
    }
    if (/(COST|USD|AMOUNT)/.test(column)) return new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(raw);
    if (/HOURS$/.test(column)) return `${raw} h`;
    return new Intl.NumberFormat().format(raw);
  }
  if (Array.isArray(raw)) return raw.map(String).join(', ');
  return String(raw).trim();
}

function toFields(values: Record<string, unknown>): Map<string, Field> {
  const out = new Map<string, Field>();
  for (const [key, raw] of Object.entries(values)) {
    if (key.startsWith('__') || key.startsWith('FK_')) continue;
    const column = columnName(key);
    if (SKIP.has(column)) continue;
    const value = formatValue(column, raw);
    if (!value) continue;
    out.set(column, { key, label: humanize(column), value, long: value.length > 48 });
  }
  return out;
}

export default function ApplicationRecordDetails({ appId, appKey }: { appId?: string | null; appKey: string }) {
  const [state, setState] = useState<{ loading: boolean; error: string | null; values: Record<string, unknown> | null }>({ loading: true, error: null, values: null });
  const [showFullDescription, setShowFullDescription] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setState({ loading: true, error: null, values: null });
    setShowFullDescription(false);
    getApplicationRecord(appId, appKey)
      .then((record) => { if (!cancelled) setState({ loading: false, error: null, values: record.values || {} }); })
      .catch((err) => { if (!cancelled) setState({ loading: false, error: err?.response?.status === 404 ? 'Not found in the Applications catalog.' : (err?.message || 'Could not load the catalog record.'), values: null }); });
    return () => { cancelled = true; };
  }, [appId, appKey]);

  if (state.loading) return <div className="flex items-center gap-2 py-3 text-xs text-slate-500"><Spin size="small" /> Loading catalog record…</div>;
  if (state.error || !state.values) return <div className="py-2 text-xs text-slate-500">{state.error}</div>;

  const fields = toFields(state.values);
  const placed = new Set<string>();
  const detailed = formatValue('DETAILED_DESCRIPTION', state.values['DETAILED_DESCRIPTION Qualifier']);
  const sections = SECTIONS.map((section) => ({
    title: section.title,
    fields: section.columns.map((c) => { const f = fields.get(c); if (f) placed.add(c); return f; }).filter((f): f is Field => Boolean(f)),
  }));
  const others = [...fields.entries()].filter(([c]) => !placed.has(c) && c !== 'APP_ID').map(([, f]) => f);
  if (others.length) sections.push({ title: 'Other', fields: others });

  return (
    <div>
      {detailed ? (
        <div className="border-t border-gray-100 mt-3 pt-3">
          <div className="text-xs text-gray-500 uppercase tracking-wide mb-1.5">Description</div>
          <p className={`text-xs text-gray-700 leading-5 m-0 ${showFullDescription ? '' : 'line-clamp-4'}`} style={showFullDescription ? undefined : { display: '-webkit-box', WebkitLineClamp: 4, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>{detailed}</p>
          {detailed.length > 260 ? (
            <button className="mt-1 border-0 bg-transparent p-0 text-xs text-blue-600 hover:underline cursor-pointer" onClick={() => setShowFullDescription((v) => !v)}>
              {showFullDescription ? 'Show less' : 'Show more'}
            </button>
          ) : null}
        </div>
      ) : null}
      {sections.filter((s) => s.fields.length).map((section) => (
        <div key={section.title} className="border-t border-gray-100 mt-3 pt-3">
          <div className="text-xs text-gray-500 uppercase tracking-wide mb-1.5">{section.title}</div>
          <table className="w-full text-xs"><tbody>
            {section.fields.map((f) => (
              f.long ? (
                <tr key={f.key}><td colSpan={2} className="py-1">
                  <div className="text-gray-500">{f.label}</div>
                  <div className="text-gray-800 break-words leading-5">{f.value}</div>
                </td></tr>
              ) : (
                <tr key={f.key}>
                  <td className="text-gray-500 py-1 pr-2 align-top" style={{ width: '46%' }}>{f.label}</td>
                  <td className="py-1 text-gray-800 break-words">{f.value}</td>
                </tr>
              )
            ))}
          </tbody></table>
        </div>
      ))}
    </div>
  );
}
