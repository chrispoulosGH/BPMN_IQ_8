const mongoose = require('mongoose');

// Reference data for diagram/ref-data status transitions — replaces the
// hardcoded STATE_TRANSITIONS array that used to live in
// client/src/components/BpmnFactory.tsx (still mirrored, for now, by the
// server-side authorization rules in server/services/stateTransitions.js).
const statusRefSchema = new mongoose.Schema({
  role: { type: String, required: true, trim: true },
  action: { type: String, required: true, trim: true },
  from: { type: String, required: true, trim: true },
  to: { type: String, required: true, trim: true },
}, {
  collection: 'status_ref',
  timestamps: true,
});

statusRefSchema.index({ role: 1, action: 1, from: 1 }, { unique: true });

module.exports = mongoose.model('StatusRef', statusRefSchema);
