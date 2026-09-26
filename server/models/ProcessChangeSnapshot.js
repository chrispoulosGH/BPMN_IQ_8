const mongoose = require('mongoose');

// One row per calendar day (UTC), upserted every time the Process Change
// Heat Map loads — see POST /api/process-change-radar/snapshot. Re-visiting
// the same day overwrites that day's row with the latest read rather than
// appending, so the trend always reflects the most current data for "today"
// while still preserving history for past days. The rag counts/points here
// are computed client-side (client/src/utils/domainExposure.ts) and posted
// as-is — this model is deliberately a dumb store, not a second place that
// re-derives the red/amber/green judgment.
const processChangeSnapshotSchema = new mongoose.Schema({
  date: { type: String, required: true, trim: true }, // YYYY-MM-DD (UTC)
  generatedAt: { type: Date, required: true },
  totalFlows: { type: Number, default: 0 },
  redCount: { type: Number, default: 0 },
  amberCount: { type: Number, default: 0 },
  greenCount: { type: Number, default: 0 },
  totalIssues: { type: Number, default: 0 },
  totalPoints: { type: Number, default: 0 },
  overduePoints: { type: Number, default: 0 },
  dueSoon7Points: { type: Number, default: 0 },
}, {
  collection: 'process_change_snapshots',
  timestamps: true,
});

processChangeSnapshotSchema.index({ date: 1 }, { unique: true });

module.exports = mongoose.model('ProcessChangeSnapshot', processChangeSnapshotSchema);
