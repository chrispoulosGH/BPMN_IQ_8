/**
 * Live-or-snapshot for the views that read production telemetry.
 *
 *   liveOrSnapshot(view, params, compute)
 *     Runs compute(). On success the result is saved as the view's latest
 *     snapshot (at most once a minute per view + params) and returned. When
 *     the telemetry source can't be reached, the latest snapshot is returned
 *     instead, with { snapshot: { capturedAt, source, reason } }. With no
 *     snapshot the original error is rethrown (the route's 503 stands).
 *
 *   registerView(view, { source, standardParams, compute })
 *     Declares a view's default parameter sets, so the background capture can
 *     keep every view a user can pick fresh without anyone opening it.
 *
 *   startTelemetrySnapshotCapture()
 *     Every TELEMETRY_SNAPSHOT_INTERVAL_MINUTES (default 10; 0 = off): if
 *     Prometheus / Tempo answer their readiness checks, recompute and save
 *     each registered view's standard parameter sets. Where the stack isn't
 *     running (Azure) the probe fails fast and nothing is written.
 */
const zlib = require('zlib');
const TelemetrySnapshot = require('../models/TelemetrySnapshot');

const PROMETHEUS_URL = (process.env.PROMETHEUS_URL || 'http://localhost:9090').replace(/\/+$/, '');
const TEMPO_URL = (process.env.TEMPO_URL || 'http://localhost:3200').replace(/\/+$/, '');
const SAVE_MIN_INTERVAL_MS = 60 * 1000;
const lastSaved = new Map();
const registry = new Map();

const keyOf = (view, params) => `${view}?${Object.keys(params).sort().map((k) => `${k}=${params[k]}`).join('&')}`;

/** A telemetry source that is down or unreachable (as opposed to a bad query or a bug). */
const isUnreachable = (error) => /fetch failed|ECONNREFUSED|ENOTFOUND|EHOSTUNREACH|ETIMEDOUT|timeout|aborted|(Prometheus|Tempo) \d+/i
  .test(`${error?.message || ''} ${error?.cause?.code || ''}`);

async function saveSnapshot(view, params, source, data, { force = false } = {}) {
  const key = keyOf(view, params);
  if (!force && Date.now() - (lastSaved.get(key) || 0) < SAVE_MIN_INTERVAL_MS) return false;
  lastSaved.set(key, Date.now());
  const payload = zlib.gzipSync(Buffer.from(JSON.stringify(data)));
  await TelemetrySnapshot.updateOne(
    { key },
    { $set: { key, view, params, source, capturedAt: new Date(), bytes: payload.length, payload } },
    { upsert: true },
  );
  return true;
}

async function loadSnapshot(view, params) {
  const doc = await TelemetrySnapshot.findOne({ key: keyOf(view, params) }).lean();
  if (!doc) return null;
  const raw = doc.payload?.buffer ? Buffer.from(doc.payload.buffer) : Buffer.from(doc.payload);
  return { data: JSON.parse(zlib.gunzipSync(raw).toString('utf8')), capturedAt: doc.capturedAt, source: doc.source };
}

function sourceOf(view) {
  return registry.get(view)?.source || 'prometheus';
}

async function liveOrSnapshot(view, params, compute) {
  try {
    const data = await compute();
    saveSnapshot(view, params, sourceOf(view), data)
      .catch((err) => console.warn(`[telemetry-snapshots] save ${keyOf(view, params)} failed:`, err?.message || err));
    return { data, snapshot: null };
  } catch (error) {
    if (!isUnreachable(error)) throw error;
    const saved = await loadSnapshot(view, params).catch(() => null);
    if (!saved) throw error;
    return {
      data: saved.data,
      snapshot: { capturedAt: saved.capturedAt, source: saved.source, reason: String(error?.message || error) },
    };
  }
}

function registerView(view, { source, standardParams, compute }) {
  registry.set(view, { source, standardParams, compute });
}

async function probe(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
    return res.ok;
  } catch {
    return false;
  }
}

let capturing = false;
/** Recompute and save every registered view whose source is up. Returns a summary. */
async function captureAll() {
  if (capturing) return { skipped: 'a capture is already running' };
  capturing = true;
  const started = Date.now();
  try {
    const up = {
      prometheus: await probe(`${PROMETHEUS_URL}/-/ready`),
      tempo: await probe(`${TEMPO_URL}/ready`),
    };
    const saved = [];
    const failed = [];
    for (const [view, def] of registry) {
      if (!up[def.source]) continue;
      for (const params of def.standardParams) {
        try {
          await saveSnapshot(view, params, def.source, await def.compute(params), { force: true });
          saved.push(keyOf(view, params));
        } catch (err) {
          failed.push({ key: keyOf(view, params), error: String(err?.message || err) });
        }
      }
    }
    return { up, saved, failed, ms: Date.now() - started };
  } finally {
    capturing = false;
  }
}

function startTelemetrySnapshotCapture() {
  const minutes = Number(process.env.TELEMETRY_SNAPSHOT_INTERVAL_MINUTES ?? 10);
  if (!(minutes > 0)) return;
  const run = async () => {
    const result = await captureAll().catch((err) => ({ error: String(err?.message || err) }));
    if (result.saved?.length || result.failed?.length || result.error) {
      console.log(`[telemetry-snapshots] saved ${result.saved?.length || 0}, failed ${result.failed?.length || 0}${result.ms ? ` in ${result.ms} ms` : ''}`,
        result.failed?.length ? result.failed : (result.error || ''));
    }
  };
  setTimeout(run, 30 * 1000).unref();
  setInterval(run, minutes * 60 * 1000).unref();
}

async function listSnapshots() {
  const docs = await TelemetrySnapshot.find({}, { payload: 0 }).sort({ key: 1 }).lean();
  return docs.map(({ key, view, params, source, capturedAt, bytes }) => ({ key, view, params, source, capturedAt, bytes }));
}

module.exports = {
  liveOrSnapshot,
  registerView,
  startTelemetrySnapshotCapture,
  captureAll,
  listSnapshots,
  isUnreachable,
};
