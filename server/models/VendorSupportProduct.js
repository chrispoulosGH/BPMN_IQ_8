const mongoose = require('mongoose');

/**
 * Vendor support register: one row per supportable product — a hardware
 * model, an OS version, or a software product + version — with the range of
 * vendor unsupported dates seen across its installs. Synced from the System
 * Components catalog by services/supportLifecycle.js; a change in either
 * date is appended to `history`, so date slips are tracked over time.
 */
const HistorySchema = new mongoose.Schema({
  at: Date,
  field: String,
  from: String,
  to: String,
  by: String,
  note: String,
}, { _id: false });

const VendorSupportProductSchema = new mongoose.Schema({
  key: { type: String, required: true, unique: true }, // kind|vendor|product|version, lower-cased
  kind: { type: String, enum: ['hardware', 'os', 'software'], index: true },
  vendor: String,
  product: String,
  version: String,
  endOfSupportEarliest: { type: Date, index: true },
  endOfSupportLatest: Date,
  installs: Number,
  unknownDates: Number,
  contractExpired: Number, // hardware units whose support contract is already "Expired"
  applicationCount: Number,
  source: { type: String, default: 'catalog' }, // catalog | estimate
  dateBasis: String,
  // An administrator's vendor-published date; replaces the catalog/estimate for every install.
  endOfSupportOverride: { type: Date, default: null },
  overrideNote: String,
  overrideBy: String,
  overrideAt: Date,
  firstSeenAt: Date,
  lastSyncedAt: Date,
  retired: { type: Boolean, default: false },
  history: [HistorySchema],
}, { collection: 'vendorsupportproducts' });

module.exports = mongoose.model('VendorSupportProduct', VendorSupportProductSchema);
