/**
 * One row per sign-in, kept after the login cookie's Session row expires
 * (Session has a TTL and is deleted on logout). The audit trail behind the
 * admin User Activity page; its events are in UserActivity.
 */
const mongoose = require('mongoose');

const RETENTION_DAYS = Number(process.env.ACTIVITY_RETENTION_DAYS || 365);

const userSessionSchema = new mongoose.Schema({
  userId: { type: String, required: true, index: true },
  displayName: { type: String, default: '' },
  role: { type: String, default: null },
  authMode: { type: String, default: 'local' },
  loginAt: { type: Date, required: true, index: { expires: RETENTION_DAYS * 86400 } },
  lastActivityAt: { type: Date, required: true },
  expiresAt: { type: Date, required: true }, // when the login cookie expires
  logoutAt: { type: Date, default: null },
  ip: { type: String, default: '' },
  userAgent: { type: String, default: '' },
  activityCount: { type: Number, default: 0 },
  viewCount: { type: Number, default: 0 },
  changeCount: { type: Number, default: 0 },
}, { collection: 'usersessions' });

module.exports = mongoose.models.UserSession || mongoose.model('UserSession', userSessionSchema);
