const mongoose = require('mongoose');
const { Schema } = mongoose;

// One task-level change the agent is suggesting — additive to the existing
// Diagram.tasks[] shape (see Diagram.js) so a proposal can be rendered as a
// diff against the live flow without inventing a second task representation.
const TaskDiffEntrySchema = new Schema({
  op: { type: String, enum: ['add', 'remove', 'retarget_application', 'rename'], required: true },
  taskId: { type: String }, // present for remove/retarget_application/rename — matches Diagram.tasks[]._id
  taskName: { type: String },
  actor: { type: String },
  // add: full new task payload; retarget_application: {from, to}; rename: {from, to}
  detail: { type: Schema.Types.Mixed, default: {} },
  reason: { type: String, required: true },
}, { _id: false });

const ProcessOptimizationProposalSchema = new Schema({
  diagramId: { type: Schema.Types.ObjectId, ref: 'Diagram', required: true, index: true },
  diagramName: { type: String },
  businessFlow: { type: String },
  summary: { type: String, required: true },
  rationale: { type: [String], default: [] },
  taskDiff: { type: [TaskDiffEntrySchema], default: [] },
  projectedImpact: {
    costDeltaUsd: { type: Number, default: 0 },
    securityRiskDelta: { type: Number, default: 0 },
    defectRiskDelta: { type: Number, default: 0 },
    jiraActivityDelta: { type: Number, default: 0 },
  },
  confidence: { type: Number, min: 0, max: 100 },
  status: { type: String, enum: ['proposed', 'accepted', 'rejected'], default: 'proposed', index: true },
  generatedBy: { type: String, default: 'process-optimizer-agent' },
  reviewedBy: { type: String },
  reviewedAt: { type: Date },
  // Every tool the agent called while investigating this flow, in order —
  // an audit trail so a reviewer (or a future eval script) can see the
  // actual evidence the agent looked at, not just its conclusion.
  toolCallLog: { type: [{ tool: String, args: Schema.Types.Mixed, resultSummary: String, _id: false }], default: [] },
  model: { type: String },
}, { timestamps: true, collection: 'processoptimizationproposals' });

module.exports = mongoose.models.ProcessOptimizationProposal
  || mongoose.model('ProcessOptimizationProposal', ProcessOptimizationProposalSchema);
