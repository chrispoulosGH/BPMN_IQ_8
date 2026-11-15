/**
 * Generates dashboards/bpmn-flows.json (the provisioned "BPMN business flows"
 * dashboard). Edit here and re-run:  node observability/grafana/build-dashboard.js
 *
 * Metric names are the OTLP → Prometheus translations of the simulator's
 * metrics (dots → underscores, unit and _total suffixes):
 *   bpmn.process.instances         → bpmn_process_instances_total
 *   bpmn.process.duration (s)      → bpmn_process_duration_seconds_*
 *   bpmn.task.duration (s)         → bpmn_task_duration_seconds_*
 *   bpmn.process.active_instances  → bpmn_process_active_instances
 *   api.errors                     → api_errors_total
 *   business.data_object.exchanged → business_data_object_exchanged_total
 * plus Tempo's generated traces_spanmetrics_* and traces_service_graph_*.
 */
const fs = require('fs');
const path = require('path');

const PROM = { type: 'prometheus', uid: 'prometheus' };
const TEMPO = { type: 'tempo', uid: 'tempo' };
const FLOW = 'bpmn_process_name=~"${flow:regex}"';
// Outcome colours carry status meaning (good / warning / critical), with labels.
const OUTCOME_COLORS = { completed: '#2e7d32', abandoned: '#ed8b00', failed: '#c62828' };

let nextId = 1;
const grid = (x, y, w, h) => ({ x, y, w, h });
const prom = (expr, legendFormat = '', extra = {}) => ({ datasource: PROM, expr, legendFormat, refId: 'A', ...extra });

const row = (title, y) => ({ id: nextId++, type: 'row', title, collapsed: false, gridPos: grid(0, y, 24, 1), panels: [] });

const stat = (title, expr, gridPos, { unit = 'none', color = 'text', description = '', decimals } = {}) => ({
  id: nextId++, type: 'stat', title, description, datasource: PROM, gridPos,
  targets: [prom(expr, '', { instant: true })],
  fieldConfig: { defaults: { unit, decimals, color: { mode: 'fixed', fixedColor: color }, thresholds: { mode: 'absolute', steps: [{ color, value: null }] } }, overrides: [] },
  options: { reduceOptions: { calcs: ['lastNotNull'], fields: '', values: false }, colorMode: 'value', graphMode: 'none', textMode: 'value', justifyMode: 'center' },
});

const timeseries = (title, targets, gridPos, { unit = 'none', description = '', stack = false, overrides = [], legend = 'bottom' } = {}) => ({
  id: nextId++, type: 'timeseries', title, description, datasource: PROM, gridPos, targets,
  fieldConfig: {
    defaults: {
      unit,
      custom: { lineWidth: 2, fillOpacity: stack ? 30 : 8, showPoints: 'never', spanNulls: true, stacking: { mode: stack ? 'normal' : 'none', group: 'A' }, axisSoftMin: 0 },
    },
    overrides,
  },
  options: { legend: { displayMode: 'list', placement: legend }, tooltip: { mode: 'multi', sort: 'desc' } },
});

const outcomeOverrides = Object.entries(OUTCOME_COLORS).map(([name, color]) => ({
  matcher: { id: 'byName', options: name },
  properties: [{ id: 'color', value: { mode: 'fixed', fixedColor: color } }],
}));

const traceTable = (title, query, gridPos, description) => ({
  id: nextId++, type: 'table', title, description, datasource: TEMPO, gridPos,
  targets: [{ datasource: TEMPO, refId: 'A', queryType: 'traceql', query, limit: 50, tableType: 'traces' }],
  fieldConfig: { defaults: {}, overrides: [] },
  options: { showHeader: true, cellHeight: 'sm' },
});

let y = 0;
const panels = [];

