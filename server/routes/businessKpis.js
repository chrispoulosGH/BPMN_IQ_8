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

/**
 * GET /api/business-kpis/metrics?hours=24
 *
 * The leadership measures derived from the business flows: each is counted
 * once, by the task that completes it (mockprod processEngine BUSINESS_METRICS
 * emits business.outcomes / business.outcome.value), plus Vehicles Sold from
 * the sales counters above. For each: total and USD value in the window, the
 * same for the window before it, a breakdown by dimension, and a zero-filled
 * series per dimension aligned to `buckets`.
 */
const BUSINESS_METRICS = [
  { id: 'vehicles_sold', label: 'Vehicles Sold', unit: 'vehicles', domain: 'Sales & Distribution', dimensionLabel: 'Channel', valueLabel: 'Revenue',
    source: 'New Vehicle Delivery Experience › Sign Delivery Confirmation; Fleet Order Fulfillment › Complete Fleet Delivery; Wholesale Vehicle Disposition › Complete Wholesale Sale',
    definition: 'A vehicle counts as sold when it changes hands (delivery, fleet delivery or wholesale completion), once per deal.' },
  { id: 'designs_released', label: 'New Designs Released', unit: 'designs', domain: 'Engineering & Product Development', dimensionLabel: 'Segment',
    source: 'New Model Development Program › Release for Production',
    definition: 'A new model design passes its final design gate and is released to production.' },
  { id: 'safety_certifications_passed', label: 'Safety Certifications Passed', unit: 'certifications', domain: 'Manufacturing & Supply Chain', dimensionLabel: 'Standard',
    source: 'Vehicle Safety Compliance Certification › Receive Certification',
    definition: 'A vehicle program receives its safety compliance certification.' },
  { id: 'vehicles_built', label: 'Vehicles Built', unit: 'vehicles', domain: 'Manufacturing & Supply Chain', dimensionLabel: 'Plant',
    source: 'Vehicle Assembly Line Execution › Release for Final Test',
    definition: 'Vehicles that complete assembly and are released to final test, counted per build lot.' },
  { id: 'quality_inspections_passed', label: 'Vehicles Passing Final Quality', unit: 'vehicles', domain: 'Manufacturing & Supply Chain', dimensionLabel: 'Plant',
    source: 'End-of-Line Quality Inspection › Release to Shipping',
    definition: 'Vehicles that pass end-of-line quality inspection and are released to shipping.' },
  { id: 'ota_updates_delivered', label: 'OTA Updates Delivered', unit: 'vehicles updated', domain: 'Engineering & Product Development', dimensionLabel: 'Software module',
    source: 'Over-the-Air Software Update › Track Success & Failures',
    definition: 'Vehicles that successfully installed an over-the-air software update.' },
  { id: 'repair_orders_closed', label: 'Repair Orders Closed', unit: 'repair orders', domain: 'After-Sales & Service', dimensionLabel: 'Pay type', valueLabel: 'Service revenue',
    source: 'Repair Order Completion › Close Repair Order',
    definition: 'Service repair orders that pass quality check and are closed.' },
  { id: 'warranty_claims_paid', label: 'Warranty Claims Paid', unit: 'claims', domain: 'After-Sales & Service', dimensionLabel: 'Component', valueLabel: 'Claim cost',
    source: 'Warranty Claim Submission › Receive Payment',
    definition: 'Warranty claims the OEM has paid the dealer for. Lower is better.', lowerIsBetter: true },
  { id: 'recall_repairs_completed', label: 'Recall Repairs Completed', unit: 'vehicles', domain: 'After-Sales & Service', dimensionLabel: 'Campaign',
    source: 'Recall Campaign Execution › Report Completion to OEM',
    definition: 'Vehicles repaired under a recall campaign and reported complete to the OEM.' },
  { id: 'finance_contracts_funded', label: 'Finance Contracts Funded', unit: 'contracts', domain: 'Finance & Insurance', dimensionLabel: 'Product', valueLabel: 'Amount funded',
    source: 'Finance Contract Funding › Reconcile Funding Amount',
    definition: 'Retail, lease and special-finance contracts funded and reconciled.' },
  { id: 'subscriptions_renewed', label: 'Connected Subscriptions Renewed', unit: 'subscriptions', domain: 'Connected Vehicle & Mobility', dimensionLabel: 'Plan', valueLabel: 'Renewal revenue',
    source: 'Connected Subscription Renewal › Activate Renewed Services',
    definition: 'Connected-vehicle subscriptions renewed and re-activated.' },
];
const OUTCOMES = 'business_outcomes_total{business_metric!=""}';
const OUTCOME_VALUE = 'business_outcome_value_USD_total{business_metric!=""}';
// window → series step: about 24 slots for short windows, daily beyond that
const STEP_FOR_HOURS = { 6: 900, 24: 3600, 168: 86400, 720: 86400 };

