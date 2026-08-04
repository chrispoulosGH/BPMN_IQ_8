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
