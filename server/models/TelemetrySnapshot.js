/**
 * The latest result of a telemetry-backed view (Prometheus / Tempo), one row
 * per view + parameters. Written whenever a live read succeeds; served when
 * the telemetry source can't be reached, so the analytics and dashboard
 * views still show their last known state (e.g. on Azure, where the mock
 * production stack isn't deployed — the database is shared with local runs).
 *
 * The payload is gzipped JSON: some views carry BPMN XML or hundreds of APIs.
 * See server/services/telemetrySnapshots.js.
 */
const mongoose = require('mongoose');

const TelemetrySnapshotSchema = new mongoose.Schema({
  key: { type: String, required: true, unique: true }, // view?param=value&…
  view: { type: String, required: true, index: true },
  params: { type: mongoose.Schema.Types.Mixed, default: {} },
  source: { type: String, enum: ['prometheus', 'tempo'], required: true },
  capturedAt: { type: Date, required: true },
  bytes: { type: Number, default: 0 },
  payload: { type: Buffer, required: true },
}, { collection: 'telemetrysnapshots' });

module.exports = mongoose.models.TelemetrySnapshot || mongoose.model('TelemetrySnapshot', TelemetrySnapshotSchema);
