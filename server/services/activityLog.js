/**
 * User sessions and activity, persisted for the admin User Activity page.
 *
 *   startAuditSession / endAuditSession    called by routes/auth.js
 *   ensureAuditSession(sess, req)          session guard: links a login cookie to its
 *                                          UserSession (creating one for logins made
 *                                          before this existed) and bumps lastActivityAt
 *   recordChanges                          middleware: every data-changing API request
 *                                          (POST/PUT/PATCH/DELETE) becomes a 'change'
 *   recordClientEvents                     views/actions batched by the client
 *   listSessions / sessionDetail           admin queries
 */
const mongoose = require('mongoose');
const Session = require('../models/Session');
const UserSession = require('../models/UserSession');
const UserActivity = require('../models/UserActivity');

const TOUCH_INTERVAL_MS = 60 * 1000;
const ACTIVE_WINDOW_MS = 15 * 60 * 1000;
const lastTouched = new Map(); // auditSessionId -> ms
const pendingLinks = new Map(); // login token -> Promise<auditSessionId>

const clip = (v, n = 300) => String(v ?? '').slice(0, n);

/** Client IP: behind Azure's proxy req.ip can carry a port ("1.2.3.4:5678") or an IPv4-mapped prefix. */
function clientIp(req) {
  let ip = String(req.ip || req.socket?.remoteAddress || '');
  ip = ip.replace(/^::ffff:/, '');
  if (/^\d+\.\d+\.\d+\.\d+:\d+$/.test(ip)) ip = ip.replace(/:\d+$/, '');
  return ip;
}

function log(promise, what) {
  promise.catch((err) => console.warn(`[activity] ${what} failed:`, err?.message || err));
}

async function recordActivity(entry) {
  const doc = {
    sessionId: entry.sessionId || null,
    userId: entry.userId,
    at: entry.at || new Date(),
    kind: entry.kind,
    action: clip(entry.action, 200),
    detail: clip(entry.detail, 500),
    method: entry.method || '',
    path: clip(entry.path, 300),
    status: entry.status ?? null,
    durationMs: entry.durationMs ?? null,
    target: entry.target ? { kind: clip(entry.target.kind, 40), id: clip(entry.target.id, 120), name: clip(entry.target.name, 200) } : undefined,
    ip: entry.ip || '',
  };
  await UserActivity.create(doc);
  if (doc.sessionId) {
    const inc = { activityCount: 1 };
    if (doc.kind === 'view') inc.viewCount = 1;
    if (doc.kind === 'change') inc.changeCount = 1;
    await UserSession.updateOne({ _id: doc.sessionId }, { $inc: inc, $max: { lastActivityAt: doc.at } });
  }
}

async function startAuditSession({ user, req, expiresAt, authMode }) {
  const now = new Date();
  const audit = await UserSession.create({
    userId: user.userId,
    displayName: user.displayName || user.userId,
    role: user.role || null,
    authMode,
    loginAt: now,
    lastActivityAt: now,
    expiresAt,
    ip: clientIp(req),
    userAgent: clip(req.headers['user-agent'], 400),
  });
  await recordActivity({ sessionId: audit._id, userId: user.userId, kind: 'auth', action: 'Signed in', ip: clientIp(req) });
  return audit._id;
}

async function endAuditSession(token, req) {
  const sess = await Session.findOne({ token }).lean();
  if (!sess?.auditSessionId) return;
  const now = new Date();
  await UserSession.updateOne({ _id: sess.auditSessionId }, { $set: { logoutAt: now } });
  await recordActivity({ sessionId: sess.auditSessionId, userId: sess.userId, kind: 'auth', action: 'Signed out', ip: clientIp(req) });
}

function recordFailedLogin(userId, reason, req) {
  log(recordActivity({ userId: clip(userId || '(blank)', 120), kind: 'auth', action: 'Failed sign-in', detail: reason, ip: clientIp(req) }), 'failed sign-in');
}

