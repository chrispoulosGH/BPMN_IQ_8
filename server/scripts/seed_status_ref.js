/**
 * Sync the status_ref collection to the authoritative state-transition
 * rules in server/services/stateTransitions.js — the same rules the server
 * already enforces, now also exposed to the client via GET /api/states/transitions
 * so BpmnFactory.tsx (and the other *Factory.tsx components) no longer need
 * their own hardcoded copy.
 * Full sync, not just additive upserts: also removes any status_ref row
 * whose {role, action, from} no longer matches a current rule, so editing
 * the rules above (renaming an action, dropping a transition, etc.) and
 * re-running this script actually replaces the stale row instead of leaving
 * it behind alongside the new one.
 * Safe to re-run.
 * Usage: node scripts/seed_status_ref.js
 */
require('dotenv').config();
const mongoose = require('mongoose');
const StatusRef = require('../models/StatusRef');
const { transitions } = require('../services/stateTransitions');

const MONGO_URI = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/bpmn_iq';

async function run() {
  await mongoose.connect(MONGO_URI);
  console.log(`Connected to ${MONGO_URI.replace(/\/\/[^@]*@/, '//***:***@')}`);

  let created = 0;
  let updated = 0;

  for (const rule of transitions) {
    const result = await StatusRef.updateOne(
      { role: rule.role, action: rule.action, from: rule.from },
      { $set: { to: rule.to } },
      { upsert: true }
    );
    if (result.upsertedCount) created += 1;
    else if (result.modifiedCount) updated += 1;
  }

  const deleteResult = await StatusRef.deleteMany({
    $nor: transitions.map((rule) => ({ role: rule.role, action: rule.action, from: rule.from })),
  });

  console.log(`status_ref synced: ${created} created, ${updated} updated, ${deleteResult.deletedCount} removed (stale), ${transitions.length - created - updated} unchanged (${transitions.length} total rules)`);

  await mongoose.disconnect();
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
