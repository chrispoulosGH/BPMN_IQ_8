const mongoose = require('mongoose');

const sessionSchema = new mongoose.Schema({
  token: { type: String, required: true, unique: true, index: true },
  userId: { type: String, required: true },
  displayName: { type: String, default: '' },
  userObjId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  // The persistent audit record of this sign-in (UserSession), which outlives this row.
  auditSessionId: { type: mongoose.Schema.Types.ObjectId, ref: 'UserSession', default: null },
  expiresAt: { type: Date, required: true, index: { expires: 0 } }, // TTL index auto-deletes
}, { timestamps: true });

module.exports = mongoose.models.Session || mongoose.model('Session', sessionSchema);
