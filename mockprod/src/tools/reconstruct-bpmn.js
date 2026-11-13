/**
 * Rebuild BPMN 2.0 XML for each business flow from trace data alone, then
 * (optionally) check it against the source model.
 *
 *   npm run reconstruct                               # all flows in ./data/traces.jsonl
 *   npm run reconstruct -- --flow="Warranty Contract Execution"
 *   npm run reconstruct -- --input=export.json        # spans exported from Observe
 *   npm run reconstruct -- --compare                  # diff against catalog/catalog.json
 *
 * Input formats:
 *   - OTLP JSON lines, as written by the collector's file exporter (default)
 *   - a JSON array (or JSON lines) of flat spans:
 *       { traceId, spanId, parentSpanId, name, startTime, endTime,
 *         attributes: {...}, resource: {...}, events: [{name, attributes}] }
 *     which is the shape to export from Observe (span dataset with attributes).
 *
 * What is used (see src/attributes.js):
 *   root "process …" span: bpmn.process.id/name, lanes, start/end event ids
 *   "task …" spans:       bpmn.task.id/name/type, lane id/name, incoming and
 *                          outgoing sequence-flow ids, task application
 *   API server spans:      api.id, http method + route (recorded as documentation)
 *
 * Output: data/reconstructed/<Flow>.bpmn (importable into BPMN IQ / bpmn.io),
 * with lanes, tasks, start/end events, sequence flows, application text
 * annotations and an auto-layout diagram (DI). Only what was observed is
 * drawn; per-element instance counts are reported.
 */
const fs = require('fs');
const path = require('path');
const readline = require('readline');

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const [k, ...v] = a.replace(/^--/, '').split('=');
  return [k, v.length ? v.join('=') : true];
}));
const ROOT = path.join(__dirname, '..', '..');
const inputPath = path.resolve(ROOT, args.input || 'data/traces.jsonl');
const outDir = path.resolve(ROOT, args.out || 'data/reconstructed');

// The span → model → XML logic is shared with BPMN IQ's discovery route.
const { spansFromOtlp, normalizeFlat, buildModels, toXml } = require('../../../server/services/traceToBpmn');

// ── Reading spans ───────────────────────────────────────────────────────────
async function readSpans(file) {
  const spans = [];
  const text = fs.readFileSync(file, 'utf8').trim();
  if (text.startsWith('[')) {
    for (const s of JSON.parse(text)) spans.push(normalizeFlat(s));
    return spans;
  }
  const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    const doc = JSON.parse(line);
    if (doc.resourceSpans) for (const s of spansFromOtlp(doc)) spans.push(s);
    else spans.push(normalizeFlat(doc));
  }
  return spans;
}

// ── Compare with the source model ───────────────────────────────────────────
function compare(model) {
  const catalog = JSON.parse(fs.readFileSync(path.join(ROOT, 'catalog', 'catalog.json'), 'utf8'));
  const source = catalog.flows.find((f) => f.name === model.name);
  if (!source) return ['  (no source flow in catalog)'];
  const lines = [];
  const check = (label, ok, detail = '') => lines.push(`  ${ok ? 'OK  ' : 'DIFF'} ${label}${detail ? ` — ${detail}` : ''}`);
  check('process id', source.processId === model.processId, `${model.processId}`);
  const srcLanes = new Map(source.lanes.map((l) => [l.id, l.name]));
  const obsLanes = new Map([...model.lanes.values()].map((l) => [l.id, l.name]));
  check('lanes', srcLanes.size === obsLanes.size && [...srcLanes].every(([id, n]) => obsLanes.get(id) === n), `${obsLanes.size}/${srcLanes.size}`);
  const missingTasks = source.tasks.filter((t) => !model.tasks.has(t.id));
  const wrongTasks = source.tasks.filter((t) => model.tasks.has(t.id) && (model.tasks.get(t.id).name !== t.name || model.tasks.get(t.id).laneId !== t.laneId));
  check('tasks (id, name, lane)', !missingTasks.length && !wrongTasks.length, `${source.tasks.length - missingTasks.length}/${source.tasks.length} observed${missingTasks.length ? `; missing ${missingTasks.map((t) => t.id).join(', ')}` : ''}${wrongTasks.length ? `; mismatched ${wrongTasks.map((t) => t.id).join(', ')}` : ''}`);
  const wrongApps = source.tasks.filter((t) => model.tasks.has(t.id) && !t.diagramApplications.every((a) => model.tasks.get(t.id).applications.has(a)));
  check('task applications', !wrongApps.length, wrongApps.map((t) => `${t.id}: expected ${t.diagramApplications.join(',')}, saw ${[...model.tasks.get(t.id).applications.keys()].join(',')}`).join('; '));
  const srcFlows = new Map(source.sequenceFlows.map((f) => [f.id, f]));
  const missingFlows = [...srcFlows.values()].filter((f) => !model.flows.has(f.id));
  const wrongFlows = [...model.flows.values()].filter((f) => !srcFlows.has(f.id) || srcFlows.get(f.id).sourceId !== f.sourceId || srcFlows.get(f.id).targetId !== f.targetId);
  check('sequence flows (id, source, target)', !missingFlows.length && !wrongFlows.length, `${srcFlows.size - missingFlows.length}/${srcFlows.size} observed${missingFlows.length ? `; missing ${missingFlows.map((f) => f.id).join(', ')}` : ''}${wrongFlows.length ? `; unexpected ${wrongFlows.map((f) => f.id).join(', ')}` : ''}`);
  const srcEvents = source.events.map((e) => e.id);
  check('start/end events', srcEvents.every((id) => model.events.has(id)), `${srcEvents.filter((id) => model.events.has(id)).length}/${srcEvents.length}`);
  return lines;
}

async function main() {
  if (!fs.existsSync(inputPath)) {
    console.error(`No trace file at ${inputPath}. Run the environment first (the collector writes data/traces.jsonl).`);
    process.exit(1);
  }
  const spans = await readSpans(inputPath);
  const models = buildModels(spans);
  fs.mkdirSync(outDir, { recursive: true });
  console.log(`Read ${spans.length} spans from ${path.relative(ROOT, inputPath)}; ${models.size} business flow(s) found.`);
  for (const model of models.values()) {
    if (args.flow && model.name !== args.flow) continue;
    const file = path.join(outDir, `${model.name.replace(/[^\w.-]+/g, '_')}.bpmn`);
    fs.writeFileSync(file, toXml(model));
    console.log(`\n${model.name}: ${model.instances} instances (${Object.entries(model.outcomes).map(([k, v]) => `${v} ${k}`).join(', ')}), ${model.tasks.size} tasks, ${model.flows.size} sequence flows → ${path.relative(ROOT, file)}`);
    if (args.compare) for (const line of compare(model)) console.log(line);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
