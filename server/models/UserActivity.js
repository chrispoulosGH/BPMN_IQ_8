/**
 * What a user did during a session (UserSession), for the admin User Activity page.
 *   kind   auth    signed in / out, failed sign-in (no session), password change
 *          view    a page or sub-page opened, a diagram opened (sent by the client)
 *          change  any API request that changes data, recorded by the server
 *          action  other client-reported actions
 * Request bodies are never stored, only a readable label, the method/path,
 * the response status and an optional target (e.g. which diagram).
 */
const mongoose = require('mongoose');

const RETENTION_DAYS = Number(process.env.ACTIVITY_RETENTION_DAYS || 365);

const userActivitySchema = new mongoose.Schema({
  sessionId: { type: mongoose.Schema.Types.ObjectId, ref: 'UserSession', default: null },
  userId: { type: String, required: true, index: true },
  at: { type: Date, required: true, index: { expires: RETENTION_DAYS * 86400 } },
  kind: { type: String, enum: ['auth', 'view', 'change', 'action'], required: true },
  action: { type: String, required: true },
  detail: { type: String, default: '' },
  method: { type: String, default: '' },
  path: { type: String, default: '' },
  status: { type: Number, default: null },
  durationMs: { type: Number, default: null },
  target: {
    kind: { type: String, default: '' },
    id: { type: String, default: '' },
    name: { type: String, default: '' },
  },
  ip: { type: String, default: '' },
}, { collection: 'useractivities' });

userActivitySchema.index({ sessionId: 1, at: 1 });
userActivitySchema.index({ kind: 1, at: -1 });

module.exports = mongoose.models.UserActivity || mongoose.model('UserActivity', userActivitySchema);
