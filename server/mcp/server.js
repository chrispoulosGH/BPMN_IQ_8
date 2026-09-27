'use strict';

// BPMN_IQ_8 Landscape MCP server — Phase 1 (read-only tools + one write tool
// for persisting proposals). Exposes the same data this app's own routes
// already compute (dashboard.js risk/cost, processChangeRadar.js Jira
// matching) as MCP tools, so any MCP client — an agent loop, Claude Desktop,
// Claude Code — can query the LLM AMI landscape without re-implementing any
// of that logic. Two tools (search_apis/find_overlapping_apis, search_servers)
// query CanonicalData directly because no existing route returns raw
// API/Server catalogs; everything else calls the already-running Express API
// (see mcp/apiClient.js) as a logged-in service user.
//
// Run with: node mcp/server.js   (stdio transport — point an MCP client at
// this command). Requires `yarn dev`'s server already running for the tools
// that proxy over HTTP; requires MONGO_URI (same .env) for the two that don't.

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const mongoose = require('mongoose');
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { TOOLS } = require('./toolRegistry');

const MONGO_URI = process.env.MONGO_URI;

function asToolResult(promise) {
  return promise.then(
    (data) => ({ content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] }),
    (err) => ({ content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true })
  );
}

async function main() {
  await mongoose.connect(MONGO_URI);

  const server = new McpServer({ name: 'bpmn-iq-landscape', version: '0.1.0' });

  for (const tool of TOOLS) {
    server.registerTool(tool.name, {
      title: tool.title,
      description: tool.description,
      inputSchema: tool.inputSchema,
    }, (args) => asToolResult(tool.handler(args)));
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('[bpmn-iq-landscape MCP] ready on stdio');
}

main().catch((err) => {
  console.error('[bpmn-iq-landscape MCP] fatal:', err);
  process.exit(1);
});
