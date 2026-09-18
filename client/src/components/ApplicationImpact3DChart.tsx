import { useMemo } from 'react';
import { Empty } from 'antd';
import Plot from 'react-plotly.js';
import type { JiraApplicationImpact } from '../types';

interface ApplicationImpact3DChartProps {
  applications: JiraApplicationImpact[];
  flowName?: string;
}

// Same 6-tier scale/labels Flow3DChart.tsx uses for its own criticality axis
// (Y there, Z here) — kept in sync by hand since neither file exports it,
// but any change to one should be mirrored in the other for visual
// consistency across the app's 3D charts.
const CRITICALITY_LABELS = [
  'Deferrable',
  'Non-Essential',
  'Admin',
  'Business Operational',
  'Business Critical',
  'Mission Critical',
];

function criticalityIndex(val: string | null): number {
  const v = (val || '').toLowerCase().replace(/_/g, ' ');
  if (v.includes('defer')) return 0;
  if (v.includes('non') && v.includes('essential')) return 1;
  if (v.includes('admin')) return 2;
  if (v.includes('operational')) return 3;
  if (v.includes('mission')) return 5;
  if (v.includes('business') && v.includes('critical')) return 4;
  if (v.includes('critical')) return 4;
  return 0; // Unknown/unclassified → lowest bucket
}

// Sequential ramp (light → dark blue) for the criticality color axis — a
// magnitude/severity dimension gets one hue light-to-dark, not a categorical
// palette (there's only one "series" here: applications for one flow).
const CRITICALITY_COLORSCALE: [number, string][] = [
  [0, '#d6e8ff'],
  [0.5, '#4096ff'],
  [1, '#0a2a6e'],
];

export default function ApplicationImpact3DChart({ applications, flowName }: ApplicationImpact3DChartProps) {
  const { trace, fallbackDateIso, hasFallback } = useMemo(() => {
    const realTimes = applications
      .map((a) => (a.nearestDueDate ? new Date(a.nearestDueDate).getTime() : null))
      .filter((t): t is number => t !== null && !Number.isNaN(t));
    const fallbackTime = realTimes.length
      ? Math.max(...realTimes) + 60 * 86400000
      : Date.now() + 180 * 86400000;
    const fallbackIso = new Date(fallbackTime).toISOString().slice(0, 10);
    let usedFallback = false;

    const x: number[] = [];
    const y: string[] = [];
    const z: number[] = [];
    const color: number[] = [];
    const size: number[] = [];
    const text: string[] = [];
    const hover: string[] = [];

    for (const app of applications) {
      const critIdx = criticalityIndex(app.businessCriticality);
      const dueIso = app.nearestDueDate || fallbackIso;
      if (!app.nearestDueDate) usedFallback = true;

      x.push(app.issueCount);
      y.push(dueIso);
      z.push(critIdx);
      color.push(critIdx);
      size.push(Math.min(34, 12 + Math.sqrt(app.issueCount) * 5));
      text.push(app.name);
      hover.push(
        `<b>${app.name}</b><br>` +
        `Issues: ${app.issueCount}<br>` +
        `${app.nearestDueDate ? `Nearest due: ${app.nearestDueDate}` : 'No due date set (estimated position)'}<br>` +
        `Criticality: ${app.businessCriticality || 'Unknown'}<extra></extra>`
      );
    }

    return {
      trace: {
        type: 'scatter3d' as const,
        mode: 'markers+text' as const,
        x, y, z,
        text,
        textposition: 'top center' as const,
        textfont: { size: 11, color: '#334155' },
        hovertemplate: hover,
        marker: {
          size,
          color,
          colorscale: CRITICALITY_COLORSCALE,
          cmin: 0,
          cmax: 5,
          opacity: 0.9,
          showscale: true,
          colorbar: {
            title: { text: 'Criticality', font: { size: 12 } },
            tickvals: CRITICALITY_LABELS.map((_, i) => i),
            ticktext: CRITICALITY_LABELS,
            tickfont: { size: 10 },
            len: 0.7,
          },
          line: { color: '#ffffff', width: 1 },
        },
      },
      fallbackDateIso: fallbackIso,
      hasFallback: usedFallback,
    };
  }, [applications]);

  if (!applications.length) {
    return (
      <Empty
        description="No application-level Jira links for this flow yet (issues here only name the flow itself)"
        style={{ marginTop: 48 }}
      />
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 420 }}>
      {flowName && (
        <div style={{ textAlign: 'center', fontSize: 14, fontWeight: 700, color: '#111827', marginBottom: 4 }}>
          {flowName} — Impacted Applications
        </div>
      )}
      {hasFallback && (
        <div style={{ textAlign: 'center', fontSize: 11, color: '#94a3b8', marginBottom: 4 }}>
          Applications with no due date are plotted past {fallbackDateIso} (estimated)
        </div>
      )}
      <div style={{ flex: 1, minHeight: 380 }}>
        <Plot
          data={[trace]}
          layout={{
            autosize: true,
            uirevision: flowName,
            margin: { l: 0, r: 0, t: 10, b: 10 },
            scene: {
              xaxis: {
                title: { text: 'Number of Issues', font: { size: 12, color: '#52c41a' } },
                tickfont: { size: 10.5 },
                dtick: 1,
              },
              yaxis: {
                title: { text: 'Nearest Due Date', font: { size: 12, color: '#58a6ff' } },
                type: 'date',
                tickfont: { size: 10 },
              },
              zaxis: {
                title: { text: 'Criticality', font: { size: 12, color: '#f5222d' } },
                tickvals: CRITICALITY_LABELS.map((_, i) => i),
                ticktext: CRITICALITY_LABELS,
                tickfont: { size: 10 },
                range: [0, 5],
              },
              camera: { eye: { x: 1.6, y: -1.8, z: 0.9 } },
            },
            paper_bgcolor: 'transparent',
            showlegend: false,
          }}
          config={{ displayModeBar: false, scrollZoom: true }}
          useResizeHandler
          style={{ width: '100%', height: '100%' }}
        />
      </div>
    </div>
  );
}
