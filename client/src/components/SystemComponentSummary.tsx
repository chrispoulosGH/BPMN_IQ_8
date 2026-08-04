import { useMemo, useEffect, useState } from 'react';
import Plot from 'react-plotly.js';
import { Button, Card, Col, Row, Statistic, Tooltip, Typography, Spin } from 'antd';
import { CheckCircleOutlined, ExclamationCircleOutlined, TableOutlined } from '@ant-design/icons';
import { getDataDistributions } from '../api';
import { inferCityCoord } from './ServerLocationMap';
import CostGroupCharts from './CostGroupCharts';

const { Text, Title } = Typography;

const BATCH_SIZE = 100;
const MAX_VALUES_SHOWN = 10;

/** Server-specific pinned summary columns */
const SERVER_PINNED_COLUMNS = [
  'APP_BUS_CRTCLTY Qualifier',
  'APP_BUS_UNIT Qualifier',
  'APP_DPTMT Qualifier',
  'APP_INSL_TYPE Qualifier',
  'APP_LIFECYCLE Qualifier',
  'APP_LIFECYCLE_STS Qualifier',
  'APP_BUS_PRPS Qualifier',
  'SVR_CPU_MNFCTR Qualifier',
  'SVR_CPU_NM Qualifier',
  'SVR_CPU_TYPE Qualifier',
  'SVR_DSCVRY_SRC Qualifier',
  'SVR_OS Qualifier',
];

const SVR_LOC_COLUMN = 'SVR_LOC Qualifier';

const US_STATE_ABBREVS = new Set([
  'AL','AK','AZ','AR','CA','CO','CT','DE','FL','GA','HI','ID','IL','IN','IA',
  'KS','KY','LA','ME','MD','MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ',
  'NM','NY','NC','ND','OH','OK','OR','PA','RI','SC','SD','TN','TX','UT','VT',
  'VA','WA','WV','WI','WY','DC',
]);

/** Extract 2-letter US state code from an address string.
 *
 * Handles the real data formats seen in SVR_LOC:
 *   "10 S CANAL ST CHICAGO, IL 60606-3738"          → IL
 *   "0 MS AZURE - EAST US 2 REGION, VA"             → VA
 *   "10 S CANAL ST CHICAGO, IL 60606-3738 - Duplicate" → IL
 *   Plain 2-letter code "TX"                        → TX
 */
function extractStateCode(value: string): string | null {
  // Strip trailing annotation (e.g. " - Duplicate", " - STE 2500 - Duplicate")
  const v = value.trim().toUpperCase().replace(/\s*-\s*DUPLICATE\s*$/i, '').trim();

  // Plain standalone state code
  if (US_STATE_ABBREVS.has(v)) return v;

  // Primary pattern: ", ST 12345" or ", ST 12345-6789" or ", ST" at end-of-string
  // e.g. "CHICAGO, IL 60606" or "REGION, VA"
  const commaState = v.match(/,\s*([A-Z]{2})(?:\s+\d{5}(?:-\d{4})?)?(?:\s+.*)?$/);
  if (commaState && US_STATE_ABBREVS.has(commaState[1])) return commaState[1];

  // Fallback: bare "XX-" / "XX " prefix patterns (e.g. "TX-DAL", "TX DAL")
  const prefix = v.match(/^([A-Z]{2})[-_.\s]/);
  if (prefix && US_STATE_ABBREVS.has(prefix[1])) return prefix[1];

  return null;
}


const BAR_COLORS = [
  '#4096ff', '#52c41a', '#faad14', '#f5222d', '#722ed1',
  '#13c2c2', '#eb2f96', '#fa8c16', '#a0d911', '#1890ff',
  '#2f54eb', '#08979c',
];

// ---------------------------------------------------------------------------
// AggregationPanel
// ---------------------------------------------------------------------------
interface AggregationPanelProps {
  column: string;
  valueCounts: Array<{ value: string; count: number }>;
  total: number;
  colorIndex: number;
}

