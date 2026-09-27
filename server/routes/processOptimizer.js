const express = require('express');
const router = express.Router();
const ProcessOptimizationProposal = require('../models/ProcessOptimizationProposal');
const { analyzeBusinessFlow } = require('../services/processOptimizerAgent');

// POST /api/process-optimizer/analyze/:diagramId — on-demand trigger (Phase 2
// MVP scope: no background sweep yet). Runs the agent loop synchronously and
// returns the persisted proposal; this can take a while (multiple LLM round
// trips), so the client should show a working state rather than assume a
// fast response.
router.post('/analyze/:diagramId', async (req, res) => {
  try {
    const result = await analyzeBusinessFlow(req.params.diagramId);
    const proposal = await ProcessOptimizationProposal.findById(result.proposalId).lean();
    res.json(proposal);
  } catch (err) {
    const knownConfigError = err.code === 'ANTHROPIC_NOT_CONFIGURED';
    res.status(knownConfigError ? 400 : 500).json({ error: err.message, code: err.code || null });
  }
});

// GET /api/process-optimizer/proposals?diagramId=... — most recent first;
// diagramId optional (omit to list across all flows, e.g. for a backlog view).
router.get('/proposals', async (req, res) => {
  try {
    const filter = req.query.diagramId ? { diagramId: req.query.diagramId } : {};
    const proposals = await ProcessOptimizationProposal.find(filter).sort({ createdAt: -1 }).lean();
    res.json(proposals);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/process-optimizer/proposals/:id — one proposal, full detail
// (including the tool-call audit log — omitted from the list route above to
// keep that response light).
router.get('/proposals/:id', async (req, res) => {
  try {
    const proposal = await ProcessOptimizationProposal.findById(req.params.id).lean();
    if (!proposal) return res.status(404).json({ error: 'Proposal not found.' });
    res.json(proposal);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
