/**
 * "Ask BIQ" conversations, one per thread, private to their user.
 * Only the visible turns are kept (question, answer text, the refs the answer
 * may cite, and which tools ran); data is looked up fresh on every question.
 */
const mongoose = require('mongoose');

const turnSchema = new mongoose.Schema({
  role: { type: String, enum: ['user', 'assistant'], required: true },
  text: { type: String, default: '' },
  refs: { type: [mongoose.Schema.Types.Mixed], default: [] },
  tools: { type: [mongoose.Schema.Types.Mixed], default: [] },
  at: { type: Date, default: Date.now },
}, { _id: false });

const assistantConversationSchema = new mongoose.Schema({
  userId: { type: String, required: true, index: true },
  title: { type: String, default: '' },
  model: { type: String, default: '' },
  turns: { type: [turnSchema], default: [] },
}, { timestamps: true, collection: 'assistantconversations' });

module.exports = mongoose.models.AssistantConversation || mongoose.model('AssistantConversation', assistantConversationSchema);
