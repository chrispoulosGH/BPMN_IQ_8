const mongoose = require('mongoose');
const { Schema } = mongoose;

const SourceBatchSchema = new Schema({
  batchId: { type: String, required: true },
  rowIndex: { type: Number },
}, { _id: false });

const CanonicalComponentSchema = new Schema({
  neighborhoodName: { type: String, index: true, required: true },
  componentType: { type: String, index: true, required: true },
  primaryKey: { type: String, required: true },
  values: { type: Schema.Types.Mixed, default: {} },
  parentKeys: { type: [String], default: [] },
  parentRefs: [{ type: Schema.Types.ObjectId, ref: 'CanonicalComponent' }],
  childrenRefs: [{ type: Schema.Types.ObjectId, ref: 'CanonicalComponent' }],
  path: { type: String },
  sourceBatches: { type: [SourceBatchSchema], default: [] },
  // Row-level status (status_ref driven — see server/services/stateTransitions.js)
  // and owner, editable from the Model Components table view's Edit Row modal.
  owner: { type: String, default: '' },
  state: { type: String, default: 'staged' },
  updatedBy: { type: String, default: '' },
}, { timestamps: true });

// Compound unique: neighborhood + type + primary key
CanonicalComponentSchema.index({ neighborhoodName: 1, componentType: 1, primaryKey: 1 }, { unique: true });
CanonicalComponentSchema.index({ neighborhoodName: 1, primaryKey: 1 });

module.exports = mongoose.model('CanonicalComponent', CanonicalComponentSchema);