function AggregationPanel({ column, valueCounts, total, colorIndex }: AggregationPanelProps) {
  const maxCount = valueCounts[0]?.count ?? 1;
  const color = BAR_COLORS[colorIndex % BAR_COLORS.length];
  const displayName = column.replace(/\s+qualifier$/i, '');

  return (
    <Card
      size="small"
      title={
        <Tooltip title={column}>
          <span style={{ fontWeight: 600, fontSize: 12, color: '#374151' }}>{displayName}</span>
        </Tooltip>
      }
      style={{ height: '100%', minWidth: 0 }}
      styles={{ body: { padding: '8px 12px' } }}
    >
      {valueCounts.length === 0 ? (
        <Text style={{ fontSize: 11, color: '#9ca3af' }}>No data</Text>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          {valueCounts.slice(0, MAX_VALUES_SHOWN).map(({ value, count }) => {
            const pct = total > 0 ? Math.round((count / total) * 100) : 0;
            const barPct = maxCount > 0 ? (count / maxCount) * 100 : 0;
            return (
              <div key={value} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <div style={{ flex: '0 0 auto', width: 120, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  <Tooltip title={value || '(blank)'}>
                    <Text style={{ fontSize: 11, color: '#374151' }}>
                      {value || <em style={{ color: '#9ca3af' }}>blank</em>}
                    </Text>
                  </Tooltip>
                </div>
                <div style={{ flex: 1, height: 10, background: '#f1f5f9', borderRadius: 3, overflow: 'hidden' }}>
                  <div style={{ width: `${barPct}%`, height: '100%', background: color, borderRadius: 3, transition: 'width 0.4s ease' }} />
                </div>
                <div style={{ flex: '0 0 auto', width: 54, textAlign: 'right' }}>
                  <Text style={{ fontSize: 10, color: '#6b7280' }}>
                    {count.toLocaleString()} <span style={{ color: '#9ca3af' }}>({pct}%)</span>
                  </Text>
                </div>
              </div>
            );
          })}
          {valueCounts.length > MAX_VALUES_SHOWN && (
            <Text style={{ fontSize: 10, color: '#9ca3af', marginTop: 2 }}>
              +{valueCounts.length - MAX_VALUES_SHOWN} more distinct values
            </Text>
          )}
        </div>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// SVR_LOC US Map
// ---------------------------------------------------------------------------
interface SvrLocMapProps {
  valueCounts: Array<{ value: string; count: number }>;
  total: number;
}

function SvrLocMap({ valueCounts }: SvrLocMapProps) {
  const { stateCounts, unmapped } = useMemo(() => {
    const stateMap = new Map<string, number>();
    const unmatched: Array<{ value: string; count: number }> = [];
    for (const { value, count } of valueCounts) {
      const code = extractStateCode(value);
      if (code) {
        stateMap.set(code, (stateMap.get(code) ?? 0) + count);
      } else {
        unmatched.push({ value, count });
      }
    }
    return {
      stateCounts: Array.from(stateMap.entries())
        .sort((a, b) => b[1] - a[1])
        .map(([state, count]) => ({ state, count })),
      unmapped: unmatched.sort((a, b) => b.count - a.count),
    };
  }, [valueCounts]);

  return (
    <Card
      size="small"
      title={<span style={{ fontWeight: 600, fontSize: 12, color: '#374151' }}>SVR_LOC — Server Distribution by State</span>}
      style={{ minWidth: 0 }}
      styles={{ body: { padding: '4px 4px 8px' } }}
    >
      {stateCounts.length > 0 ? (
        <Plot
          data={[{
            type: 'choropleth' as any,
            locationmode: 'USA-states',
            locations: stateCounts.map(d => d.state),
            z: stateCounts.map(d => d.count),
            text: stateCounts.map(d => `<b>${d.state}</b><br>${d.count.toLocaleString()} servers`),
            hovertemplate: '%{text}<extra></extra>',
            colorscale: [
              [0, '#dbeafe'], [0.25, '#93c5fd'], [0.5, '#3b82f6'],
              [0.75, '#1d4ed8'], [1, '#1e3a8a'],
            ],
            colorbar: {
              title: { text: 'Servers', font: { size: 11 } },
              thickness: 12,
              len: 0.7,
              tickfont: { size: 10 },
            },
            zmin: 0,
          }]}
          layout={{
            geo: {
              scope: 'usa',
              showlakes: true,
              lakecolor: '#f0f9ff',
              bgcolor: 'transparent',
              landcolor: '#f8fafc',
              subunitcolor: '#cbd5e1',
            },
            margin: { t: 4, b: 4, l: 0, r: 60 },
            paper_bgcolor: 'transparent',
            plot_bgcolor: 'transparent',
            height: 320,
          }}
          config={{ displayModeBar: false, responsive: true }}
          style={{ width: '100%' }}
          useResizeHandler
        />
      ) : (
        <Text style={{ fontSize: 12, color: '#9ca3af', padding: '8px 12px', display: 'block' }}>
          No recognisable US state codes found in SVR_LOC values.
        </Text>
      )}

      {unmapped.length > 0 && (
        <div style={{ padding: '6px 12px', borderTop: '1px solid #f1f5f9', marginTop: 4 }}>
          <Text style={{ fontSize: 10, color: '#6b7280', display: 'block', marginBottom: 4 }}>
            Other / unresolved locations:
          </Text>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
            {unmapped.slice(0, 20).map(({ value, count }) => (
              <span
                key={value}
                style={{ fontSize: 10, background: '#f1f5f9', borderRadius: 3, padding: '1px 6px', color: '#374151' }}
              >
                {value || '(blank)'}: {count.toLocaleString()}
              </span>
            ))}
            {unmapped.length > 20 && (
              <span style={{ fontSize: 10, color: '#9ca3af' }}>+{unmapped.length - 20} more</span>
            )}
          </div>
        </div>
      )}
    </Card>
  );
}

interface CityMapProps {
  cityCounts: Array<{ city: string; count: number }>;
}

function CityMap({ cityCounts }: CityMapProps) {
  const { geocodedCities, unresolvedCities } = useMemo(() => {
    const geocoded: Array<{ city: string; count: number; lat: number; lon: number }> = [];
    const unresolved: Array<{ city: string; count: number }> = [];

    for (const { city, count } of cityCounts) {
      const coord = inferCityCoord(city);
      if (coord) {
        geocoded.push({ city, count, ...coord });
      } else {
        unresolved.push({ city, count });
      }
    }

    geocoded.sort((left, right) => right.count - left.count);
    unresolved.sort((left, right) => right.count - left.count);

    return { geocodedCities: geocoded, unresolvedCities: unresolved };
  }, [cityCounts]);

  if (!cityCounts.length) return null;

  return (
    <Card
      size="small"
      title={<span style={{ fontWeight: 600, fontSize: 12, color: '#374151' }}>SVR_LOC — City Counts Visible on Map</span>}
      style={{ minWidth: 0 }}
      styles={{ body: { padding: '4px 4px 8px' } }}
    >
      {geocodedCities.length > 0 ? (
        <Plot
          data={[{
            type: 'scattergeo' as const,
            mode: 'markers+text',
            lat: geocodedCities.map((item) => item.lat),
            lon: geocodedCities.map((item) => item.lon),
            text: geocodedCities.map((item) => `${item.city}<br>${item.count.toLocaleString()} servers`),
            textposition: 'top center',
            hovertemplate: '%{text}<extra></extra>',
            marker: {
              size: geocodedCities.map((item) => Math.max(8, Math.min(28, 8 + Math.log2(item.count + 1) * 3))),
              color: '#0f766e',
              opacity: 0.88,
              line: { color: '#ffffff', width: 1 },
            },
          }]}
          layout={{
            geo: {
              scope: 'usa',
              showlakes: true,
              lakecolor: '#f0f9ff',
              bgcolor: 'transparent',
              landcolor: '#f8fafc',
              subunitcolor: '#cbd5e1',
            },
            margin: { t: 4, b: 4, l: 0, r: 10 },
            paper_bgcolor: 'transparent',
            plot_bgcolor: 'transparent',
            height: 360,
          }}
          config={{ displayModeBar: false, responsive: true }}
          style={{ width: '100%' }}
          useResizeHandler
        />
      ) : (
        <Text style={{ fontSize: 12, color: '#9ca3af', padding: '8px 12px', display: 'block' }}>
          No city names could be geocoded for SVR_LOC values.
        </Text>
      )}

      {unresolvedCities.length > 0 && (
        <div style={{ padding: '6px 12px', borderTop: '1px solid #f1f5f9', marginTop: 4 }}>
          <Text style={{ fontSize: 10, color: '#6b7280', display: 'block', marginBottom: 4 }}>
            Other / unresolved city values:
          </Text>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
            {unresolvedCities.slice(0, 20).map(({ city, count }) => (
              <span
                key={city}
                style={{ fontSize: 10, background: '#f1f5f9', borderRadius: 3, padding: '1px 6px', color: '#374151' }}
              >
                {city || '(blank)'}: {count.toLocaleString()}
              </span>
            ))}
            {unresolvedCities.length > 20 && (
              <span style={{ fontSize: 10, color: '#9ca3af' }}>+{unresolvedCities.length - 20} more</span>
            )}
          </div>
        </div>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------
type DataRow = { values?: Record<string, unknown> } | Record<string, unknown>;

interface SystemComponentSummaryProps {
  dataType: string;
  batchCount: number;
  dataRows: DataRow[];
  dataColumns: string[];
  isLoaded: boolean;
  neighborhoodName?: string;
  readOnly?: boolean;
  onDeleteAllComponents?: () => void;
  deleteLoading?: boolean;
}

type DistributionMap = Map<string, Array<{ value: string; count: number }>>;
type LocationSummary = {
  stateCounts?: Array<{ state: string; count: number }>;
  cityCounts?: Array<{ city: string; count: number }>;
} | null;

export default function SystemComponentSummary({
  dataType,
  batchCount,
  dataRows,
  dataColumns,
  neighborhoodName,
  readOnly,
  onDeleteAllComponents,
  deleteLoading,
}: SystemComponentSummaryProps) {
  const isSuccess = batchCount > 0;

  const [distLoading, setDistLoading] = useState(true);
  const [distError, setDistError] = useState<string | null>(null);
  const [recordCount, setRecordCount] = useState<number>(batchCount * BATCH_SIZE);
  const [distMap, setDistMap] = useState<DistributionMap>(new Map());
  const [aggregateColumns, setAggregateColumns] = useState<string[]>([]);
  const [locationSummary, setLocationSummary] = useState<LocationSummary>(null);

  useEffect(() => {
    if (!dataType) return;
    let cancelled = false;
    setDistLoading(true);
    setDistError(null);
    getDataDistributions(dataType, neighborhoodName)
      .then((res) => {
        if (cancelled) return;
        if (res.recordCount) setRecordCount(res.recordCount);
        const m: DistributionMap = new Map();
        for (const { column, valueCounts } of res.distributions) {
          m.set(column.trim(), valueCounts);
        }
        setDistMap(m);
        setAggregateColumns(Array.isArray(res.aggregateColumns) ? res.aggregateColumns.map((column) => String(column || '').trim()).filter(Boolean) : []);
        setLocationSummary(res.locationSummary || null);
      })
      .catch((err) => {
        if (!cancelled) setDistError(err?.message || 'Failed to load distributions');
      })
      .finally(() => {
        if (!cancelled) setDistLoading(false);
      });
    return () => { cancelled = true; };
  }, [dataType, neighborhoodName]);

  /** Case-insensitive lookup in the distribution map */
  const getValueCounts = (col: string): Array<{ value: string; count: number }> => {
    const norm = col.trim().toLowerCase();
    for (const [k, v] of distMap.entries()) {
      if (k.toLowerCase() === norm) return v;
    }
    return [];
  };

  const svrLocCounts = getValueCounts(SVR_LOC_COLUMN);
  const cityCounts = locationSummary?.cityCounts || [];
  const isServerTab = dataType.trim().toLowerCase().includes('server');
  // aggregateColumns is already the authoritative "show as a tile" list computed
  // server-side (suffix-matched, or cardinality-detected when a data type doesn't
  // use the Aggregate/Aggregator suffix convention at all) — don't re-filter it.
  const dynamicAggregateColumns = aggregateColumns;
  const tileColumns = isServerTab
    ? Array.from(new Set([...SERVER_PINNED_COLUMNS, ...dynamicAggregateColumns]))
    : dynamicAggregateColumns;
  const visibleTileColumns = tileColumns.filter((column) => getValueCounts(column).length > 0);

  return (
    <div style={{ padding: '20px 24px', display: 'flex', flexDirection: 'column', gap: 20 }}>
      {/* Status header */}
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          {isSuccess
            ? <CheckCircleOutlined style={{ color: '#52c41a', fontSize: 20 }} />
            : <ExclamationCircleOutlined style={{ color: '#faad14', fontSize: 20 }} />}
          <Title level={4} style={{ margin: 0, color: isSuccess ? '#166534' : '#92400e' }}>
            {isSuccess ? `${dataType} loaded successfully` : `No ${dataType} data found`}
          </Title>
        </div>

        {!readOnly && onDeleteAllComponents && (
          <Button danger size="small" style={{ fontSize: 14 }} onClick={onDeleteAllComponents} loading={deleteLoading}>
            Delete System Component Type
          </Button>
        )}
      </div>

      {/* Total Records */}
      <Row gutter={[16, 16]}>
        <Col xs={24} sm={8}>
          <Card size="small" styles={{ body: { padding: '16px 20px' } }}>
            <Statistic
              title={<span style={{ fontSize: 12, color: '#6b7280' }}>Total Records</span>}
              value={recordCount}
              prefix={<TableOutlined style={{ color: '#4096ff' }} />}
              valueStyle={{ color: '#1d4ed8', fontSize: 22 }}
              formatter={(v) => Number(v).toLocaleString()}
            />
          </Card>
        </Col>
      </Row>

      {distError && (
        <Card size="small" styles={{ body: { padding: '12px 16px' } }}>
          <Text style={{ color: '#f5222d', fontSize: 13 }}>{distError}</Text>
        </Card>
      )}

      {distLoading && !distError && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <Spin size="small" />
          <Text style={{ color: '#6b7280', fontSize: 13 }}>Loading distributions…</Text>
        </div>
      )}

      {!distLoading && !distError && (
        <>
          {/* Pinned aggregation tiles */}
          {visibleTileColumns.length > 0 && (
            <Row gutter={[12, 12]}>
              {visibleTileColumns.map((col, i) => (
              <Col key={col} xs={24} sm={12} lg={8}>
                <AggregationPanel
                  column={col}
                  valueCounts={getValueCounts(col)}
                  total={recordCount}
                  colorIndex={i}
                />
              </Col>
              ))}
            </Row>
          )}

          {/* Cost structure charts (columns ending in cost_grp_N, grouped by N) */}
          <CostGroupCharts dataColumns={dataColumns} dataRows={dataRows} />

          {/* SVR_LOC map — full width */}
          {svrLocCounts.length > 0 && (
            <SvrLocMap valueCounts={svrLocCounts} total={recordCount} />
          )}

          {/* City-level map for SVR_LOC */}
          {cityCounts.length > 0 && (
            <CityMap cityCounts={cityCounts} />
          )}
        </>
      )}
    </div>
  );
}
