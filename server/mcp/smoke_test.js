'use strict';
// Manual verification for the landscape MCP server — spawns mcp/server.js
// over stdio (real MCP protocol, not a direct function call), lists tools,
// then calls a representative subset with real data and prints the results.
// Requires `yarn dev`'s server already running on :3001.
//
// Usage: node mcp/smoke_test.js
const path = require('path');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');

async function main() {
  const serverPath = path.join(__dirname, 'server.js');
  // The MCP SDK's stdio transport only inherits a curated env allowlist by
  // default (a deliberate security default) — that's too little for a real
  // client too, so any real MCP client config for this server should set
  // `env` explicitly the same way. Full process.env is fine here since this
  // is our own dev machine, not an untrusted server.
  const transport = new StdioClientTransport({ command: process.execPath, args: [serverPath], env: process.env });
  const client = new Client({ name: 'smoke-test', version: '0.1.0' });
  await client.connect(transport);

  const tools = await client.listTools();
  console.log('=== TOOLS ===');
  console.log(tools.tools.map((t) => t.name).join(', '));

  async function call(name, args) {
    console.log(`\n=== ${name}(${JSON.stringify(args)}) ===`);
    const res = await client.callTool({ name, arguments: args });
    if (res.isError) console.log('ERROR:', res.content[0].text);
    else console.log(res.content[0].text.slice(0, 1500));
    return res;
  }

  await call('list_business_flows', { nameContains: 'Warranty' });
  const flows = await client.callTool({ name: 'list_business_flows', arguments: { nameContains: 'Warranty' } });
  const parsedFlows = JSON.parse(flows.content[0].text);
  const firstFlowId = parsedFlows[0]?.diagramId;
  if (firstFlowId) await call('get_business_flow', { diagramId: firstFlowId });

  await call('get_application_profile', { appIdOrAcronym: 'WARRANTY-SALES' });

  const apis = await call('search_apis', { domain: 'Finance & Insurance', apiType: 'Task Support API', limit: 3 });
  const firstApiId = JSON.parse(apis.content[0].text).results?.[0]?.apiId;
  if (firstApiId) await call('find_overlapping_apis', { apiId: firstApiId, limit: 3 });

  await call('search_servers', { maxAvgUtilPct: 20, limit: 5 });
  await call('get_feature_cost', { businessFlow: 'Warranty Contract Execution' });
  await call('get_jira_activity', { businessFlowName: 'Warranty Contract Execution' });

  if (firstFlowId) {
    await call('save_optimization_proposal', {
      diagramId: firstFlowId,
      diagramName: parsedFlows[0].name,
      businessFlow: parsedFlows[0].name,
      summary: 'Smoke test proposal — safe to delete from processoptimizationproposals.',
      rationale: ['Wiring test for save_optimization_proposal.'],
      taskDiff: [{ op: 'remove', taskId: 'test-task-id', taskName: 'Test Step', reason: 'smoke test' }],
      projectedImpact: { costDeltaUsd: -1000 },
      confidence: 50,
    });
  }

  await client.close();
}

main().catch((err) => { console.error('SMOKE TEST FAILED:', err); process.exit(1); });
