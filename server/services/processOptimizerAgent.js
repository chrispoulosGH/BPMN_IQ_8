'use strict';

// Phase 2: the actual agent loop. Given one business flow (diagramId), runs
// an Anthropic (Claude) tool-use loop over the exact tools mcp/toolRegistry.js
// also exposes over MCP — the embedded agent calls the same handlers
// in-process (no reason to round-trip through the stdio protocol for code
// living in the same repo; MCP stays the interface for EXTERNAL clients).
//
// Deliberately scoped to the two flow-shaped inefficiency categories
// (duplicate_functionality, redundant_process_step) — server consolidation
// is an infrastructure-level finding, not a diagram edit, and stays out of
// scope here (see the Rationalization Ledger report for that). The agent
// does NOT have a tool to read the seeded EfficiencyFinding collection —
// that data is reserved as a hidden eval set, not a shortcut.

const { z } = require('zod');
const Anthropic = require('@anthropic-ai/sdk');
const { TOOLS } = require('../mcp/toolRegistry');
const { getBusinessFlow } = require('../mcp/tools/getBusinessFlow');

const MODEL = process.env.PROCESS_OPTIMIZER_MODEL || 'claude-sonnet-5';
const MAX_ITERATIONS = 25;
const MAX_TOKENS = 4096;

function isAnthropicConfigured() {
  return !!process.env.ANTHROPIC_API_KEY;
}

const TOOLS_BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));

function toAnthropicTools() {
  return TOOLS.map((tool) => {
    const schema = z.toJSONSchema(z.object(tool.inputSchema));
    delete schema.$schema;
    return { name: tool.name, description: tool.description, input_schema: schema };
  });
}

const SYSTEM_PROMPT = `You are a senior enterprise process-optimization analyst reviewing ONE business process flow at a time in an automotive company's ("LLM AMI") systems landscape.

Your job, for the flow you are given, is to find GENUINE inefficiencies in exactly two categories:
1. duplicate_functionality — a task's application exposes an API that another application already exposes for essentially the same business capability. Use find_overlapping_apis on specific APIs to get candidates, then judge from the actual names/endpoints whether they really do the same thing — a shared domain+type alone is NOT sufficient evidence, many APIs in the same domain are legitimately different capabilities.
2. redundant_process_step — a task in THIS flow that no longer earns its place: a duplicate check another task in the same flow already performs, a manual step whose validation is already automated elsewhere, or a step serving a purpose that no longer applies given the flow's actors and applications.

Do NOT flag server/infrastructure utilization — that is tracked separately and out of scope here.

Work methodically:
- Start from the task list you're given. Identify which tasks/applications look like your best candidates for each category — you do not need to exhaustively check every task's every API, but be genuinely thorough about the ones that look suspicious.
- For duplicate_functionality: use search_apis with appIdOrAcronym to see what an application exposes, then find_overlapping_apis on specific candidate APIs.
- For redundant_process_step: compare tasks within the flow for overlapping purpose; get_jira_activity and get_feature_cost can help you judge whether a step is still earning real engineering investment.
- Cite the ACTUAL task/API/application names you found — never generic filler like "Task X".

When you are done investigating, call save_optimization_proposal EXACTLY ONCE, summarizing every accepted finding for this flow together as one proposal: one rationale bullet and one taskDiff entry per finding (op "remove" for an eliminable step, "retarget_application" for a duplicate-functionality fix — put the recommended target application in detail.to). If your investigation finds no genuine waste, still call save_optimization_proposal with an empty taskDiff and a summary explaining what you checked and why nothing qualified — that documents the flow was reviewed, not skipped. Set confidence (0-100) based on how thorough your investigation was and how certain you are of each finding.`;

async function callTool(name, args, log) {
  const tool = TOOLS_BY_NAME.get(name);
  if (!tool) throw new Error(`Unknown tool: ${name}`);
  const result = await tool.handler(args);
  log.push({ tool: name, args, resultSummary: JSON.stringify(result).slice(0, 500) });
  return result;
}

/**
 * Analyze one business flow and produce a persisted ProcessOptimizationProposal.
 * Returns { proposalId, status, toolCallLog } or throws.
 */
async function analyzeBusinessFlow(diagramId, { onEvent } = {}) {
  if (!isAnthropicConfigured()) {
    const err = new Error('Anthropic is not configured. Set ANTHROPIC_API_KEY in server/.env, then restart.');
    err.code = 'ANTHROPIC_NOT_CONFIGURED';
    throw err;
  }

  const flow = await getBusinessFlow({ diagramId });
  const anthropic = new Anthropic();
  const toolCallLog = [];

  const taskListText = flow.tasks
    .map((t) => `- [${t.taskId}] "${t.name}" (actor: ${t.actor || 'n/a'}) — applications: ${t.applications.join(', ') || 'none'}`)
    .join('\n');

  const messages = [
    {
      role: 'user',
      content: `Analyze this business flow:\n\nName: ${flow.name}\nDomain: ${flow.domain}\ndiagramId: ${flow.diagramId}\n\nTasks:\n${taskListText}`,
    },
  ];

  const anthropicTools = toAnthropicTools();
  let savedProposal = null;

  for (let iteration = 0; iteration < MAX_ITERATIONS && !savedProposal; iteration += 1) {
    const response = await anthropic.messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system: SYSTEM_PROMPT,
      tools: anthropicTools,
      messages,
    });

    messages.push({ role: 'assistant', content: response.content });
    const toolUseBlocks = response.content.filter((b) => b.type === 'tool_use');
    const textBlocks = response.content.filter((b) => b.type === 'text');
    onEvent?.({ type: 'assistant_message', iteration, text: textBlocks.map((b) => b.text).join('\n'), toolCalls: toolUseBlocks.length });

    if (!toolUseBlocks.length) {
      // Model responded without calling a tool — nudge it once toward
      // actually saving a proposal instead of just describing findings in
      // prose, rather than silently returning nothing.
      messages.push({
        role: 'user',
        content: 'Remember: you must call save_optimization_proposal to record your conclusion, even if there are no findings. Please do so now.',
      });
      continue;
    }

    const toolResultBlocks = [];
    for (const block of toolUseBlocks) {
      const name = block.name;
      const args = { ...(block.input || {}) };

      if (name === 'save_optimization_proposal') {
        // Defensive: never trust the model's own diagramId/diagramName —
        // fill in what we already fetched, and attach the audit trail it
        // has no business reporting on itself.
        args.diagramId = flow.diagramId;
        args.diagramName = flow.name;
        args.businessFlow = flow.name;
        args.toolCallLog = toolCallLog;
        args.model = MODEL;
      }

      let result;
      try {
        result = await callTool(name, args, toolCallLog);
      } catch (err) {
        result = { error: err.message };
      }

      if (name === 'save_optimization_proposal' && result?.proposalId) {
        savedProposal = result;
      }

      toolResultBlocks.push({ type: 'tool_result', tool_use_id: block.id, content: JSON.stringify(result) });
      onEvent?.({ type: 'tool_call', iteration, tool: name, args, result });
    }

    messages.push({ role: 'user', content: toolResultBlocks });
  }

  if (!savedProposal) {
    const err = new Error(`Agent did not save a proposal within ${MAX_ITERATIONS} iterations for diagram ${diagramId}.`);
    err.code = 'AGENT_NO_PROPOSAL';
    err.toolCallLog = toolCallLog;
    throw err;
  }

  return { ...savedProposal, toolCallLog };
}

module.exports = { analyzeBusinessFlow, isAnthropicConfigured };