/** The UserSession behind a login cookie; also keeps lastActivityAt current (at most once a minute). */
async function ensureAuditSession(sess, req, role) {
  let id = sess.auditSessionId;
  if (!id) {
    if (!pendingLinks.has(sess.token)) {
      pendingLinks.set(sess.token, (async () => {
        const audit = await UserSession.create({
          userId: sess.userId,
          displayName: sess.displayName || sess.userId,
          role: role || null,
          authMode: 'local',
          loginAt: sess.createdAt || new Date(),
          lastActivityAt: new Date(),
          expiresAt: sess.expiresAt,
          ip: clientIp(req),
          userAgent: clip(req.headers['user-agent'], 400),
        });
        await Session.updateOne({ _id: sess._id }, { $set: { auditSessionId: audit._id } });
        return audit._id;
      })().finally(() => setTimeout(() => pendingLinks.delete(sess.token), 60 * 1000)));
    }
    id = await pendingLinks.get(sess.token);
  }
  const key = String(id);
  if (Date.now() - (lastTouched.get(key) || 0) > TOUCH_INTERVAL_MS) {
    lastTouched.set(key, Date.now());
    log(UserSession.updateOne({ _id: id }, { $max: { lastActivityAt: new Date() } }), 'touch');
  }
  return id;
}

// ─── Data-changing requests → readable activity ─────────────────────────────

/** Requests that change nothing, or that the app makes on its own. */
const IGNORE = [
  /^POST \/activity$/,
  /^POST \/assistant\/chat$/, // recorded as "Asked BIQ" by routes/assistant.js
  /^POST \/process-change-radar\/snapshot$/,
  /^POST \/(diagrams|tasks)\/validate$/,
  /^POST \/custom-factories\/(fk-resolve|fk-validate)$/,
  /^POST \/custom-factories\/components\/[^/]+\/fk-validate$/,
];

// [pattern, label, target kind (taken from the first capture group)]
const RULES = [
  [/^PUT \/diagrams\/([^/]+)\/notes$/, 'Edited diagram sticky notes', 'diagram'],
  [/^POST \/diagrams$/, 'Created a diagram'],
  [/^POST \/diagrams\/batch$/, 'Imported diagrams'],
  [/^PUT \/diagrams\/([^/]+)$/, 'Saved a diagram', 'diagram'],
  [/^DELETE \/diagrams\/([^/]+)$/, 'Deleted a diagram', 'diagram'],
  [/^POST \/process-optimizer\/analyze\/([^/]+)$/, 'Ran the Process Optimizer', 'diagram'],
  [/^PUT \/support-lifecycle\/products\/override$/, 'Changed a vendor support date'],
  [/^POST \/support-lifecycle\/sync$/, 'Refreshed the vendor support register'],
  [/^POST \/admin\/users$/, 'Created a user'],
  [/^PUT \/admin\/users\/([^/]+)\/password$/, 'Set a user\'s password', 'user'],
  [/^PUT \/admin\/users\/([^/]+)$/, 'Changed a user', 'user'],
  [/^DELETE \/admin\/users\/([^/]+)$/, 'Deleted a user', 'user'],
  [/^POST \/custom-factories\/upload$/, 'Uploaded a spreadsheet'],
  [/^POST \/custom-factories\/neighborhoods$/, 'Created a framework'],
  [/^DELETE \/custom-factories\/neighborhoods\/([^/]+)\/components$/, 'Deleted a framework\'s components', 'framework'],
  [/^DELETE \/custom-factories\/neighborhoods\/([^/]+)$/, 'Deleted a framework', 'framework'],
  [/^DELETE \/custom-factories\/data\/([^/]+)$/, 'Deleted a data type', 'dataType'],
  [/^POST \/custom-factories\/search\/index\/rebuild$/, 'Rebuilt the search index'],
  [/^POST \/custom-factories\/validation-errors-report$/, 'Generated a validation report'],
  [/^POST \/custom-factories\/([^/]+)\/rows$/, 'Added a component row', 'component'],
  [/^PUT \/custom-factories\/([^/]+)\/rows\/[^/]+$/, 'Edited a component row', 'component'],
  [/^DELETE \/custom-factories\/([^/]+)\/rows\/[^/]+$/, 'Deleted a component row', 'component'],
  [/^DELETE \/custom-factories\/([^/]+)$/, 'Deleted a component', 'component'],
  [/^POST \/materialize/, 'Rematerialized components'],
  [/^POST \/files$/, 'Uploaded a file'],
  [/^DELETE \/files\/([^/]+)$/, 'Deleted a file', 'file'],
  [/^POST \/capabilities\/match$/, 'Ran capability matching'],
  [/^POST \/states\/transition$/, 'Changed a workflow state'],
  [/^POST \/telemetry-snapshots\/capture$/, 'Captured telemetry snapshots'],
  [/^DELETE \/assistant\/conversations\/[^/]+$/, 'Deleted an Ask BIQ conversation'],
];
const VERB = { POST: 'Created', PUT: 'Updated', PATCH: 'Updated', DELETE: 'Deleted' };
const humanize = (segment) => String(segment || 'data').replace(/[-_]+/g, ' ');

