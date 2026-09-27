'use strict';

// Single source of truth for the landscape tool surface — name, description,
// zod input schema, and handler, once each. mcp/server.js registers these as
// MCP tools (for external clients: Claude Desktop, Claude Code, an MCP
// inspector); services/processOptimizerAgent.js converts the same schemas to
// OpenAI's function-calling format and calls the same handlers directly
// in-process (no reason for the embedded agent to round-trip through the
// stdio protocol to reach code living in the same repo).

const { z } = require('zod');
const { listBusinessFlows } = require('./tools/listBusinessFlows');
const { getBusinessFlow } = require('./tools/getBusinessFlow');
const { getApplicationProfile } = require('./tools/getApplicationProfile');
const { searchApis } = require('./tools/searchApis');
const { findOverlappingApis } = require('./tools/findOverlappingApis');
const { searchServers } = require('./tools/searchServers');
const { getFeatureCost } = require('./tools/getFeatureCost');
const { getJiraActivity } = require('./tools/getJiraActivity');
const { saveOptimizationProposal } = require('./tools/saveOptimizationProposal');

const TOOLS = [
  {
    name: 'list_business_flows',
    title: 'List business flows',
    description: 'List business process flows (diagrams) in the landscape, optionally filtered by domain or name substring.',
    inputSchema: {
      domain: z.string().optional().describe('Business domain, e.g. "Finance & Insurance"'),
      nameContains: z.string().optional().describe('Case-insensitive substring match against the flow name'),
    },
    handler: listBusinessFlows,
  },
  {
    name: 'get_business_flow',
    title: 'Get business flow',
    description: 'Get one business flow\'s full task list (task name, actor, sequence, applications used) by diagram id.',
    inputSchema: { diagramId: z.string() },
    handler: getBusinessFlow,
  },
  {
    name: 'get_application_profile',
    title: 'Get application profile',
    description: 'Get one application\'s asset counts and security/defect risk ranking, by app id, acronym, or name.',
    inputSchema: { appIdOrAcronym: z.string() },
    handler: getApplicationProfile,
  },
  {
    name: 'search_apis',
    title: 'Search APIs',
    description: 'Search the API catalog by domain, API type, owning application, or name substring. Use appIdOrAcronym to list everything one application exposes.',
    inputSchema: {
      domain: z.string().optional(),
      apiType: z.string().optional().describe('"Task Support API" or "System Service API"'),
      appIdOrAcronym: z.string().optional(),
      nameContains: z.string().optional(),
      limit: z.number().int().positive().max(200).optional(),
    },
    handler: searchApis,
  },
  {
    name: 'find_overlapping_apis',
    title: 'Find overlapping APIs',
    description: 'Given one API (by its API ID Qualifier, e.g. "API-00766"), find candidate APIs in OTHER applications that expose the same domain + API type — the deterministic pre-filter for duplicate-functionality judgment. Ranked by name-token overlap; does not itself judge whether a candidate is truly a duplicate — read the candidate names/endpoints yourself before deciding.',
    inputSchema: { apiId: z.string(), limit: z.number().int().positive().max(20).optional() },
    handler: findOverlappingApis,
  },
  {
    name: 'search_servers',
    title: 'Search servers',
    description: 'Search the server fleet by owning application, role, or a maximum average-utilization ceiling.',
    inputSchema: {
      appIdOrAcronym: z.string().optional(),
      role: z.string().optional().describe('e.g. "Database Server", "Cache Server", "API Gateway"'),
      maxAvgUtilPct: z.number().min(0).max(100).optional(),
      limit: z.number().int().positive().max(200).optional(),
    },
    handler: searchServers,
  },
  {
    name: 'get_feature_cost',
    title: 'Get feature dev cost',
    description: 'Get total feature-development cost for a business flow, optionally scoped to one application and/or year.',
    inputSchema: {
      businessFlow: z.string().optional(),
      applicationName: z.string().optional(),
      year: z.number().int().optional(),
    },
    handler: getFeatureCost,
  },
  {
    name: 'get_jira_activity',
    title: 'Get Jira activity',
    description: 'Get current/planned Jira issue activity (counts, overdue status, dev-days) for a business flow (by diagramId or name) and/or a set of application names.',
    inputSchema: {
      diagramId: z.string().optional(),
      businessFlowName: z.string().optional(),
      applicationNames: z.array(z.string()).optional(),
    },
    handler: getJiraActivity,
  },
  {
    name: 'save_optimization_proposal',
    title: 'Save optimization proposal',
    description: 'Persist a proposed alternative process (task diff + rationale + projected impact) for human review. Never modifies the live diagram directly. Call this exactly once, at the end of your investigation, summarizing every accepted finding for the flow together.',
    inputSchema: {
      diagramId: z.string(),
      diagramName: z.string().optional(),
      businessFlow: z.string().optional(),
      summary: z.string(),
      rationale: z.array(z.string()).optional(),
      taskDiff: z.array(z.object({
        op: z.enum(['add', 'remove', 'retarget_application', 'rename']),
        taskId: z.string().optional(),
        taskName: z.string().optional(),
        actor: z.string().optional(),
        detail: z.record(z.string(), z.any()).optional(),
        reason: z.string(),
      })).optional(),
      projectedImpact: z.object({
        costDeltaUsd: z.number().optional(),
        securityRiskDelta: z.number().optional(),
        defectRiskDelta: z.number().optional(),
        jiraActivityDelta: z.number().optional(),
      }).optional(),
      confidence: z.number().min(0).max(100).optional(),
    },
    handler: saveOptimizationProposal,
  },
];

module.exports = { TOOLS };
