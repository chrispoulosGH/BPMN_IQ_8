import { useEffect, useMemo, useState } from 'react';
import { Select, Spin, Empty } from 'antd';
import Plot from 'react-plotly.js';
import { getDashboardFeatureCost3D, type FeatureCostPoint } from '../api';

// Standard Plotly mesh3d box triangulation (8 vertices, 12 triangles / 2 per
// face) — same i/j/k index set used for every box in this chart, only the
// vertex coordinates and color change per segment.
const BOX_I = [7, 0, 0, 0, 4, 4, 6, 6, 4, 0, 3, 2];
const BOX_J = [3, 4, 1, 2, 5, 6, 5, 2, 0, 1, 6, 3];
const BOX_K = [0, 7, 2, 3, 6, 7, 1, 1, 5, 5, 7, 6];

function buildBox(xRange: [number, number], yRange: [number, number], zRange: [number, number]) {
  const [x0, x1] = xRange;
  const [y0, y1] = yRange;
  const [z0, z1] = zRange;
  return {
    x: [x0, x1, x1, x0, x0, x1, x1, x0],
    y: [y0, y0, y1, y1, y0, y0, y1, y1],
    z: [z0, z0, z0, z0, z1, z1, z1, z1],
  };
}

const FEATURE_COLORS = [
  '#1890ff', '#52c41a', '#faad14', '#f5222d', '#722ed1',
  '#13c2c2', '#eb2f96', '#fa8c16', '#a0d911', '#2f54eb',
  '#ff7a45', '#36cfc9', '#9254de', '#ffc53d', '#ff4d4f',
  '#597ef7', '#73d13d', '#ffa940', '#ff85c2', '#5cdbd3',
];

// Columns are spread apart along both X (one per application) and Z (one
// per year) — real gaps between them, unlike the old single-axis layout.
// Base footprint shrunk 60% (0.32 → 0.128) so columns read as slender
// towers with clear air between them rather than nearly touching blocks.
const COLUMN_HALF_WIDTH = 0.128;
const COLUMN_HALF_DEPTH = 0.128;

function formatMoney(value: number) {
  return `$${(value / 1000).toFixed(0)}K`;
}

const QUARTER_ORDER = ['Q1', 'Q2', 'Q3', 'Q4'];