function describeRequest(method, path) {
  const line = `${method} ${path}`;
  if (IGNORE.some((re) => re.test(line))) return null;
  for (const [re, label, kind] of RULES) {
    const m = line.match(re);
    if (m) {
      const id = m[1] ? decodeURIComponent(m[1]) : '';
      const nameIsId = kind === 'framework' || kind === 'dataType' || kind === 'file';
      return { action: label, target: kind && id ? { kind, id, name: nameIsId ? id : '' } : null };
    }
  }
  const segments = path.split('/').filter(Boolean);
  return { action: `${VERB[method] || method} ${humanize(segments[0])}${segments[1] && !/^[0-9a-f]{24}$/i.test(segments[1]) ? ` › ${humanize(decodeURIComponent(segments[1]))}` : ''}`, target: null };
}

/** Middleware (after the session guard): record each data-changing request when it finishes. */
function recordChanges(req, res, next) {
  if (!VERB[req.method] || !req.auditSessionId || !req.currentUser) return next();
  const path = String(req.originalUrl || '').split('?')[0].replace(/^\/api/, '');
  const described = describeRequest(req.method, path);
  if (!described) return next();
  const started = Date.now();
  res.on('finish', () => {
    log(recordActivity({
      sessionId: req.auditSessionId,
      userId: req.currentUser.userId,
      kind: 'change',
      action: described.action,
      detail: res.statusCode >= 400 ? `Failed (HTTP ${res.statusCode})` : '',
      method: req.method,
      path,
      status: res.statusCode,
      durationMs: Date.now() - started,
      target: described.target,
      ip: clientIp(req),
    }), 'change');
  });
  next();
}

/**
 * Views and actions reported by the client, in batches:
 *   { sentAt, events: [{ kind: 'view'|'action', action, detail?, target?, at }] }
 * Times are re-based on the server clock (at = now - (sentAt - at)).
 */
async function recordClientEvents(req) {
  const events = Array.isArray(req.body?.events) ? req.body.events.slice(0, 100) : [];
  const now = Date.now();
  const sentAt = Number(req.body?.sentAt) || now;
  // Nothing in a session happens before its sign-in.
  const session = await UserSession.findById(req.auditSessionId, { loginAt: 1 }).lean();
  const earliest = session?.loginAt ? new Date(session.loginAt).getTime() : 0;
  let recorded = 0;
  for (const e of events) {
    if (!e || !e.action || !['view', 'action'].includes(e.kind)) continue;
    const age = Math.min(Math.max(sentAt - (Number(e.at) || sentAt), 0), Math.max(0, now - earliest), 24 * 3600 * 1000);
    await recordActivity({
      sessionId: req.auditSessionId,
      userId: req.currentUser.userId,
      kind: e.kind,
      action: e.action,
      detail: e.detail,
      target: e.target && typeof e.target === 'object' ? e.target : null,
      at: new Date(now - age),
      ip: clientIp(req),
    });
    recorded += 1;
  }
  return recorded;
}

// ─── Admin queries ───────────────────────────────────────────────────────────

function sessionStatus(s, now = Date.now()) {
  if (s.logoutAt) return 'signed out';
  if (new Date(s.expiresAt).getTime() <= now) return 'expired';
  if (now - new Date(s.lastActivityAt).getTime() <= ACTIVE_WINDOW_MS) return 'active';
  return 'idle';
}