const window = '$__range';
// ── Vehicles sold: counted when the vehicle changes hands (delivery, fleet
// delivery, wholesale completion), once per deal — see SALE_EVENTS in the engine.
panels.push(row('Vehicles sold', y)); y += 1;
const SOLD = 'business_vehicles_sold_total';
// Units in the range: increase() (reset-safe), rounded to whole vehicles.
const soldIn = (selector = '') => `round(increase(${SOLD}${selector || '{bpmn_process_name!=""}'}[${window}]))`;
panels.push(stat('Vehicles sold', `sum(${soldIn()}) or vector(0)`, grid(0, y, 5, 4), { decimals: 0, description: 'Units delivered in the selected time range: new (online, in-store, fleet) and used (wholesale). Fleet orders count every vehicle.' }));
panels.push(stat('New', `sum(${soldIn('{business_vehicle_condition="new", bpmn_process_name!=""}')}) or vector(0)`, grid(5, y, 3, 4), { decimals: 0 }));
panels.push(stat('Used', `sum(${soldIn('{business_vehicle_condition="used", bpmn_process_name!=""}')}) or vector(0)`, grid(8, y, 3, 4), { decimals: 0 }));
panels.push(stat('Sales revenue', `sum(increase(business_sales_revenue_USD_total{bpmn_process_name!=""}[${window}])) or vector(0)`, grid(11, y, 4, 4), { unit: 'currencyUSD', decimals: 0 }));
panels.push({
  id: nextId++, type: 'bargauge', title: 'Vehicles sold by channel', datasource: PROM, gridPos: grid(15, y, 9, 4),
  targets: [prom(`sum by (business_sale_channel) (${soldIn()})`, '{{business_sale_channel}}', { instant: true })],
  fieldConfig: { defaults: { decimals: 0, min: 0, color: { mode: 'fixed', fixedColor: '#1f6feb' } }, overrides: [] },
  options: { orientation: 'horizontal', displayMode: 'basic', valueMode: 'text', showUnfilled: true, namePlacement: 'left', reduceOptions: { calcs: ['lastNotNull'], fields: '', values: false } },
});
y += 4;
panels.push({
  id: nextId++, type: 'timeseries', title: 'Vehicles sold over time, by channel', datasource: PROM, gridPos: grid(0, y, 24, 7),
  description: 'Whole vehicles sold in each interval (bars stack by channel). Retail follows dealership hours; fleet arrives in large orders.',
  targets: [prom(`round(sum by (business_sale_channel) (increase(${SOLD}{bpmn_process_name!=""}[$__interval])))`, '{{business_sale_channel}}', { interval: '5m' })],
  fieldConfig: {
    defaults: {
      unit: 'none', decimals: 0,
      custom: { drawStyle: 'bars', fillOpacity: 80, lineWidth: 1, barAlignment: 0, showPoints: 'never', spanNulls: false, stacking: { mode: 'normal', group: 'A' }, axisSoftMin: 0 },
    },
    overrides: [],
  },
  options: { legend: { displayMode: 'list', placement: 'bottom' }, tooltip: { mode: 'multi', sort: 'desc' } },
});
y += 7;

panels.push(row('Business flows', y)); y += 1;
panels.push(stat('Instances completed', `sum(increase(bpmn_process_instances_total{${FLOW}, bpmn_process_outcome="completed"}[${window}])) or vector(0)`, grid(0, y, 4, 4), { color: OUTCOME_COLORS.completed, decimals: 0, description: 'Process instances that reached their end event in the selected time range.' }));
panels.push(stat('Abandoned', `sum(increase(bpmn_process_instances_total{${FLOW}, bpmn_process_outcome="abandoned"}[${window}])) or vector(0)`, grid(4, y, 4, 4), { color: OUTCOME_COLORS.abandoned, decimals: 0, description: 'The customer dropped out at a customer-lane task.' }));
panels.push(stat('Failed', `sum(increase(bpmn_process_instances_total{${FLOW}, bpmn_process_outcome="failed"}[${window}])) or vector(0)`, grid(8, y, 4, 4), { color: OUTCOME_COLORS.failed, decimals: 0, description: 'A task\'s API call still failed after retries.' }));
panels.push(stat('Completion rate', `sum(increase(bpmn_process_instances_total{${FLOW}, bpmn_process_outcome="completed"}[${window}])) / sum(increase(bpmn_process_instances_total{${FLOW}}[${window}]))`, grid(12, y, 4, 4), { unit: 'percentunit', decimals: 1 }));
panels.push(stat('In flight now', `sum(bpmn_process_active_instances{${FLOW}}) or vector(0)`, grid(16, y, 4, 4), { decimals: 0 }));
panels.push(stat('Median instance duration', `histogram_quantile(0.5, sum by (le) (rate(bpmn_process_duration_seconds_bucket{${FLOW}, bpmn_process_outcome="completed"}[${window}])))`, grid(20, y, 4, 4), { unit: 's', decimals: 0 }));
y += 4;

panels.push(timeseries('Instances finished by outcome (per hour)', [prom(`sum by (bpmn_process_outcome) (rate(bpmn_process_instances_total{${FLOW}}[$__rate_interval])) * 3600`, '{{bpmn_process_outcome}}')], grid(0, y, 12, 8), { overrides: outcomeOverrides, description: 'Follows the simulator\'s daily curve: quiet overnight, lunchtime and after-work peaks.' }));
panels.push(timeseries('Instances in flight by flow (top 10)', [prom(`topk(10, sum by (bpmn_process_name) (bpmn_process_active_instances{${FLOW}}))`, '{{bpmn_process_name}}')], grid(12, y, 12, 8)));
y += 8;