router.get('/metrics', async (req, res) => {
  const requested = Number(req.query.hours) || 24;
  const hours = STEP_FOR_HOURS[requested] ? requested : 24;
  const step = STEP_FOR_HOURS[hours];
  const range = `${hours}h`;
  const end = Math.floor(Math.floor(Date.now() / 1000) / step) * step + step; // align buckets to whole steps
  const start = end - hours * 3600 + step;
  const q = (query) => prom('/api/v1/query', { query });
  const qr = (query) => prom('/api/v1/query_range', { query, start: String(start), end: String(end), step: String(step) });
  try {
    const [cur, prev, val, prevVal, series, soldCur, soldPrev, revCur, revPrev, soldSeries] = await Promise.all([
      q(`sum by (business_metric, business_metric_dimension) (increase(${OUTCOMES}[${range}]))`),
      q(`sum by (business_metric) (increase(${OUTCOMES}[${range}] offset ${range}))`),
      q(`sum by (business_metric) (increase(${OUTCOME_VALUE}[${range}]))`),
      q(`sum by (business_metric) (increase(${OUTCOME_VALUE}[${range}] offset ${range}))`),
      qr(`sum by (business_metric, business_metric_dimension) (increase(${OUTCOMES}[${step}s]))`),
      q(`sum by (business_sale_channel) (increase(${SOLD}[${range}]))`),
      q(`sum(increase(${SOLD}[${range}] offset ${range}))`),
      q(`sum(increase(${REVENUE}[${range}]))`),
      q(`sum(increase(${REVENUE}[${range}] offset ${range}))`),
      qr(`sum by (business_sale_channel) (increase(${SOLD}[${step}s]))`),
    ]);
    // Bucket i covers [end - window + i·step, +step); the last one is the current, partial step.
    const buckets = Array.from({ length: Math.round((hours * 3600) / step) }, (_, i) => (end - hours * 3600 + step * i) * 1000);
    const bucketIndex = new Map(buckets.map((t, i) => [t, i]));
    const num = (v) => Math.round(Number(v) || 0);
    // Prometheus returns nothing when the previous window has no samples yet; that's "no comparison", not 0.
    const byMetric = (rows) => new Map(rows.map((r) => [r.metric.business_metric || 'vehicles_sold', num(r.value[1])]));
    const prevMap = byMetric(prev);
    const valMap = byMetric(val);
    const prevValMap = byMetric(prevVal);

    const metrics = BUSINESS_METRICS.map((def) => {
      const isSold = def.id === 'vehicles_sold';
      const dimRows = isSold
        ? soldCur.map((r) => ({ dimension: r.metric.business_sale_channel || 'unknown', total: num(r.value[1]) }))
        : cur.filter((r) => r.metric.business_metric === def.id).map((r) => ({ dimension: r.metric.business_metric_dimension || 'unknown', total: num(r.value[1]) }));
      const seriesRows = isSold
        ? soldSeries.map((s) => ({ dimension: s.metric.business_sale_channel || 'unknown', values: s.values }))
        : series.filter((s) => s.metric.business_metric === def.id).map((s) => ({ dimension: s.metric.business_metric_dimension || 'unknown', values: s.values }));
      const dimensionSeries = seriesRows.map((s) => {
        const points = new Array(buckets.length).fill(0);
        // A range-query point at time t covers the step ending at t → bucket that starts at t - step.
        for (const [t, v] of s.values) {
          const idx = bucketIndex.get((Number(t) - step) * 1000);
          if (idx !== undefined) points[idx] = num(v);
        }
        return { dimension: s.dimension, points };
      }).sort((a, b) => a.dimension.localeCompare(b.dimension));
      const previous = isSold ? (soldPrev[0] ? num(soldPrev[0].value[1]) : null) : (prevMap.has(def.id) ? prevMap.get(def.id) : null);
      const hasValue = Boolean(def.valueLabel);
      return {
        ...def,
        total: dimRows.reduce((n, d) => n + d.total, 0),
        previousTotal: previous,
        value: hasValue ? (isSold ? num(revCur[0]?.value[1]) : (valMap.get(def.id) || 0)) : null,
        previousValue: hasValue ? (isSold ? (revPrev[0] ? num(revPrev[0].value[1]) : null) : (prevValMap.has(def.id) ? prevValMap.get(def.id) : null)) : null,
        dimensions: dimRows.sort((a, b) => b.total - a.total),
        series: dimensionSeries,
      };
    });
    res.json({ generatedAt: new Date().toISOString(), hours, stepSeconds: step, buckets, metrics });
  } catch (error) {
    const unreachable = /fetch failed|ECONNREFUSED|Prometheus \d+/.test(String(error?.message || ''));
    console.error('[business-kpis] metrics failed:', error?.message || error);
    res.status(unreachable ? 503 : 500).json({
      error: unreachable ? `Could not reach Prometheus at ${PROMETHEUS_URL}. Is the mock production stack running?` : (error?.message || 'Failed'),
      code: unreachable ? 'PROMETHEUS_UNREACHABLE' : 'KPI_FAILED',
    });
  }
});