function shapeSession(s, now = Date.now()) {
  const status = sessionStatus(s, now);
  const end = s.logoutAt || s.lastActivityAt;
  return {
    id: String(s._id),
    userId: s.userId,
    displayName: s.displayName,
    role: s.role,
    authMode: s.authMode,
    loginAt: s.loginAt,
    lastActivityAt: s.lastActivityAt,
    logoutAt: s.logoutAt,
    expiresAt: s.expiresAt,
    status,
    durationMs: Math.max(0, new Date(end).getTime() - new Date(s.loginAt).getTime()),
    ip: s.ip,
    userAgent: s.userAgent,
    activityCount: s.activityCount,
    viewCount: s.viewCount,
    changeCount: s.changeCount,
  };
}

async function listSessions({ days = 7, userId = '' } = {}) {
  const since = new Date(Date.now() - days * 86400 * 1000);
  const filter = { $or: [{ loginAt: { $gte: since } }, { lastActivityAt: { $gte: since } }] };
  if (userId) filter.userId = userId;
  const now = Date.now();
  const [sessions, failed, userIds] = await Promise.all([
    UserSession.find(filter).sort({ loginAt: -1 }).limit(1000).lean(),
    UserActivity.find({ kind: 'auth', action: 'Failed sign-in', at: { $gte: since }, ...(userId ? { userId } : {}) })
      .sort({ at: -1 }).limit(200).lean(),
    UserSession.distinct('userId'),
  ]);
  const shaped = sessions.map((s) => shapeSession(s, now));
  const loginsByDay = {};
  for (const s of shaped) {
    const day = new Date(s.loginAt).toISOString().slice(0, 10);
    loginsByDay[day] = (loginsByDay[day] || 0) + 1;
  }
  return {
    generatedAt: new Date().toISOString(),
    days,
    summary: {
      users: new Set(shaped.map((s) => s.userId)).size,
      sessions: shaped.length,
      activeNow: shaped.filter((s) => s.status === 'active').length,
      views: shaped.reduce((n, s) => n + (s.viewCount || 0), 0),
      changes: shaped.reduce((n, s) => n + (s.changeCount || 0), 0),
      failedSignIns: failed.length,
    },
    loginsByDay,
    sessions: shaped,
    failedSignIns: failed.map((f) => ({ id: String(f._id), userId: f.userId, at: f.at, reason: f.detail, ip: f.ip })),
    users: userIds.sort((a, b) => a.localeCompare(b)),
  };
}

async function sessionDetail(id) {
  if (!mongoose.isValidObjectId(id)) return null;
  const session = await UserSession.findById(id).lean();
  if (!session) return null;
  const activities = await UserActivity.find({ sessionId: session._id }).sort({ at: 1 }).limit(5000).lean();

  // Name the diagrams and users that changes point at by id.
  const idsOf = (kind) => [...new Set(activities.filter((a) => a.target?.kind === kind && !a.target.name && mongoose.isValidObjectId(a.target.id)).map((a) => a.target.id))];
  const diagramIds = idsOf('diagram');
  const userObjIds = idsOf('user');
  const componentIds = idsOf('component');
  const [diagrams, users, components] = await Promise.all([
    diagramIds.length ? mongoose.model('Diagram').find({ _id: { $in: diagramIds } }, { name: 1 }).lean() : [],
    userObjIds.length ? mongoose.model('User').find({ _id: { $in: userObjIds } }, { userId: 1 }).lean() : [],
    componentIds.length ? mongoose.model('Component').find({ _id: { $in: componentIds } }, { name: 1 }).lean() : [],
  ]);
  const names = new Map([
    ...diagrams.map((d) => [`diagram:${d._id}`, String(d.name || '').replace(/&amp;/g, '&')]),
    ...users.map((u) => [`user:${u._id}`, u.userId]),
    ...components.map((c) => [`component:${c._id}`, c.name]),
  ]);
  return {
    session: shapeSession(session),
    activities: activities.map((a) => ({
      id: String(a._id),
      at: a.at,
      kind: a.kind,
      action: a.action,
      detail: a.detail,
      method: a.method,
      path: a.path,
      status: a.status,
      durationMs: a.durationMs,
      target: a.target?.kind ? { ...a.target, name: a.target.name || names.get(`${a.target.kind}:${a.target.id}`) || '' } : null,
    })),
  };
}

module.exports = {
  startAuditSession,
  endAuditSession,
  recordFailedLogin,
  recordActivity,
  ensureAuditSession,
  recordChanges,
  recordClientEvents,
  listSessions,
  sessionDetail,
  describeRequest,
  clientIp,
};
