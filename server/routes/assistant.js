/**
 * "Ask BIQ" routes (session-guarded; every user may use them).
 *   POST   /api/assistant/chat               { conversationId?, message, context? } → server-sent events
 *   GET    /api/assistant/conversations      the user's threads (newest first)
 *   GET    /api/assistant/conversations/:id  one thread
 *   DELETE /api/assistant/conversations/:id
 *   GET    /api/assistant/status             { configured, model }
 *
 * Stream events (each `data: {json}`): meta {conversationId}, text {delta},
 * tool {id, name, label, status}, done {refs, tools}, error {message, code}.
 */
const express = require('express');
const mongoose = require('mongoose');
const AssistantConversation = require('../models/AssistantConversation');
const { askBiq, isConfigured, MODEL } = require('../services/assistant/askBiq');
const { recordActivity, clientIp } = require('../services/activityLog');

const router = express.Router();
const own = (req, id) => ({ _id: id, userId: req.currentUser.userId });

router.get('/status', (_req, res) => res.json({ configured: isConfigured(), model: MODEL }));

router.get('/conversations', async (req, res) => {
  try {
    const rows = await AssistantConversation.find({ userId: req.currentUser.userId }, { title: 1, updatedAt: 1, createdAt: 1 }).sort({ updatedAt: -1 }).limit(50).lean();
    res.json(rows.map((r) => ({ id: String(r._id), title: r.title, updatedAt: r.updatedAt })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/conversations/:id', async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ error: 'Not found' });
  const row = await AssistantConversation.findOne(own(req, req.params.id)).lean();
  if (!row) return res.status(404).json({ error: 'Not found' });
  res.json({ id: String(row._id), title: row.title, turns: row.turns });
});

router.delete('/conversations/:id', async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ error: 'Not found' });
  await AssistantConversation.deleteOne(own(req, req.params.id));
  res.json({ success: true });
});

router.post('/chat', async (req, res) => {
  const question = String(req.body?.message || '').trim().slice(0, 4000);
  if (!question) return res.status(400).json({ error: 'A question is required.' });
  if (!isConfigured()) {
    return res.status(400).json({ error: 'Ask BIQ needs an Anthropic API key. Set ANTHROPIC_API_KEY in server/.env (Key Vault on Azure), then restart.', code: 'ANTHROPIC_NOT_CONFIGURED' });
  }

  let conversation = null;
  const { conversationId } = req.body || {};
  if (conversationId && mongoose.isValidObjectId(conversationId)) {
    conversation = await AssistantConversation.findOne(own(req, conversationId));
  }
  if (!conversation) {
    conversation = await AssistantConversation.create({ userId: req.currentUser.userId, title: question.slice(0, 80), model: MODEL, turns: [] });
  }
  const history = conversation.turns.map((t) => ({ role: t.role, text: t.text }));

  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.flushHeaders?.();
  let closed = false;
  res.on('close', () => { closed = true; });
  const send = (event) => { if (!closed) res.write(`data: ${JSON.stringify(event)}\n\n`); };
  const keepAlive = setInterval(() => { if (!closed) res.write(': keep-alive\n\n'); }, 15000);

  send({ type: 'meta', conversationId: String(conversation._id), model: MODEL });
  recordActivity({
    sessionId: req.auditSessionId || null, userId: req.currentUser.userId, kind: 'action',
    action: 'Asked BIQ', detail: question.slice(0, 200), ip: clientIp(req),
  }).catch(() => {});

  try {
    const answer = await askBiq({ req, history, question, context: req.body?.context, onEvent: send });
    conversation.turns.push({ role: 'user', text: question });
    conversation.turns.push({ role: 'assistant', text: answer.text, refs: answer.refs, tools: answer.tools });
    await conversation.save();
    send({ type: 'done', refs: answer.refs, tools: answer.tools });
  } catch (err) {
    console.error('[assistant] chat failed:', err?.message || err);
    // Anthropic API errors carry an HTTP status; explain the common ones plainly.
    const friendly = {
      401: ['The Anthropic API key was rejected (invalid or revoked). Set a current key in ANTHROPIC_API_KEY and restart.', 'ANTHROPIC_AUTH'],
      403: ['The Anthropic API key isn\'t allowed to use this model.', 'ANTHROPIC_FORBIDDEN'],
      404: ['The configured model isn\'t available to this API key. Check ASSISTANT_MODEL.', 'ANTHROPIC_MODEL'],
      429: ['Ask BIQ is rate-limited by the Anthropic API right now. Try again in a minute.', 'ANTHROPIC_RATE_LIMIT'],
      529: ['The Anthropic API is overloaded right now. Try again shortly.', 'ANTHROPIC_OVERLOADED'],
    }[err?.status] || (/credit balance is too low/i.test(String(err?.message))
      ? ['The Anthropic account behind this API key has no credit left. Add credits under Plans & Billing in the Anthropic Console.', 'ANTHROPIC_NO_CREDIT']
      : undefined);
    send({ type: 'error', message: friendly ? friendly[0] : String(err?.message || 'Ask BIQ failed'), code: friendly ? friendly[1] : (err?.code || null) });
    // A thread whose first question failed has nothing in it; don't keep it.
    if (!conversation.turns.length) await AssistantConversation.deleteOne({ _id: conversation._id }).catch(() => {});
  } finally {
    clearInterval(keepAlive);
    if (!closed) res.end();
  }
});

module.exports = router;