/**
 * GET /api/business-kpis/flow-efficiency?hours=24
 *
 * Throughput per cost, per business process flow, over time.
 *   throughput  completed instances per step (bpmn_process_instances_total,
 *               outcome=completed); failed and abandoned runs don't count
 *   cost        the flow's annual TCO (same allocation as the Dashboard
 *               scorecards: application run cost by task-usage share + the
 *               flow's feature dev spend, latest year), prorated to the step
 *   raw index   completed transactions per $1,000 of cost in that step
 *   index       the raw index rebased so the flow's window average = 100;
 *               flows of very different size and cost then share one scale
 *   trend       least-squares slope of the index, as index points over the
 *               window; favorable (up) / unfavorable (down) only when
 *               |t| >= 2 (about 95% confidence), otherwise steady
 * Only whole steps are returned (the current, partial step would read as a
 * drop). Steps with no telemetry are null, not 0, and are left out of the
 * statistics.
 */
const { buildTcoCalculator, loadTcoInputs, scorecardNorm } = require('./dashboard');
const COMPLETED = 'bpmn_process_instances_total{bpmn_process_outcome="completed",bpmn_process_name!=""}';
const SECONDS_PER_YEAR = 365 * 86400;
let tcoCache = { at: 0, value: null };
async function flowTcoByName() {
  if (tcoCache.value && Date.now() - tcoCache.at < 5 * 60 * 1000) return tcoCache.value;
  const inputs = await loadTcoInputs();
  const tcoFor = buildTcoCalculator(inputs);
  const byName = new Map();
  const clean = (v) => String(v || '').replace(/&amp;/g, '&').replace(/&#38;/g, '&');
  for (const d of inputs.diagrams) {
    const info = {
      diagramId: String(d._id),
      name: clean(d.name),
      domain: clean(d.domain) || 'Unassigned',
      neighborhoodName: d.neighborhoodName || null,
      tco: tcoFor(d),
    };
    for (const key of [scorecardNorm(d.name), scorecardNorm(d.businessFlow)].filter(Boolean)) {
      if (!byName.has(key)) byName.set(key, info);
    }
  }
  tcoCache = { at: Date.now(), value: { byName, year: tcoFor.latestYear || null } };
  return tcoCache.value;
}

const NO_TREND = (observedSteps) => ({ slope: null, t: null, change: null, verdict: 'insufficient', observedSteps });

/** Least-squares trend of the non-null points; change = slope across the whole window, in index points. */
function trendOf(values) {
  const pts = values.map((y, x) => [x, y]).filter(([, y]) => y !== null);
  const n = pts.length;
  if (n < 6) return NO_TREND(n);
  const mx = pts.reduce((a, [x]) => a + x, 0) / n;
  const my = pts.reduce((a, [, y]) => a + y, 0) / n;
  const sxx = pts.reduce((a, [x]) => a + (x - mx) ** 2, 0);
  const slope = pts.reduce((a, [x, y]) => a + (x - mx) * (y - my), 0) / sxx;
  const sse = pts.reduce((a, [x, y]) => a + (y - (my + slope * (x - mx))) ** 2, 0);
  const se = Math.sqrt(sse / (n - 2) / sxx);
  const t = se > 0 ? slope / se : (slope === 0 ? 0 : Math.sign(slope) * 99);
  const verdict = Math.abs(t) >= 2 ? (slope > 0 ? 'favorable' : 'unfavorable') : 'steady';
  return { slope, t: Math.round(t * 100) / 100, change: Math.round(slope * (values.length - 1) * 10) / 10, verdict, observedSteps: n };
}

/** Raw index (per $1k) → rebased to window average = 100, plus its trend. */
function rebase(raw) {
  const observed = raw.filter((r) => r !== null);
  const mean = observed.length ? observed.reduce((a, b) => a + b, 0) / observed.length : 0;
  const index = raw.map((r) => (r === null || mean === 0 ? null : Math.round((r / mean) * 1000) / 10));
  return { mean, index, trend: mean === 0 ? NO_TREND(observed.length) : trendOf(index) };
}

router.get('/flow-efficiency', async (req, res) => {
  const requested = Number(req.query.hours) || 24;
  const hours = STEP_FOR_HOURS[requested] ? requested : 24;
  const step = STEP_FOR_HOURS[hours];
  const count = Math.round((hours * 3600) / step);
  const lastEnd = Math.floor(Date.now() / 1000 / step) * step; // end of the last whole step
  const firstEnd = lastEnd - (count - 1) * step;
  try {
    const [series, tcoInfo] = await Promise.all([
      prom('/api/v1/query_range', {
        query: `sum by (bpmn_process_name) (increase(${COMPLETED}[${step}s]))`,
        start: String(firstEnd), end: String(lastEnd), step: String(step),
      }),
      flowTcoByName(),
    ]);
    // Bucket i covers the step ending at firstEnd + i·step; labelled by its start.
    const buckets = Array.from({ length: count }, (_, i) => (firstEnd + (i - 1) * step) * 1000);
    const stepYears = step / SECONDS_PER_YEAR;
    const flows = [];
    const unmatched = [];
    const landscapeCompleted = new Array(count).fill(null);
    let landscapeCost = 0;
    for (const s of series) {
      const name = s.metric.bpmn_process_name;
      const info = tcoInfo.byName.get(scorecardNorm(name));
      const annualCost = info?.tco?.total || 0;
      if (!info || annualCost <= 0) { unmatched.push({ name, reason: info ? 'no cost data' : 'no diagram' }); continue; }
      const completed = new Array(count).fill(null);
      for (const [t, v] of s.values) {
        const idx = Math.round((Number(t) - firstEnd) / step);
        if (idx >= 0 && idx < count) completed[idx] = Math.max(0, Number(v) || 0);
      }
      landscapeCost += annualCost;
      completed.forEach((c, i) => { if (c !== null) landscapeCompleted[i] = (landscapeCompleted[i] || 0) + c; });
      const costPerStep = annualCost * stepYears;
      const raw = completed.map((c) => (c === null ? null : (c / costPerStep) * 1000));
      const { mean, index, trend } = rebase(raw);
      const observedSteps = completed.filter((c) => c !== null).length;
      const totalCompleted = completed.reduce((a, c) => a + (c || 0), 0);
      const windowCost = costPerStep * observedSteps;
      flows.push({
        name: info.name,
        diagramId: info.diagramId,
        domain: info.domain,
        neighborhoodName: info.neighborhoodName,
        annualCost,
        completed: completed.map((c) => (c === null ? null : Math.round(c * 10) / 10)),
        totalCompleted: Math.round(totalCompleted),
        windowCost: Math.round(windowCost),
        costPerTransaction: totalCompleted >= 0.5 ? Math.round(windowCost / totalCompleted) : null,
        rawIndex: mean ? Math.round(mean * 1000) / 1000 : null,
        index,
        trend,
      });
    }
    const lCostPerStep = landscapeCost * stepYears;
    const landscape = rebase(landscapeCompleted.map((c) => (c === null || lCostPerStep <= 0 ? null : (c / lCostPerStep) * 1000)));
    const counts = { favorable: 0, unfavorable: 0, steady: 0, insufficient: 0 };
    flows.forEach((f) => { counts[f.trend.verdict] += 1; });
    flows.sort((a, b) => a.name.localeCompare(b.name));
    res.json({
      generatedAt: new Date().toISOString(),
      hours,
      stepSeconds: step,
      tcoYear: tcoInfo.year,
      buckets,
      landscape: {
        annualCost: Math.round(landscapeCost),
        completed: landscapeCompleted.map((c) => (c === null ? null : Math.round(c))),
        rawIndex: landscape.mean ? Math.round(landscape.mean * 1000) / 1000 : null,
        index: landscape.index,
        trend: landscape.trend,
      },
      counts,
      flows,
      unmatched,
    });
  } catch (error) {
    const unreachable = /fetch failed|ECONNREFUSED|Prometheus \d+/.test(String(error?.message || ''));
    console.error('[business-kpis] flow-efficiency failed:', error?.message || error);
    res.status(unreachable ? 503 : 500).json({
      error: unreachable ? `Could not reach Prometheus at ${PROMETHEUS_URL}. Is the mock production stack running?` : (error?.message || 'Failed'),
      code: unreachable ? 'PROMETHEUS_UNREACHABLE' : 'KPI_FAILED',
    });
  }
});

module.exports = router;
