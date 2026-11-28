/**
 * Vendor support lifecycle (services/supportLifecycle.js).
 *   GET  /api/support-lifecycle/flows?asOf=&years=&diagramId=&flow=&domain=&application=&drivers=1&fresh=1
 *        per-flow rollup now and at +1..+3 years, quarterly timeline, landscape and domain totals
 *   GET  /api/support-lifecycle/flows/:diagramId/assets?asOf=&years=
 *        every unsupported or upcoming item behind one flow
 *   GET  /api/support-lifecycle/products?kind=&q=&withinYears=
 *        the vendor support register (one row per model / OS version / product version)
 *   POST /api/support-lifecycle/sync   re-read the catalog and update the register now
 *   PUT  /api/support-lifecycle/products/override  { key, date | null, note }  (Admin Write)
 *        enter the vendor's published date for a product (replaces the catalog/estimate)
 */
const express = require('express');
const mongoose = require('mongoose');
const User = require('../models/User');
const { computeFlowSupport, flowAssets, listProducts, syncRegister, getBase, setOverride } = require('../services/supportLifecycle');

const router = express.Router();
const validDate = (v) => (v && !Number.isNaN(new Date(v).getTime()) ? v : undefined);

router.get('/flows', async (req, res) => {
  try {
    res.json(await computeFlowSupport({
      asOf: validDate(req.query.asOf),
      years: req.query.years,
      diagramId: req.query.diagramId,
      flow: req.query.flow,
      domain: req.query.domain,
      application: req.query.application,
      includeDrivers: req.query.drivers === '1',
      fresh: req.query.fresh === '1',
    }));
  } catch (err) {
    console.error('[support-lifecycle] flows failed:', err);
    res.status(500).json({ error: err.message });
  }
});

router.get('/flows/:diagramId/assets', async (req, res) => {
  try {
    const out = await flowAssets(req.params.diagramId, { asOf: validDate(req.query.asOf), years: req.query.years });
    if (!out) return res.status(404).json({ error: 'Flow not found' });
    res.json(out);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/products', async (req, res) => {
  try {
    res.json(await listProducts({ kind: req.query.kind, query: req.query.q, asOf: validDate(req.query.asOf), withinYears: req.query.withinYears }));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/sync', async (_req, res) => {
  try {
    const base = await getBase({ fresh: true });
    res.json(await syncRegister(base.catalog.items, { force: true }));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

async function hasAdminWrite(req) {
  const user = await User.findOne({ userId: req.currentUser?.userId }, { role: 1 }).lean();
  if (!user?.role) return false;
  const role = await mongoose.connection.collection('roles').findOne({ name: user.role });
  return Boolean(role?.capabilities?.some((c) => c.function === 'Admin' && c.permission === 'Write'));
}

router.put('/products/override', async (req, res) => {
  try {
    if (!(await hasAdminWrite(req))) return res.status(403).json({ error: 'Only administrators can change vendor support dates.' });
    const { key, date, note } = req.body || {};
    if (!key) return res.status(400).json({ error: 'key is required' });
    if (date && Number.isNaN(new Date(date).getTime())) return res.status(400).json({ error: 'date must be YYYY-MM-DD' });
    const row = await setOverride(String(key), { date: date || null, note, userId: req.currentUser.userId });
    if (!row) return res.status(404).json({ error: 'Product not found' });
    res.json({ success: true, key: row.key, override: row.endOfSupportOverride });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
