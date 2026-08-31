/**
 * Seed one test login per status_ref workflow role — Viewer, Editor,
 * Approver, Publisher (the roles the status_ref transition rules key off,
 * see server/services/stateTransitions.js) — with userId and password both
 * set to the role's own name.
 * Also ensures Approver/Publisher exist as capability role docs in the
 * `roles` collection (Viewer/Editor already do, from seed-roles-users.js),
 * so logging in as one of them isn't forced read-only in the general UI.
 * Safe to re-run (upserts).
 * Usage: node scripts/seed_workflow_role_users.js
 */
require('dotenv').config();
const mongoose = require('mongoose');
const User = require('../models/User');

const MONGO_URI = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/bpmn_iq';

const ALL_FUNCTIONS = [
  'BPMN Factory',
  'Task Factory',
  'Application Factory',
  'Capability Factory',
  'Actor Factory',
  'Business Flow Factory',
  'Product Factory',
  'Line of Business Factory',
  'Channel Factory',
  'Domain Factory',
  'Subdomain Factory',
  'Dashboard',
];

// Only Approver/Publisher are new here — Viewer/Editor role docs already
// exist (created by seed-roles-users.js) and are left untouched.
const NEW_ROLES = [
  {
    name: 'Approver',
    description: 'Reviews items submitted for approval — Read + Approve access',
    capabilities: ALL_FUNCTIONS.flatMap((fn) => [
      { function: fn, permission: 'Read' },
      { function: fn, permission: 'Approve' },
    ]),
  },
  {
    name: 'Publisher',
    description: 'Publishes approved items — Read + Publish access',
    capabilities: ALL_FUNCTIONS.flatMap((fn) => [
      { function: fn, permission: 'Read' },
      { function: fn, permission: 'Publish' },
    ]),
  },
];

// userId and password both equal the role name.
const WORKFLOW_ROLES = ['Viewer', 'Editor', 'Approver', 'Publisher'];

async function run() {
  await mongoose.connect(MONGO_URI);
  console.log(`Connected to ${MONGO_URI.replace(/\/\/[^@]*@/, '//***:***@')}`);

  const db = mongoose.connection;

  for (const role of NEW_ROLES) {
    await db.collection('roles').findOneAndUpdate(
      { name: role.name },
      { $set: role },
      { upsert: true }
    );
    console.log(`Role upserted: ${role.name} (${role.capabilities.length} capabilities)`);
  }

  for (const roleName of WORKFLOW_ROLES) {
    const existing = await User.findOne({ userId: roleName });
    if (existing) {
      existing.role = roleName;
      existing.displayName = roleName;
      existing.password = roleName;
      await existing.save();
      console.log(`User updated: ${roleName} / ${roleName}  (role: ${roleName})`);
    } else {
      await User.create({
        userId: roleName,
        displayName: roleName,
        role: roleName,
        password: roleName,
      });
      console.log(`User created: ${roleName} / ${roleName}  (role: ${roleName})`);
    }
  }

  await mongoose.disconnect();

  console.log('\nDone. Login credentials:');
  WORKFLOW_ROLES.forEach((roleName) => console.log(`  ${roleName} / ${roleName}`));
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
