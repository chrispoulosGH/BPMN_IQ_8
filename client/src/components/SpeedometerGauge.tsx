import Plot from 'react-plotly.js';

export interface SpeedometerGaugeProps {
  label: string;
  value: number;
  /** Axis ceiling — callers compute this once from the baseline reading so
   * both panels' matching gauge share the same scale and stay visually
   * comparable as the edit panel's needle moves. */
  max: number;
  /** Baseline reading to compare against — when set, shows a delta arrow
   * (red = worse/higher, green = better/lower, since all four of this
   * screen's metrics are "more is worse"). Omit on the read-only panel's
   * own gauges, which *are* the baseline. */
  reference?: number;
  prefix?: string;
  suffix?: string;
  /** d3-format spec for the number/delta/axis-tick display. Default is
   * SI-prefix compact ("12.3k") — pass '.0f' for a plain integer (percents,
   * counts). */
  valueFormat?: string;
}

// Same green/amber/red vocabulary as everywhere else in this app
// (Dashboard.tsx RISK_COLORS, utils/domainExposure.ts RAG_COLOR) — generic
// low/mid/high thirds of the gauge's own range, since none of these four
// metrics has one universal, objectively-correct threshold the way "is this
// issue overdue" does.
const BAND_COLORS = ['#e6f7d9', '#fff1c2', '#ffd9d6'];

export default function SpeedometerGauge({ label, value, max, reference, prefix, suffix, valueFormat = '.3~s' }: SpeedometerGaugeProps) {
  const axisMax = Math.max(max, value * 1.05, 1);
  const third = axisMax / 3;

  const trace: any = {
    type: 'indicator',
    mode: reference !== undefined ? 'gauge+number+delta' : 'gauge+number',
    value,
    number: { prefix, suffix, valueformat: valueFormat, font: { size: 13 } },
    delta: reference !== undefined ? {
      reference,
      increasing: { color: '#f5222d' },
      decreasing: { color: '#52c41a' },
      valueformat: valueFormat,
      font: { size: 8 },
    } : undefined,
    gauge: {
      axis: { range: [0, axisMax], tickfont: { size: 6 } },
      bar: { color: '#2563eb', thickness: 0.35 },
      bgcolor: 'white',
      borderwidth: 1,
      bordercolor: '#e2e8f0',
      steps: [
        { range: [0, third], color: BAND_COLORS[0] },
        { range: [third, third * 2], color: BAND_COLORS[1] },
        { range: [third * 2, axisMax], color: BAND_COLORS[2] },
      ],
    },
    title: { text: label, font: { size: 9, color: '#475569' } },
    domain: { x: [0, 1], y: [0, 1] },
  };

  return (
    <div className="h-[75px] w-full">
      <Plot
        data={[trace]}
        layout={{
          margin: { t: 20, b: 2, l: 8, r: 8 },
          paper_bgcolor: 'transparent',
          font: { family: '"IBM Plex Sans", Arial, sans-serif' },
        }}
        config={{ staticPlot: true, responsive: true, displaylogo: false }}
        style={{ width: '100%', height: '100%' }}
      />
    </div>
  );
}
