const express = require('express');
const mongoose = require('mongoose');
const SoxControl = require('../models/SoxControl');
const Diagram = require('../models/Diagram');
const SoxDeviation = require('../models/SoxDeviation');

const router = express.Router();

// Must match the normalization used for SoxControl.anchors (see
// scripts/seed_sox_controls.js) and BpmnEditor's normalizeImpactName.
const norm = (value) => String(value || '').trim().toLowerCase();

// Adds each control's deviations (soxdeviations) as `deviations`, newest first.
async function attachDeviations(controls) {
  const ids = [...new Set(controls.map((c) => c.controlId))];
  if (!ids.length) return controls;
  const deviations = await SoxDeviation.find({ controlId: { $in: ids } }).sort({ 'audit.auditDate': -1 }).lean();
  const byControl = new Map();
  for (const d of deviations) {
    if (!byControl.has(d.controlId)) byControl.set(d.controlId, []);
    byControl.get(d.controlId).push(d);
  }
  for (const c of controls) c.deviations = byControl.get(c.controlId) || [];
  return controls;
}

// GET /api/sox-controls?category=&cycle=&app=&risk=&q=
router.get('/', async (req, res) => {
  try {
    const { category, cycle, app, risk, q } = req.query;
    const filter = {};
    if (category) filter.category = category;
    if (cycle) filter.processCycle = cycle;
    if (risk) filter.auditRisk = risk;
    if (app) filter['scope.applications.name'] = app;
    if (q) {
      const rx = new RegExp(String(q).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      filter.$or = [{ controlId: rx }, { title: rx }, { description: rx }];
    }
    const controls = await SoxControl.find(filter).sort({ controlId: 1 }).lean();
    res.json(await attachDeviations(controls));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/sox-controls/for-diagram/:diagramId
// Everything the canvas needs to place control icons on one diagram:
//   diagramControls     — flow-level controls (badge on the title banner)
//   byTaskName          — task-level + interface controls, keyed by normalized task name
//   byApplicationName   — application-level ITGCs, keyed by normalized app acronym
router.get('/for-diagram/:diagramId', async (req, res) => {
  try {
    const { diagramId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(diagramId)) return res.status(400).json({ error: 'Invalid diagram id' });
    const diagram = await Diagram.findById(diagramId, { 'tasks.applications.name': 1 }).lean();
    if (!diagram) return res.status(404).json({ error: 'Diagram not found' });

    const appKeys = [...new Set((diagram.tasks || []).flatMap((t) => (t.applications || []).map((a) => norm(a.name))).filter(Boolean))];
    const [flowControls, appControls] = await Promise.all([
      SoxControl.find({ 'anchors.diagramIds': diagramId }).sort({ controlId: 1 }).lean(),
      appKeys.length ? SoxControl.find({ 'anchors.applicationKeys': { $in: appKeys } }).sort({ controlId: 1 }).lean() : [],
    ]);

    await attachDeviations([...flowControls, ...appControls]);

    const diagramControls = [];
    const byTaskName = {};
    const prefix = `${diagramId}|`;
    for (const control of flowControls) {
      const taskKeys = (control.anchors?.taskKeys || []).filter((k) => k.startsWith(prefix)).map((k) => k.slice(prefix.length));
      if (!taskKeys.length) { diagramControls.push(control); continue; }
      for (const key of taskKeys) (byTaskName[key] = byTaskName[key] || []).push(control);
    }
    const byApplicationName = {};
    for (const control of appControls) {
      for (const key of control.anchors?.applicationKeys || []) {
        if (appKeys.includes(key)) (byApplicationName[key] = byApplicationName[key] || []).push(control);
      }
    }
    res.json({ diagramId, diagramControls, byTaskName, byApplicationName });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/sox-controls/deviations?severity=&category=&status=&controlId=&auditId=
router.get('/deviations', async (req, res) => {
  try {
    const { severity, category, status, controlId, auditId } = req.query;
    const filter = {};
    if (severity) filter.severity = severity;
    if (category) filter.category = category;
    if (status) filter['remediation.status'] = status;
    if (controlId) filter.controlId = controlId;
    if (auditId) filter['audit.auditId'] = auditId;
    res.json(await SoxDeviation.find(filter).sort({ 'audit.auditDate': -1 }).lean());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/sox-controls/:controlId
router.get('/:controlId', async (req, res) => {
  try {
    const control = await SoxControl.findOne({ controlId: req.params.controlId }).lean();
    if (!control) return res.status(404).json({ error: 'Control not found' });
    res.json((await attachDeviations([control]))[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
