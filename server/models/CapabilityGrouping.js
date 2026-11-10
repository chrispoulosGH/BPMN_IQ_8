const mongoose = require('mongoose');
const { Schema } = mongoose;

// A read-time grouping of the lineage-level Business Capabilities (the names
// stored in Diagram.businessCapability and the "Business Capability" component
// rows) into a two-level parent structure:
//
//   capabilityArea (L1)  →  capabilityGroup (L2)  →  capabilityName (today's, L3)
//
// Kept in its own collection on purpose: it adds a grouping without renaming or
// copying any capability name. Component rows are rebuilt from the upload
// batches on rematerialize, so fields added there would be lost. Only
// /api/dashboard/value-stream-relationships reads this, to group flows; nothing
// writes capability names from here. Seeded by
// scripts/seed_capability_grouping.js from docs/capability-map-proposal.json.
//
// qualifierSubdomain is set only where one capability name currently means two
// different things (e.g. "Inventory Management" under Parts Operations vs New
// Vehicle Sales) and each meaning belongs to a different group.
const CapabilityGroupingSchema = new Schema({
  neighborhoodName: { type: String, required: true, index: true },
  capabilityName: { type: String, required: true },
  qualifierSubdomain: { type: String, default: null },
  capabilityGroup: { type: String, required: true },
  capabilityArea: { type: String, required: true },
  source: { type: String, default: 'docs/capability-map-proposal.json' },
}, { timestamps: true });

CapabilityGroupingSchema.index({ neighborhoodName: 1, capabilityName: 1, qualifierSubdomain: 1 }, { unique: true });

module.exports = mongoose.model('CapabilityGrouping', CapabilityGroupingSchema);
