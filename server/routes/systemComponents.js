const express = require('express');
const {
  discoverComponentTypesLinkedToTarget,
  findRecordsLinkedToApplication,
} = require('../utils/applicationReferenceLookup');

const router = express.Router();
const SYSTEM_COMPONENTS_NEIGHBORHOOD = 'System Components';

// GET /api/system-components/linked-types?target=Applications
// Which System Components types (Servers, Software, or any future upload)
// have at least one row FK_-linked to the given target subtab. Entirely
// data-driven — used to build the diagram app right-click menu without any
// hardcoded list of type names.
router.get('/linked-types', async (req, res) => {
  try {
    const target = String(req.query.target || 'Applications').trim();
    if (!target) return res.status(400).json({ error: 'target is required' });
    const types = await discoverComponentTypesLinkedToTarget(SYSTEM_COMPONENTS_NEIGHBORHOOD, target);
    res.json({ target, types });
  } catch (err) {
    console.error('[system-components:linked-types] error', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/system-components/applications/record?appId=LLM-010&key=CONNECTED-CAR
// The full Applications catalog record (every column) for one application,
// for the details card shown when an application is clicked on a diagram.
// Matched by APP_ID first (some acronyms are shared by two apps), then by
// acronym (primaryKey), then by name.
router.get('/applications/record', async (req, res) => {
  try {
    const CanonicalData = require('../models/CanonicalData');
    const appId = String(req.query.appId || '').trim();
    const key = String(req.query.key || '').trim();
    if (!appId && !key) return res.status(400).json({ error: 'appId or key is required' });
    const base = { neighborhoodName: SYSTEM_COMPONENTS_NEIGHBORHOOD, componentType: 'Applications' };
    const attempts = [
      appId ? { 'values.APP_ID Qualifier': appId } : null,
      key ? { primaryKey: key } : null,
      key ? { 'values.APP_ID Qualifier': key } : null,
      key ? { 'values.APP_NAME Qualifier': key } : null,
    ].filter(Boolean);
    let row = null;
    for (const match of attempts) {
      row = await CanonicalData.findOne({ ...base, ...match }, { primaryKey: 1, values: 1 }).lean();
      if (row) break;
    }
    if (!row) return res.status(404).json({ error: 'Application not found in the catalog' });
    res.json({ primaryKey: row.primaryKey, values: row.values || {} });
  } catch (err) {
    console.error('[system-components:applications/record] error', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/system-components/:componentType/linked-to-application/:correlationId
// All records of :componentType (e.g. "Servers", "Software") whose FK_
// column(s) resolve to the given application's correlation id.
router.get('/:componentType/linked-to-application/:correlationId', async (req, res) => {
  try {
    const componentType = String(req.params.componentType || '').trim();
    const correlationId = String(req.params.correlationId || '').trim();
    if (!componentType) return res.status(400).json({ error: 'componentType is required' });
    if (!correlationId) return res.status(400).json({ error: 'correlationId is required' });

    const records = await findRecordsLinkedToApplication(SYSTEM_COMPONENTS_NEIGHBORHOOD, componentType, correlationId);
    res.json(records);
  } catch (err) {
    console.error('[system-components:linked-to-application] error', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
