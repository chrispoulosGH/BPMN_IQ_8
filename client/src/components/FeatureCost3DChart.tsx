import { useEffect, useMemo, useRef, useState } from 'react';
import { Select, Spin, Empty, Button } from 'antd';
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

// One base hue per business flow — every application within that flow is a
// different lightness of this same hue, so at a glance all of a flow's
// columns read as one color family, distinguished from another flow's.
const FLOW_HUES = [210, 15, 140, 285, 340, 45, 190, 265, 100, 320, 5, 165];
const APP_SATURATION = 62;
// Lightness range spread across a flow's applications, darkest to lightest.
const APP_LIGHTNESS_MIN = 30;
const APP_LIGHTNESS_MAX = 72;
// Divider drawn between adjacent stacked features within the same column —
// a horizontal ring at each feature's top boundary — so features are still
// visually distinguishable even though they no longer have their own color.
// Soft dark gray, thin — a subtle seam rather than a bold outline.
const FEATURE_DIVIDER_COLOR = 'rgba(0,0,0,0.35)';
// The ring is drawn a hair outside the box's own footprint rather than
// perfectly flush with it — sitting exactly on the mesh surface caused
// z-fighting against the two abutting mesh3d faces (the line would flicker
// in and out depending on viewing angle, effectively invisible). Only a
// small nudge is needed to fix that, not a visible protrusion.
const DIVIDER_MARGIN = 0.008;

// Z stays slender (one column per year reads as a distinct slice), but X is
// widened to exactly half the 1-unit spacing between application
// categories, so adjacent applications in the same year touch edge-to-edge
// with no gap — one connected "wall" of columns per year — instead of
// standing apart as separate towers.
const COLUMN_HALF_WIDTH = 0.5;
const COLUMN_HALF_DEPTH = 0.128;
// Extra spacing inserted between one business flow's block of application
// columns and the next, so multiple flows on the same chart read as
// distinct clusters along X rather than one continuous run.
const FLOW_GROUP_GAP = 1.2;

function formatMoney(value: number) {
  return `$${(value / 1000).toFixed(0)}K`;
}

const QUARTER_ORDER = ['Q1', 'Q2', 'Q3', 'Q4'];

interface TimeSlot {
  year: number;
  quarter?: string;
  label: string;
}

interface XCategory {
  key: string;
  label: string;
  flow: string;
  application: string;
  x: number;
}

interface FeatureCost3DChartProps {
  // External request to jump straight to one business flow (e.g. from the
  // Business Flow Comparison dev-cost chart) — replaces the current flow
  // selection with just this one. The nonce forces re-application even if
  // the same flow is requested twice in a row.
  requestedFlow?: { flow: string; nonce: number } | null;
}