export default function FeatureCost3DChart() {
  const [businessFlows, setBusinessFlows] = useState<string[]>([]);
  const [points, setPoints] = useState<FeatureCostPoint[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedFlow, setSelectedFlow] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    getDashboardFeatureCost3D()
      .then((result) => {
        setBusinessFlows(result.businessFlows);
        setPoints(result.points);
        setSelectedFlow((current) => current && result.businessFlows.includes(current) ? current : (result.businessFlows[0] || null));
      })
      .finally(() => setLoading(false));
  }, []);

  const flowPoints = useMemo(
    () => points.filter((p) => p.businessFlow === selectedFlow),
    [points, selectedFlow]
  );

  // Applications spread along the X axis — each gets its own column, not
  // stacked into a shared one.
  const flowApplications = useMemo(
    () => [...new Set(flowPoints.map((p) => p.application))].sort(),
    [flowPoints]
  );

  // Years spread along the Z axis, oldest at index 0 (back) through most
  // recent (front) — quarters within a year are combined onto that year's
  // column. Every year between the flow's earliest and latest gets its own
  // slot, even ones with no cost data at all (an empty gap in the grid),
  // rather than silently compressing away years that happen to have no
  // rows — a flow whose data covers e.g. 2000 and 2006 but nothing in
  // between still shows all 7 year positions.
  const timeSlots = useMemo(() => {
    if (!flowPoints.length) return [];
    const years = flowPoints.map((p) => p.year);
    const minYear = Math.min(...years);
    const maxYear = Math.max(...years);
    const slots = [];
    for (let year = minYear; year <= maxYear; year += 1) {
      slots.push({ year, label: String(year) });
    }
    return slots;
  }, [flowPoints]);

  // Stable feature-name -> color assignment across the whole dataset, so a
  // recurring feature (e.g. worked on across several quarters) reads as the
  // same color everywhere it appears, not just within one column.
  const featureColorMap = useMemo(() => {
    const map = new Map<string, string>();
    const allNames = [...new Set(points.flatMap((p) => p.features.map((f) => f.featureName)))].sort();
    allNames.forEach((name, idx) => map.set(name, FEATURE_COLORS[idx % FEATURE_COLORS.length]));
    return map;
  }, [points]);

  const traces = useMemo(() => {
    if (!flowPoints.length) return [];
    const plotTraces: any[] = [];

    // One column per (application, year) pair — applications separated
    // along X, years separated along Z — each column stacked bottom-to-top
    // by individual feature (not by application), colored per feature.
    flowApplications.forEach((app, appIdx) => {
      timeSlots.forEach((slot, slotIdx) => {
        const cellsForYear = flowPoints.filter((p) => p.application === app && p.year === slot.year);
        if (!cellsForYear.length) return;

        // Flatten every feature occurrence across the year's quarters into
        // one ordered stack (Q1 → Q4, largest cost first within a quarter).
        const featureEntries = cellsForYear
          .slice()
          .sort((a, b) => QUARTER_ORDER.indexOf(a.quarter) - QUARTER_ORDER.indexOf(b.quarter))
          .flatMap((cell) => cell.features.map((f) => ({ ...f, quarter: cell.quarter })))
          .sort((a, b) => QUARTER_ORDER.indexOf(a.quarter) - QUARTER_ORDER.indexOf(b.quarter) || b.devCost - a.devCost);

        let stackTop = 0;
        featureEntries.forEach((feature) => {
          if (feature.devCost <= 0) return;
          const bottom = stackTop;
          const top = stackTop + feature.devCost;
          stackTop = top;

          const box = buildBox(
            [appIdx - COLUMN_HALF_WIDTH, appIdx + COLUMN_HALF_WIDTH],
            [bottom, top],
            [slotIdx - COLUMN_HALF_DEPTH, slotIdx + COLUMN_HALF_DEPTH]
          );

          plotTraces.push({
            type: 'mesh3d',
            x: box.x, y: box.y, z: box.z,
            i: BOX_I, j: BOX_J, k: BOX_K,
            color: featureColorMap.get(feature.featureName) || FEATURE_COLORS[0],
            flatshading: true,
            opacity: 1,
            name: feature.featureName,
            showlegend: false,
            hovertext: `<b>${app}</b> — ${slot.label} ${feature.quarter}<br>${feature.featureName} (${feature.jiraFeatureKey})<br>${feature.featureDescription}<br>Cost: ${formatMoney(feature.devCost)}`,
            hoverinfo: 'text',
          });
        });
      });
    });

    return plotTraces;
  }, [flowPoints, flowApplications, timeSlots, featureColorMap]);

  if (loading) return <Spin size="large" style={{ display: 'block', margin: '48px auto' }} />;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', gap: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <span style={{ fontWeight: 500, fontSize: 13 }}>Business Process Flow:</span>
        <Select
          placeholder="Select a business process flow…"
          style={{ minWidth: 350, flex: 1, maxWidth: 600 }}
          size="small"
          value={selectedFlow || undefined}
          onChange={setSelectedFlow}
          options={businessFlows.map((f) => ({ label: f, value: f }))}
          showSearch
          filterOption={(input, option) => (option?.label ?? '').toLowerCase().includes(input.toLowerCase())}
        />
      </div>

      {!selectedFlow || !flowPoints.length ? (
        <Empty description="Select a business process flow with feature cost data" style={{ marginTop: 64 }} />
      ) : (
        <div style={{ flex: 1, minHeight: 500 }}>
          <div style={{ textAlign: 'center', marginBottom: 6 }}>
            <div style={{ fontSize: 20, fontWeight: 900, color: '#111827', fontFamily: 'Arial Black, sans-serif' }}>
              {selectedFlow}
            </div>
          </div>
          <Plot
            data={traces}
            layout={{
              autosize: true,
              uirevision: selectedFlow,
              margin: { l: 0, r: 0, t: 10, b: 80 },
              scene: {
                aspectmode: 'manual',
                aspectratio: {
                  x: Math.max(0.9, flowApplications.length * 0.28),
                  y: 1.1,
                  z: Math.max(0.9, timeSlots.length * 0.28),
                },
                // Cost is on the Y axis, but camera.up below points along Y so
                // it still reads as the "vertical" column height on screen.
                xaxis: {
                  title: { text: 'Application', font: { size: 14, color: '#f5222d' } },
                  tickvals: flowApplications.map((_, i) => i),
                  ticktext: flowApplications,
                  tickfont: { size: 10 },
                },
                yaxis: { title: { text: 'Dev Cost ($)', font: { size: 14, color: '#58a6ff' } }, tickfont: { size: 11 } },
                zaxis: {
                  title: { text: 'Year', font: { size: 14, color: '#52c41a' } },
                  tickvals: timeSlots.map((_, i) => i),
                  ticktext: timeSlots.map((s) => s.label),
                  tickfont: { size: 11 },
                },
                camera: { eye: { x: -1.7, y: -1.7, z: 1.1 }, up: { x: 0, y: 1, z: 0 } },
              },
              showlegend: false,
              paper_bgcolor: 'transparent',
            }}
            config={{ displayModeBar: false, scrollZoom: true }}
            useResizeHandler
            style={{ width: '100%', height: '100%' }}
          />
        </div>
      )}
    </div>
  );
}
