'use strict';
const ProcessOptimizationProposal = require('../../models/ProcessOptimizationProposal');

// toolCallLog/model are never part of the tool's public schema (the LLM
// doesn't need to — and shouldn't have to — report its own call history);
// the agent orchestrator injects them itself right before invoking this
// handler for the save_optimization_proposal tool call specifically.
async function saveOptimizationProposal({
  diagramId, diagramName, businessFlow, summary, rationale, taskDiff, projectedImpact, confidence,
  toolCallLog, model,
}) {
  const doc = await ProcessOptimizationProposal.create({
    diagramId, diagramName, businessFlow, summary,
    rationale: rationale || [],
    taskDiff: taskDiff || [],
    projectedImpact: projectedImpact || {},
    confidence,
    toolCallLog: toolCallLog || [],
    model,
  });
  return { proposalId: String(doc._id), status: doc.status };
}

module.exports = { saveOptimizationProposal };