export default function FeatureCost3DChart({ requestedFlow }: FeatureCost3DChartProps = {}) {
  const [businessFlows, setBusinessFlows] = useState<string[]>([]);
  const [points, setPoints] = useState<FeatureCostPoint[]>([]);
  const [loading, setLoading] = useState(true);
  // Multiple flows can be plotted together on the same grid now.
  const [selectedFlows, setSelectedFlows] = useState<string[]>([]);
  // Which years, and which quarters within them, actually get a Z-axis slot
  // — both start as "everything available" once the data loads, and the
  // user narrows them down from there. Leaving Quarters empty combines each
  // selected year into a single yearly-total column; picking one or more
  // quarters breaks every selected year down into just those quarters.
  const [selectedYears, setSelectedYears] = useState<number[]>([]);
  const [selectedQuarters, setSelectedQuarters] = useState<string[]>([]);
  // Bumped by the "Reset View" button — folded into uirevision below so
  // Plotly discards whatever camera position the user dragged/zoomed to and
  // reverts to the straight-on default computed in the layout.
  const [resetKey, setResetKey] = useState(0);

  useEffect(() => {
    setLoading(true);
    getDashboardFeatureCost3D()
      .then((result) => {
        setBusinessFlows(result.businessFlows);
        setPoints(result.points);
        setSelectedFlows((current) => {
          const stillValid = current.filter((f) => result.businessFlows.includes(f));
          if (stillValid.length) return stillValid;
          return result.businessFlows[0] ? [result.businessFlows[0]] : [];
        });
        const allYears = [...new Set(result.points.map((p) => p.year))].sort((a, b) => a - b);
        setSelectedYears((current) => current.length ? current.filter((y) => allYears.includes(y)) : allYears);
      })
      .finally(() => setLoading(false));
  }, []);

  // Applies an external "jump to this flow" request (e.g. from the
  // Business Flow Comparison dev-cost chart) once the flow list has
  // loaded and actually contains it. Only applied once per nonce so it
  // doesn't fight the user's own subsequent flow-selection changes.
  const appliedFlowRequestNonceRef = useRef<number | null>(null);
  useEffect(() => {
    if (!requestedFlow) return;
    if (appliedFlowRequestNonceRef.current === requestedFlow.nonce) return;
    if (!businessFlows.includes(requestedFlow.flow)) return;
    appliedFlowRequestNonceRef.current = requestedFlow.nonce;
    setSelectedFlows([requestedFlow.flow]);
  }, [requestedFlow, businessFlows]);

  const availableYears = useMemo(
    () => [...new Set(points.map((p) => p.year))].sort((a, b) => a - b),
    [points]
  );

  const flowPoints = useMemo(
    () => points.filter((p) => selectedFlows.includes(p.businessFlow)),
    [points, selectedFlows]
  );

  // X categories: each selected flow's applications, grouped together and
  // separated from the next flow's group by FLOW_GROUP_GAP. Keyed by
  // flow+application (not application alone) so the same app used by two
  // different flows still gets its own column in each flow's group.
  const xCategories = useMemo(() => {
    const categories: XCategory[] = [];
    let cursor = 0;
    selectedFlows.forEach((flow, flowIdx) => {
      const apps = [...new Set(flowPoints.filter((p) => p.businessFlow === flow).map((p) => p.application))].sort();
      if (!apps.length) return;
      if (flowIdx > 0 && categories.length) cursor += FLOW_GROUP_GAP;
      apps.forEach((app) => {
        categories.push({ key: `${flow}||${app}`, label: app, flow, application: app, x: cursor });
        cursor += 1;
      });
    });
    return categories;
  }, [selectedFlows, flowPoints]);

  // Z-axis slots driven directly by the Years/Quarters filters, oldest at
  // index 0 (back) through most recent (front) — a selected year still
  // gets its own slot (or slots) even if none of the currently selected
  // flows have any cost data in it, rather than silently disappearing.
  const timeSlots = useMemo((): TimeSlot[] => {
    const years = selectedYears.slice().sort((a, b) => a - b);
    const quarters = QUARTER_ORDER.filter((q) => selectedQuarters.includes(q));
    const slots: TimeSlot[] = [];
    years.forEach((year) => {
      if (!quarters.length) {
        slots.push({ year, label: String(year) });
      } else {
        quarters.forEach((quarter) => {
          slots.push({ year, quarter, label: `${year} ${quarter}` });
        });
      }
    });
    return slots;
  }, [selectedYears, selectedQuarters]);

  // Stable flow -> base hue assignment, from the full flow list (not just
  // whichever ones happen to be selected right now), so a flow's color
  // family never shifts depending on what else is plotted alongside it.
  const flowHueMap = useMemo(() => {
    const map = new Map<string, number>();
    businessFlows.forEach((flow, idx) => map.set(flow, FLOW_HUES[idx % FLOW_HUES.length]));
    return map;
  }, [businessFlows]);

  // Every application's color = its flow's hue at a lightness unique to
  // that application within the flow (darkest to lightest across the
  // flow's own application list) — so all of one flow's columns read as
  // shades of the same color, distinct from another flow's shades.
  const categoryColorMap = useMemo(() => {
    const map = new Map<string, string>();
    selectedFlows.forEach((flow) => {
      const hue = flowHueMap.get(flow) ?? FLOW_HUES[0];
      const apps = [...new Set(flowPoints.filter((p) => p.businessFlow === flow).map((p) => p.application))].sort();
      const count = apps.length;
      apps.forEach((app, idx) => {
        const lightness = count <= 1
          ? (APP_LIGHTNESS_MIN + APP_LIGHTNESS_MAX) / 2
          : APP_LIGHTNESS_MIN + (idx * (APP_LIGHTNESS_MAX - APP_LIGHTNESS_MIN)) / (count - 1);
        map.set(`${flow}||${app}`, `hsl(${hue}, ${APP_SATURATION}%, ${lightness}%)`);
      });
    });
    return map;
  }, [selectedFlows, flowPoints, flowHueMap]);

  const traces = useMemo(() => {
    if (!flowPoints.length || !xCategories.length) return [];
    const plotTraces: any[] = [];
    let maxStackTop = 0;

    // One column per (flow+application, year[/quarter]) pair — applications
    // (grouped by flow) separated along X, time slots separated along Z —
    // each column stacked bottom-to-top by individual feature, all one
    // solid color per application, with a thin divider ring drawn at each
    // feature boundary so the stack segments stay visually distinguishable.
    // Total column height per (category, time slot) — including 0 for slots
    // with no data — so the year-to-year connecting ribbon below has a
    // height to bridge to/from even where a column itself isn't drawn.
    const columnTops = new Map<string, number[]>();

    xCategories.forEach((cat) => {
      const appColor = categoryColorMap.get(cat.key) || `hsl(${FLOW_HUES[0]}, ${APP_SATURATION}%, ${APP_LIGHTNESS_MIN}%)`;
      const heights = new Array(timeSlots.length).fill(0);
      columnTops.set(cat.key, heights);
      timeSlots.forEach((slot, slotIdx) => {
        const cellsForSlot = flowPoints.filter((p) =>
          p.businessFlow === cat.flow &&
          p.application === cat.application &&
          p.year === slot.year &&
          (!slot.quarter || p.quarter === slot.quarter)
        );
        if (!cellsForSlot.length) return;

        // Flatten every feature occurrence in this slot's cell(s) into one
        // ordered stack (Q1 → Q4 when combined by year, largest cost first
        // within a quarter).
        const featureEntries = cellsForSlot
          .slice()
          .sort((a, b) => QUARTER_ORDER.indexOf(a.quarter) - QUARTER_ORDER.indexOf(b.quarter))
          .flatMap((cell) => cell.features.map((f) => ({ ...f, quarter: cell.quarter })))
          .sort((a, b) => QUARTER_ORDER.indexOf(a.quarter) - QUARTER_ORDER.indexOf(b.quarter) || b.devCost - a.devCost);

        const xMin = cat.x - COLUMN_HALF_WIDTH;
        const xMax = cat.x + COLUMN_HALF_WIDTH;
        const zMin = slotIdx - COLUMN_HALF_DEPTH;
        const zMax = slotIdx + COLUMN_HALF_DEPTH;

        let stackTop = 0;
        featureEntries.forEach((feature) => {
          if (feature.devCost <= 0) return;
          const bottom = stackTop;
          const top = stackTop + feature.devCost;
          stackTop = top;
          if (top > maxStackTop) maxStackTop = top;

          const box = buildBox([xMin, xMax], [bottom, top], [zMin, zMax]);

          plotTraces.push({
            type: 'mesh3d',
            x: box.x, y: box.y, z: box.z,
            i: BOX_I, j: BOX_J, k: BOX_K,
            color: appColor,
            flatshading: true,
            opacity: 1,
            name: feature.featureName,
            showlegend: false,
            hovertext: `<b>${cat.flow}</b><br><b>${cat.application}</b> — ${slot.year} ${feature.quarter}<br>${feature.featureName} (${feature.jiraFeatureKey})<br>${feature.featureDescription}<br>Cost: ${formatMoney(feature.devCost)}`,
            hoverinfo: 'text',
          });

          // Divider ring at this feature's top boundary — draws the seam
          // between it and the next stacked feature (or caps the column if
          // it's the last one), since same-color segments would otherwise
          // blend into one solid block with no visible break between them.
          // Bulged out past the box edges by DIVIDER_MARGIN (see comment on
          // that constant) so it doesn't z-fight with the mesh faces.
          const dxMin = xMin - DIVIDER_MARGIN;
          const dxMax = xMax + DIVIDER_MARGIN;
          const dzMin = zMin - DIVIDER_MARGIN;
          const dzMax = zMax + DIVIDER_MARGIN;
          plotTraces.push({
            type: 'scatter3d',
            mode: 'lines',
            x: [dxMin, dxMax, dxMax, dxMin, dxMin],
            y: [top, top, top, top, top],
            z: [dzMin, dzMin, dzMax, dzMax, dzMin],
            line: { color: FEATURE_DIVIDER_COLOR, width: 3 },
            showlegend: false,
            hoverinfo: 'skip',
          });
        });

        heights[slotIdx] = stackTop;
      });
    });

    // Thin, translucent plane bridging each application's column from one
    // time slot to the next, tracing the top of the stack across the gap
    // between columns — a low-opacity "roof" in the same color as the
    // column it extends from, so the year-over-year cost trend for that
    // application reads as a connected ribbon rather than isolated bars.
    xCategories.forEach((cat) => {
      const heights = columnTops.get(cat.key);
      if (!heights) return;
      const appColor = categoryColorMap.get(cat.key) || `hsl(${FLOW_HUES[0]}, ${APP_SATURATION}%, ${APP_LIGHTNESS_MIN}%)`;
      const xMin = cat.x - COLUMN_HALF_WIDTH;
      const xMax = cat.x + COLUMN_HALF_WIDTH;

      for (let i = 0; i < timeSlots.length - 1; i += 1) {
        const heightA = heights[i];
        const heightB = heights[i + 1];
        if (heightA <= 0 && heightB <= 0) continue;

        const zBack = i + COLUMN_HALF_DEPTH;
        const zFront = (i + 1) - COLUMN_HALF_DEPTH;
        if (zFront <= zBack) continue;

        plotTraces.push({
          type: 'mesh3d',
          x: [xMin, xMax, xMax, xMin],
          y: [heightA, heightA, heightB, heightB],
          z: [zBack, zBack, zFront, zFront],
          i: [0, 0],
          j: [1, 2],
          k: [2, 3],
          color: appColor,
          opacity: 0.3,
          flatshading: true,
          showlegend: false,
          hoverinfo: 'skip',
        });
      }
    });

    // One floating label per business flow, centered over that flow's own
    // block of application columns — placed at a common height above the
    // tallest column on the whole chart (so all the labels line up rather
    // than bobbing up and down with each flow's own cost scale) and one
    // slot further forward than the front-most time slot, so nothing in
    // the grid ever renders in front of (and hides) the text.
    const labelY = maxStackTop * 1.12 || 1;
    const labelZ = timeSlots.length;
    selectedFlows.forEach((flow) => {
      const flowCategories = xCategories.filter((cat) => cat.flow === flow);
      if (!flowCategories.length) return;
      const centerX = flowCategories.reduce((sum, cat) => sum + cat.x, 0) / flowCategories.length;
      plotTraces.push({
        type: 'scatter3d',
        mode: 'text',
        x: [centerX],
        y: [labelY],
        z: [labelZ],
        text: [flow],
        textfont: { size: 13, color: '#111827' },
        showlegend: false,
        hoverinfo: 'skip',
      });
    });

    return plotTraces;
  }, [flowPoints, xCategories, timeSlots, categoryColorMap, selectedFlows]);

  if (loading) return <Spin size="large" style={{ display: 'block', margin: '48px auto' }} />;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', gap: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <span style={{ fontWeight: 500, fontSize: 13 }}>Business Process Flows:</span>
        <Select
          mode="multiple"
          placeholder="Select one or more business process flows…"
          style={{ minWidth: 350, flex: 1, maxWidth: 700 }}
          size="small"
          value={selectedFlows}
          onChange={setSelectedFlows}
          options={businessFlows.map((f) => ({ label: f, value: f }))}
          showSearch
          maxTagCount="responsive"
          filterOption={(input, option) => (option?.label ?? '').toLowerCase().includes(input.toLowerCase())}
        />
        <span style={{ fontWeight: 500, fontSize: 13 }}>Years:</span>
        <Select
          mode="multiple"
          placeholder="Years…"
          style={{ minWidth: 160, maxWidth: 280 }}
          size="small"
          value={selectedYears}
          onChange={setSelectedYears}
          options={availableYears.map((y) => ({ label: String(y), value: y }))}
          maxTagCount="responsive"
        />
        <span style={{ fontWeight: 500, fontSize: 13 }}>Quarters:</span>
        <Select
          mode="multiple"
          placeholder="All quarters combined"
          style={{ minWidth: 200, maxWidth: 280 }}
          size="small"
          value={selectedQuarters}
          onChange={setSelectedQuarters}
          options={QUARTER_ORDER.map((q) => ({ label: q, value: q }))}
          maxTagCount="responsive"
        />
        <Button size="small" onClick={() => setResetKey((k) => k + 1)}>Reset View</Button>
      </div>

      {!selectedFlows.length || !flowPoints.length || !timeSlots.length ? (
        <Empty description="Select at least one business process flow with feature cost data" style={{ marginTop: 64 }} />
      ) : (() => {
        const xAspect = Math.max(0.9, xCategories.length * 0.28 + (selectedFlows.length - 1) * 0.15);
        const zAspect = Math.max(0.9, timeSlots.length * (selectedQuarters.length ? 0.1 : 0.28));
        return (
        <div style={{ flex: 1, minHeight: 280 }}>
          <div style={{ textAlign: 'center', marginBottom: 6 }}>
            <div style={{ fontSize: selectedFlows.length > 1 ? 15 : 20, fontWeight: 900, color: '#111827', fontFamily: 'Arial Black, sans-serif' }}>
              {selectedFlows.join('  ·  ')}
            </div>
          </div>
          <Plot
            data={traces}
            layout={{
              autosize: true,
              uirevision: `${selectedFlows.join('|')}::${selectedYears.join(',')}::${selectedQuarters.join(',')}::${resetKey}`,
              margin: { l: 0, r: 0, t: 10, b: 80 },
              scene: {
                aspectmode: 'manual',
                aspectratio: { x: xAspect, y: 1.1, z: zAspect },
                // Cost is on the Y axis, but camera.up below points along Y so
                // it still reads as the "vertical" column height on screen.
                xaxis: {
                  title: { text: 'Application', font: { size: 14, color: '#f5222d' } },
                  tickvals: xCategories.map((c) => c.x),
                  ticktext: xCategories.map((c) => c.label),
                  tickfont: { size: 10 },
                },
                yaxis: { title: { text: 'Dev Cost ($)', font: { size: 14, color: '#58a6ff' } }, tickfont: { size: 11 } },
                zaxis: {
                  title: { text: selectedQuarters.length ? 'Year / Quarter' : 'Year', font: { size: 14, color: '#52c41a' } },
                  tickvals: timeSlots.map((_, i) => i),
                  ticktext: timeSlots.map((s) => s.label),
                  tickfont: { size: selectedQuarters.length ? 9 : 11 },
                },
                // Straight-on view: eye sits purely on the Z axis (no x/y
                // offset), so X (application) and Y (cost) render flat
                // against the screen — perpendicular to the viewing
                // direction — while Z (year) recedes directly into the
                // page. Eye.z is positioned well beyond the most-recent-year
                // end of the box, so the newest year renders closest to the
                // viewer and the oldest year is furthest away.
                camera: { eye: { x: 0, y: 0, z: zAspect * 2.2 }, up: { x: 0, y: 1, z: 0 } },
              },
              showlegend: false,
              paper_bgcolor: 'transparent',
            }}
            config={{ displayModeBar: false, scrollZoom: true }}
            useResizeHandler
            style={{ width: '100%', height: '100%' }}
          />
        </div>
        );
      })()}
    </div>
  );
}
