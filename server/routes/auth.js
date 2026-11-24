const express = require('express');
const crypto = require('crypto');
const mongoose = require('mongoose');
const router = express.Router();
const User = require('../models/User');
const Session = require('../models/Session');
const activityLog = require('../services/activityLog');

const SESSION_DURATION_MS = 1000 * 60 * 60 * 8; // 8 hours
const MIN_PASSWORD_LENGTH = 6;
const IS_PRODUCTION = process.env.NODE_ENV === 'production';
// Secure cookies in production (HTTPS ingress); COOKIE_SECURE overrides.
const COOKIE_SECURE = process.env.COOKIE_SECURE ? process.env.COOKIE_SECURE === 'true' : IS_PRODUCTION;
// AUTH_MODE=easyauth: Azure Container Apps / App Service authentication (e.g.
// Microsoft Entra ID) signs the user in before the request reaches the app and
// sets X-MS-CLIENT-PRINCIPAL-NAME. Only enable it when that platform auth is
// on — it strips any client-supplied copy of the header.
const EASY_AUTH = process.env.AUTH_MODE === 'easyauth';
// First-login auto-registration: on in development, off in production unless enabled.
const ALLOW_AUTO_REGISTER = process.env.ALLOW_AUTO_REGISTER ? process.env.ALLOW_AUTO_REGISTER === 'true' : !IS_PRODUCTION;

// GET /api/auth/config — how the login page should behave (no session needed)
router.get('/config', (_req, res) => {
  res.json({ authMode: EASY_AUTH ? 'easyauth' : 'local', allowAutoRegister: EASY_AUTH || ALLOW_AUTO_REGISTER });
});

// POST /api/auth/login — authenticate user
router.post('/login', async (req, res) => {
  try {
    let { userId, password } = req.body;
    if (EASY_AUTH) {
      // The platform already authenticated the user; use that identity.
      const principal = String(req.headers['x-ms-client-principal-name'] || '').trim();
      if (!principal) {
        activityLog.recordFailedLogin('(no platform identity)', 'No signed-in organization account', req);
        return res.status(401).json({ error: 'Not signed in. Sign in with your organization account.' });
      }
      userId = principal;
    }
    if (!userId || !userId.trim()) {
      return res.status(400).json({ error: 'User ID is required.' });
    }

    let user = await User.findOne({ userId: userId.trim() });

    if (!user) {
      if (!EASY_AUTH && !ALLOW_AUTO_REGISTER) {
        activityLog.recordFailedLogin(userId.trim(), 'Unknown user', req);
        return res.status(401).json({ error: 'Unknown user.' });
      }
      // Auto-register on first login (password optional; none with platform auth)
      user = await User.create({
        userId: userId.trim(),
        password: EASY_AUTH ? null : (password || null),
        displayName: userId.trim(),
      });
    } else if (!EASY_AUTH) {
      // Validate password if user has one set
      const valid = await user.comparePassword(password || '');
      if (!valid) {
        activityLog.recordFailedLogin(user.userId, 'Wrong password', req);
        return res.status(401).json({ error: 'Invalid password.' });
      }
    }

    // Update last login
    user.lastLogin = new Date();
    await user.save();

    // Create session token
    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + SESSION_DURATION_MS);
    // Persistent record of this sign-in for the admin User Activity page (best effort).
    const auditSessionId = await activityLog.startAuditSession({ user, req, expiresAt, authMode: EASY_AUTH ? 'easyauth' : 'local' })
      .catch((err) => { console.warn('[activity] sign-in record failed:', err?.message || err); return null; });
    await Session.create({
      token,
      userId: user.userId,
      displayName: user.displayName,
      userObjId: user._id,
      expiresAt,
      auditSessionId,
    });

    // Set cookie
    res.cookie('bpmn_iq_sid', token, {
      httpOnly: true,
      secure: COOKIE_SECURE,
      maxAge: SESSION_DURATION_MS,
      sameSite: 'lax',
    });

    // Look up role capabilities
    const roleDoc = user.role ? await mongoose.connection.collection('roles').findOne({ name: user.role }) : null;
    const capabilities = roleDoc ? roleDoc.capabilities : [];

    res.json({ user: { _id: user._id.toString(), userId: user.userId, displayName: user.displayName, role: user.role || null, capabilities } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/auth/logout — destroy session
router.post('/logout', async (req, res) => {
  const token = req.cookies?.bpmn_iq_sid;
  if (token) {
    await activityLog.endAuditSession(token, req).catch((err) => console.warn('[activity] sign-out record failed:', err?.message || err));
    await Session.deleteOne({ token }).catch(() => {});
  }
  res.clearCookie('bpmn_iq_sid');
  res.json({ success: true });
});

// GET /api/auth/session — check current session
router.get('/session', async (req, res) => {
  const token = req.cookies?.bpmn_iq_sid;
  if (!token) return res.json({ authenticated: false });

  const sess = await Session.findOne({ token, expiresAt: { $gt: new Date() } });
  if (!sess) {
    res.clearCookie('bpmn_iq_sid');
    return res.json({ authenticated: false });
  }

  // Look up role capabilities
  const userDoc = await User.findOne({ userId: sess.userId }).lean();
  const roleDoc = userDoc?.role ? await mongoose.connection.collection('roles').findOne({ name: userDoc.role }) : null;
  const capabilities = roleDoc ? roleDoc.capabilities : [];

  res.json({ authenticated: true, user: { _id: sess.userObjId?.toString() || '', userId: sess.userId, displayName: sess.displayName, role: userDoc?.role || null, capabilities } });
});

// PUT /api/auth/password — update password for current user
router.put('/password', async (req, res) => {
  const token = req.cookies?.bpmn_iq_sid;
  if (!token) return res.status(401).json({ error: 'Not authenticated' });

  const sess = await Session.findOne({ token, expiresAt: { $gt: new Date() } });
  if (!sess) return res.status(401).json({ error: 'Not authenticated' });

  try {
    const { currentPassword, newPassword } = req.body;
    const user = await User.findOne({ userId: sess.userId });
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (!(await user.comparePassword(currentPassword || ''))) {
      activityLog.recordActivity({ sessionId: sess.auditSessionId || null, userId: sess.userId, kind: 'auth', action: 'Failed password change', detail: 'Wrong current password', ip: activityLog.clientIp(req) }).catch(() => {});
      return res.status(400).json({ error: 'Your current password is not correct.' });
    }
    if (!newPassword || String(newPassword).length < MIN_PASSWORD_LENGTH) {
      return res.status(400).json({ error: `The new password must be at least ${MIN_PASSWORD_LENGTH} characters.` });
    }
    user.password = newPassword;
    await user.save();
    activityLog.recordActivity({
      sessionId: sess.auditSessionId || null,
      userId: sess.userId,
      kind: 'auth',
      action: 'Changed password',
      ip: activityLog.clientIp(req),
    }).catch(() => {});
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
