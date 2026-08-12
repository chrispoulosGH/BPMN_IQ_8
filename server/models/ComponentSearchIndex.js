const mongoose = require('mongoose');

// Schema for a single hierarchy node
const hierarchyNodeSchema = new mongoose.Schema(
  {
    componentName: { type: String, required: true },
    componentId: { type: mongoose.Schema.Types.ObjectId },
    rowName: { type: String, required: true },
    rowId: { type: mongoose.Schema.Types.ObjectId },
    // Every non-identity, non-FK column on this row (e.g. "actor_qualifier",
    // "bpmn_task_qualifier") — shown as small attribute text inside the
    // component's tree-view box. See getQualifierValues in searchIndexBuilder.js.
    qualifiers: { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  { _id: false }
);

const componentSearchIndexSchema = new mongoose.Schema(
  {
    neighborhoodName: { type: String, required: true, index: true },
    componentName: { type: String, required: true, index: true },
    componentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Component', index: true },
    rowId: { type: mongoose.Schema.Types.ObjectId, index: true },
    rowName: { type: String, required: true }, // Primary key value
    searchableTextLower: { type: String, index: true }, // Lowercase for case-insensitive search
    allValues: [String], // All field values concatenated
    fieldByValue: mongoose.Schema.Types.Mixed, // { fieldName: value, ... }
    frequency: { type: Number, default: 1 }, // How many times this value is referenced
    cachedLineagePaths: [String], // Pre-computed lineage paths (deprecated - kept for backwards compatibility)
    cachedHierarchies: [[hierarchyNodeSchema]], // Structured hierarchies: array of paths, each path is array of nodes
    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now },
  },
  { collection: 'componentSearchIndex' }
);

// Compound index for efficient querying
componentSearchIndexSchema.index({ neighborhoodName: 1, searchableTextLower: 1 });
componentSearchIndexSchema.index({ neighborhoodName: 1, componentName: 1 });

// Text index for full-text search
componentSearchIndexSchema.index({ allValues: 'text', searchableTextLower: 'text' });

module.exports = mongoose.model('ComponentSearchIndex', componentSearchIndexSchema);