panels.push({
  id: nextId++, type: 'bargauge', title: 'p95 task duration, including human work (slowest 25)', datasource: PROM, gridPos: grid(0, y, 12, 11),
  description: 'Slowest first. Human-lane tasks include the (compressed) think time before the API call.',
  targets: [prom(`topk(25, histogram_quantile(0.95, sum by (le, bpmn_task_name) (rate(bpmn_task_duration_seconds_bucket{${FLOW}}[${window}]))))`, '{{bpmn_task_name}}', { instant: true })],
  fieldConfig: { defaults: { unit: 's', decimals: 0, color: { mode: 'fixed', fixedColor: '#1f6feb' }, min: 0 }, overrides: [] },
  options: { orientation: 'horizontal', displayMode: 'basic', valueMode: 'text', showUnfilled: true, namePlacement: 'left', reduceOptions: { calcs: ['lastNotNull'], fields: '', values: false } },
});
panels.push(timeseries('p95 task duration by lane', [prom(`histogram_quantile(0.95, sum by (le, bpmn_lane_name) (rate(bpmn_task_duration_seconds_bucket{${FLOW}}[$__rate_interval])))`, '{{bpmn_lane_name}}')], grid(12, y, 12, 11), { unit: 's' }));
y += 11;

panels.push(row('Applications and APIs', y)); y += 1;
panels.push({
  id: nextId++, type: 'nodeGraph', title: 'Service map', datasource: TEMPO, gridPos: grid(0, y, 12, 12),
  description: 'From Tempo\'s service-graph metrics: which application calls which.',
  targets: [{ datasource: TEMPO, refId: 'A', queryType: 'serviceMap' }],
  options: {},
});
panels.push(timeseries('Requests per second by application', [prom('sum by (service) (rate(traces_spanmetrics_calls_total{span_kind="SPAN_KIND_SERVER", service!="bpmn-process-engine"}[$__rate_interval]))', '{{service}}')], grid(12, y, 12, 6), { unit: 'reqps' }));
panels.push(timeseries('API errors by application', [prom('sum by (app_acronym) (rate(api_errors_total[$__rate_interval])) * 60', '{{app_acronym}}')], grid(12, y + 6, 12, 6), { unit: 'none', description: 'Errors per minute, including injected faults and incident windows (sim_fault label).' }));
y += 12;
panels.push(timeseries('p95 API latency by application', [prom('histogram_quantile(0.95, sum by (le, service) (rate(traces_spanmetrics_latency_bucket{span_kind="SPAN_KIND_SERVER", service!="bpmn-process-engine"}[$__rate_interval])))', '{{service}}')], grid(0, y, 12, 8), { unit: 's' }));
panels.push(timeseries('Data objects handed between applications (per minute)', [prom('sum by (data_object_name) (rate(business_data_object_exchanged_total{direction="sent"}[$__rate_interval])) * 60', '{{data_object_name}}')], grid(12, y, 12, 8)));
y += 8;

panels.push(row('Traces', y)); y += 1;
panels.push(traceTable('Process instances', `{ name =~ "process .*" && span.bpmn.process.name =~ "\${flow:regex}" }`, grid(0, y, 12, 12), 'One trace per process instance. Click a trace ID to open the waterfall.'));
panels.push(traceTable('Abandoned or failed instances', `{ name =~ "process .*" && span.bpmn.process.name =~ "\${flow:regex}" && span.bpmn.process.outcome != "completed" }`, grid(12, y, 12, 12)));
y += 12;
panels.push(traceTable('Slow human tasks (over 60 s)', `{ name =~ "task .*" && span.bpmn.process.name =~ "\${flow:regex}" && span.bpmn.task.performer = "human" && duration > 60s }`, grid(0, y, 12, 10)));
panels.push(traceTable('API calls that returned an error', `{ span.bpmn.process.name =~ "\${flow:regex}" && span.api.id != "" && status = error }`, grid(12, y, 12, 10)));

const dashboard = {
  uid: 'bpmn-iq-flows',
  title: 'BPMN business flows',
  description: 'Mock production: the three car-purchase flows, their applications and traces (Tempo + Prometheus).',
  tags: ['bpmn-iq', 'mockprod', 'opentelemetry'],
  timezone: 'browser',
  editable: true,
  graphTooltip: 1,
  refresh: '30s',
  schemaVersion: 39,
  time: { from: 'now-6h', to: 'now' },
  templating: {
    list: [{
      name: 'flow', label: 'Business flow', type: 'query', datasource: PROM,
      query: { query: 'label_values(bpmn_process_instances_total, bpmn_process_name)', refId: 'flow' },
      definition: 'label_values(bpmn_process_instances_total, bpmn_process_name)',
      refresh: 2, multi: true, includeAll: true, allValue: '.*', current: { text: 'All', value: '$__all' }, sort: 1,
    }],
  },
  links: [{ title: 'Explore traces', type: 'link', url: '/explore?left=%7B%22datasource%22:%22tempo%22%7D', icon: 'external link' }],
  panels,
};

const out = path.join(__dirname, 'dashboards', 'bpmn-flows.json');
fs.writeFileSync(out, `${JSON.stringify(dashboard, null, 2)}\n`);
console.log(`Wrote ${out} (${panels.length} panels)`);
