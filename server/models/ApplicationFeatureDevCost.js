const mongoose = require('mongoose');
const { Schema } = mongoose;

// One "feature" = one funded chunk of development work against an
// application, in a specific fiscal quarter. jiraFeatureKey mirrors a real
// JIRA issue key (e.g. "DLRNET-1042") and is unique across the WHOLE
// collection (enforced by the multikey index below), not just within one
// document's features array.
const FeatureDevCostEntrySchema = new Schema(
  {
    jiraFeatureKey: { type: String, required: true, trim: true },
    featureName: { type: String, required: true, trim: true },
    featureDescription: { type: String, required: true, trim: true },
    devCost: { type: Number, required: true, min: 0 }, // USD
    quarter: { type: String, required: true, enum: ['Q1', 'Q2', 'Q3', 'Q4'] },
    year: { type: Number, required: true },
  },
  { _id: false }
);

// One document per unique "combined key" occurrence — a specific
// Domain > Subdomain > Business Process Flow > Task > Application lineage
// path (the same Application name can appear in more than one combined key
// if it's used by more than one task/flow) — holding every dev-cost feature
// funded against that occurrence over time.
const ApplicationFeatureDevCostSchema = new Schema(
  {
    neighborhoodName: { type: String, required: true, trim: true, index: true },

    // The combined key, denormalized as plain strings for easy display/
    // filtering without a join.
    domain: { type: String, required: true, trim: true },
    subdomain: { type: String, required: true, trim: true },
    businessFlow: { type: String, required: true, trim: true },
    task: { type: String, required: true, trim: true },
    application: { type: String, required: true, trim: true },

    // FK references into CanonicalComponent for every level of the combined
    // key. applicationRef is the primary/required one — this collection is
    // scoped "at the application level" — the rest keep the whole row's
    // lineage traceable by _id (not just by name string, which can be
    // renamed/re-cased) if the caller needs to follow it back to the
    // component graph.
    applicationRef: { type: Schema.Types.ObjectId, ref: 'CanonicalComponent', required: true, index: true },
    taskRef: { type: Schema.Types.ObjectId, ref: 'CanonicalComponent' },
    businessFlowRef: { type: Schema.Types.ObjectId, ref: 'CanonicalComponent' },
    subdomainRef: { type: Schema.Types.ObjectId, ref: 'CanonicalComponent' },
    domainRef: { type: Schema.Types.ObjectId, ref: 'CanonicalComponent' },

    features: { type: [FeatureDevCostEntrySchema], default: [] },
  },
  { timestamps: true, collection: 'applicationFeatureDevCosts' }
);

// One document per unique combined key.
ApplicationFeatureDevCostSchema.index(
  { neighborhoodName: 1, domain: 1, subdomain: 1, businessFlow: 1, task: 1, application: 1 },
  { unique: true }
);
// A multikey unique index enforces jiraFeatureKey uniqueness across every
// document's features array combined, not just within one document.
ApplicationFeatureDevCostSchema.index({ 'features.jiraFeatureKey': 1 }, { unique: true, sparse: true });

module.exports = mongoose.model('ApplicationFeatureDevCost', ApplicationFeatureDevCostSchema);
