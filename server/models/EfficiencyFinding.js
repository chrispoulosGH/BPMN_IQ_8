const mongoose = require('mongoose');
const { Schema } = mongoose;

// Records a single identified inefficiency in the enterprise landscape —
// generated in bulk by scripts/seed_efficiency_findings.js against real
// CanonicalData/Diagram records, then kept as a persistent audit trail
// (which asset(s), why, and what the remediation would be) rather than
// being recomputed on the fly. Three categories, one collection, with a
// category-specific `details` payload so a future report/UI can query
// across all of them ("open findings by estimated savings") without
// joining three tables.
const EfficiencyFindingSchema = new Schema({
  category: {
    type: String,
    required: true,
    enum: ['duplicate_functionality', 'redundant_process_step', 'server_consolidation'],
    index: true,
  },
  title: { type: String, required: true },
  description: { type: String, required: true },
  estimatedAnnualSavingsUsd: { type: Number, default: 0 },
  status: { type: String, enum: ['identified', 'accepted', 'dismissed', 'resolved'], default: 'identified', index: true },
  details: { type: Schema.Types.Mixed, default: {} },
  batchId: { type: String, index: true },
  generatedAt: { type: Date, default: Date.now },
}, { timestamps: true, collection: 'efficiencyfindings' });

module.exports = mongoose.models.EfficiencyFinding || mongoose.model('EfficiencyFinding', EfficiencyFindingSchema);
