/**
 * GET /api/business-kpis/vehicles-sold?hours=24
 *
 * Vehicles sold, from production telemetry (Prometheus, PROMETHEUS_URL,
 * default http://localhost:9090). The process engine emits
 * business.vehicles.sold / business.sales.revenue once per sale, at the task
 * that completes it (delivery confirmation, fleet delivery, wholesale
 * completion) — so a vehicle that passes through several flows (retailing,
 * credit, warranty, delivery) is counted once.
 *
 * Returns totals by channel × condition, revenue, and an hourly series.
 * 503 { code: 'PROMETHEUS_UNREACHABLE' } when Prometheus can't be reached.
 */
const express = require('express');

const router = express.Router();
const PROMETHEUS_URL = (process.env.PROMETHEUS_URL || 'http://localhost:9090').replace(/\/+$/, '');
// Every sale is recorded with the flow that completed it (bpmn_process_name);
// series without it are from an earlier simulator build and are excluded.
const SOLD = 'business_vehicles_sold_total{bpmn_process_name!=""}';
const REVENUE = 'business_sales_revenue_USD_total{bpmn_process_name!=""}';

async function prom(path, params) {
  const url = `${PROMETHEUS_URL}${path}?${new URLSearchParams(params)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Prometheus ${res.status}`);
  const body = await res.json();
  if (body.status !== 'success') throw new Error(`Prometheus: ${body.error || 'query failed'}`);
  return body.data.result;
}

router.get('/vehicles-sold', async (req, res) => {
  const hours = Math.min(Math.max(Number(req.query.hours) || 24, 1), 24 * 30);
  const range = `${hours}h`;
  const end = Math.floor(Date.now() / 1000);
  const step = hours <= 48 ? 3600 : 6 * 3600;
  try {
    // increase() handles counter resets (a simulator restart) correctly. It
    // extrapolates slightly to the window edges, so whole-vehicle counts are
    // rounded. Every sale series is created at 0 when the engine starts, so a
    // series' first sale isn't lost.
    const inWindow = (metric, window) => `increase(${metric}[${window}])`;
    const [byChannel, revenue, series] = await Promise.all([
      prom('/api/v1/query', { query: `sum by (business_sale_channel, business_vehicle_condition) (${inWindow(SOLD, range)})` }),
      prom('/api/v1/query', { query: `sum by (business_sale_channel) (${inWindow(REVENUE, range)})` }),
      prom('/api/v1/query_range', {
        query: `sum by (business_sale_channel) (${inWindow(SOLD, `${step}s`)})`,
        start: String(end - hours * 3600 + step),
        end: String(end),
        step: String(step),
      }),
    ]);
    const revenueByChannel = Object.fromEntries(revenue.map((r) => [r.metric.business_sale_channel, Math.round(Number(r.value[1]) || 0)]));
    const channels = byChannel
      .map((r) => ({
        channel: r.metric.business_sale_channel || 'unknown',
        condition: r.metric.business_vehicle_condition || 'unknown',
        units: Math.round(Number(r.value[1]) || 0), // whole vehicles
        revenue: revenueByChannel[r.metric.business_sale_channel] || 0,
      }))
      .sort((a, b) => b.units - a.units);
    const sum = (list, pick) => list.reduce((n, item) => n + pick(item), 0);
    res.json({
      generatedAt: new Date().toISOString(),
      hours,
      stepSeconds: step,
      totalUnits: sum(channels, (c) => c.units),
      newUnits: sum(channels.filter((c) => c.condition === 'new'), (c) => c.units),
      usedUnits: sum(channels.filter((c) => c.condition === 'used'), (c) => c.units),
      revenue: Object.values(revenueByChannel).reduce((a, b) => a + b, 0),
      channels,
      // Every bucket in the window, zero-filled (Prometheus omits steps with no series).
      buckets: Array.from({ length: Math.floor((hours * 3600) / step) }, (_, i) => (end - hours * 3600 + step * (i + 1)) * 1000),
      series: series.map((s) => ({
        channel: s.metric.business_sale_channel || 'unknown',
        points: s.values.map(([t, v]) => ({ t: Number(t) * 1000, units: Math.round(Number(v) || 0) })),
      })),
      definition: 'A vehicle counts as sold when it changes hands: delivery confirmation (online and in-store retail), fleet delivery (every unit), or wholesale completion (used). Counted once per deal, not per flow.',
    });
  } catch (error) {
    const unreachable = /fetch failed|ECONNREFUSED|Prometheus \d+/.test(String(error?.message || ''));
    console.error('[business-kpis] vehicles-sold failed:', error?.message || error);
    res.status(unreachable ? 503 : 500).json({
      error: unreachable ? `Could not reach Prometheus at ${PROMETHEUS_URL}. Is the mock production stack running?` : (error?.message || 'Failed'),
      code: unreachable ? 'PROMETHEUS_UNREACHABLE' : 'KPI_FAILED',
    });
  }
});

module.exports = router;
