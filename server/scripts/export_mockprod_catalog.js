/**
 * Exports the catalog the mock production environment (../mockprod) runs from:
 * the chosen business flows with their real BPMN element ids, and for every
 * task the API it calls, the provider/consumer applications, the (derived)
 * host server and the request/response data objects with their fields.
 *
 *   node scripts/export_mockprod_catalog.js                      # default 3 flows
 *   node scripts/export_mockprod_catalog.js --flows="A|B|C" --out=../mockprod/catalog/catalog.json
 *
 * Re-run it after the diagrams or API data change; the simulator reads only
 * this file (it never talks to MongoDB).
 *
 * Flows in ../mockprod/catalog/discovered-flows.json (processes that run in
 * mock production but have no BPMN IQ diagram) are appended with
 * `discovered: true`; their apps, host servers and data objects are resolved
 * here too.
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const Diagram = require('../models/Diagram');
const { getIntegrationMapCached } = require('../routes/integrationMap');
const { buildApiSequence, parseBpmn } = require('../services/apiSequence');

const DEFAULT_FLOWS = ['Digital Retailing Journey', 'Customer Credit Application', 'Warranty Contract Execution'];
const arg = (name) => (process.argv.find((a) => a.startsWith(`--${name}=`)) || '').split('=').slice(1).join('=');
const flowNames = arg('flows') ? arg('flows').split('|').map((s) => s.trim()).filter(Boolean) : DEFAULT_FLOWS;
const outPath = path.resolve(__dirname, '..', arg('out') || '../mockprod/catalog/catalog.json');
const discoveredPath = path.resolve(__dirname, '..', arg('discovered') || '../mockprod/catalog/discovered-flows.json');
const HOST_ROLE_PREFERENCE = ['API Gateway', 'Integration Server', 'Application Server', 'Web Server'];
const hashString = (value) => [...String(value)].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) >>> 0, 7);

const attr = (attrs, name) => (String(attrs || '').match(new RegExp(`\\b${name}="([^"]*)"`, 'i')) || [])[1] || '';
const decode = (v) => String(v || '').replace(/&#10;|&#xA;/gi, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();

/** Process, collaboration/participant and lane ids straight from the XML. */
function parseStructure(xml) {
  const processMatch = /<bpmn2?:process\b([^>]*)>/i.exec(xml);
  const participantMatch = /<bpmn2?:participant\b([^>]*?)\/?>/i.exec(xml);
  const collaborationMatch = /<bpmn2?:collaboration\b([^>]*)>/i.exec(xml);
  const lanes = [];
  const laneRegex = /<bpmn2?:lane\b([^>]*)>([\s\S]*?)<\/bpmn2?:lane>/gi;
  let m;
  while ((m = laneRegex.exec(xml)) !== null) {
    const nodeIds = [...m[2].matchAll(/<bpmn2?:flowNodeRef>([^<]+)<\/bpmn2?:flowNodeRef>/gi)].map((r) => r[1].trim());
    lanes.push({ id: attr(m[1], 'id'), name: decode(attr(m[1], 'name')), nodeIds });
  }
  return {
    processId: processMatch ? attr(processMatch[1], 'id') : '',
    processName: processMatch ? decode(attr(processMatch[1], 'name')) : '',
    isExecutable: processMatch ? attr(processMatch[1], 'isExecutable') !== 'false' : true,
    collaborationId: collaborationMatch ? attr(collaborationMatch[1], 'id') : '',
    participantId: participantMatch ? attr(participantMatch[1], 'id') : '',
    participantName: participantMatch ? decode(attr(participantMatch[1], 'name')) : '',
    lanes,
  };
}

async function main() {
  await mongoose.connect(process.env.MONGO_URI || 'mongodb://127.0.0.1:27018/bpmn_iq');
  const { data, apiIndex } = await getIntegrationMapCached(true);
  const appsById = new Map(data.apps.map((a) => [a.id, a]));

  const flows = [];
  const usedApps = new Set();
  const usedHosts = new Set();
  const usedObjects = new Set();

  for (const flowName of flowNames) {
    const diagram = await Diagram.findOne({ name: flowName }, { name: 1, businessFlow: 1, domain: 1, subdomain: 1, xml: 1, tasks: 1 }).lean();
    if (!diagram) throw new Error(`No diagram named "${flowName}"`);
    const sequence = buildApiSequence(diagram, { apiIndex, apps: data.apps, dataObjects: data.dataObjects, hosts: data.hosts });
    if (sequence.fragmentCount) console.warn(`  ! ${flowName} has gateways; the simulator runs branches by sampling one path.`);
    const structure = parseStructure(diagram.xml);
    const { nodes, flows: sequenceFlows } = parseBpmn(diagram.xml);
    const laneByNode = new Map(structure.lanes.flatMap((lane) => lane.nodeIds.map((id) => [id, lane])));
    const steps = sequence.items.flatMap((item) => (item.kind === 'step' ? [item.step] : item.fragment.branches.flatMap((b) => b.steps)));

    const tasks = steps.map((step, index) => {
      const incoming = sequenceFlows.filter((f) => f.target === step.taskId);
      const outgoing = sequenceFlows.filter((f) => f.source === step.taskId);
      const lane = laneByNode.get(step.taskId);
      // The task runs in its diagram application; fall back to the API provider.
      const diagramTask = (diagram.tasks || []).find((t) => t.name === step.taskName);
      const calls = step.calls.map((call) => {
        usedApps.add(call.provider); if (call.consumer) usedApps.add(call.consumer);
        if (call.host) usedHosts.add(call.host);
        if (call.requestObject) usedObjects.add(call.requestObject);
        if (call.responseObject) usedObjects.add(call.responseObject);
        return {
          apiId: call.id, apiName: call.name, method: call.method, endpoint: call.endpoint, apiType: call.type, lifecycle: call.lifecycle,
          provider: call.provider, consumer: call.consumer || call.provider, internal: call.internal,
          host: call.host, requestObject: call.requestObject, responseObject: call.responseObject,
        };
      });
      return {
        sequence: index + 1,
        id: step.taskId,
        name: step.taskName,
        type: step.taskType,
        laneId: lane?.id || '',
        laneName: lane?.name || step.lane || '',
        diagramApplications: (diagramTask?.applications || []).map((a) => a.name),
        incoming: incoming.map((f) => ({ id: f.id, sourceId: f.source, name: f.name })),
        outgoing: outgoing.map((f) => ({ id: f.id, targetId: f.target, name: f.name })),
        calls,
      };
    });

    const events = [...nodes.values()].filter((n) => n.kind === 'event').map((n) => ({
      id: n.id, name: n.name, type: n.type, laneId: laneByNode.get(n.id)?.id || '',
      incoming: sequenceFlows.filter((f) => f.target === n.id).map((f) => ({ id: f.id, sourceId: f.source })),
      outgoing: sequenceFlows.filter((f) => f.source === n.id).map((f) => ({ id: f.id, targetId: f.target })),
    }));

    flows.push({
      diagramId: String(diagram._id),
      name: diagram.name,
      businessFlow: diagram.businessFlow || diagram.name,
      domain: (diagram.domain || '').replace(/&amp;/g, '&'),
      subdomain: (diagram.subdomain || '').replace(/&amp;/g, '&'),
      ...structure,
      lanes: structure.lanes.map(({ id, name }) => ({ id, name })),
      events,
      sequenceFlows: sequenceFlows.map((f) => ({ id: f.id, sourceId: f.source, targetId: f.target, name: f.name })),
      tasks,
    });
    console.log(`  ${flowName}: ${tasks.length} tasks, ${tasks.reduce((n, t) => n + t.calls.length, 0)} API calls, ${structure.lanes.length} lanes, process ${structure.processId}`);
  }

  // ── Discovered flows (not in BPMN IQ) ──────────────────────────────────────
  const extraHosts = {};
  const extraObjects = {};
  if (fs.existsSync(discoveredPath)) {
    const discovered = JSON.parse(fs.readFileSync(discoveredPath, 'utf8'));
    Object.assign(extraObjects, discovered.dataObjects || {});
    const serverDocs = await mongoose.connection.db.collection('canonicaldata').find(
      { neighborhoodName: 'System Components', componentType: 'Servers' },
      { projection: { values: 1 } },
    ).toArray();
    const serversByApp = new Map();
    for (const doc of serverDocs) {
      const v = doc.values || {};
      const appId = String(v['FK_System Components[Applications].APP_ID'] || v['FK_System Component[Applications].APP_ID'] || '').trim();
      if (!appId) continue;
      if (!serversByApp.has(appId)) serversByApp.set(appId, []);
      serversByApp.get(appId).push({
        id: String(v['SERVER_ID Qualifier'] || '').trim(),
        name: String(v['SERVER_NAME Component'] || '').trim(),
        role: String(v['SERVER_ROLE Aggregate'] || '').trim(),
        city: String(v['LOCATION_CITY Aggregate'] || '').trim(),
        datacenter: String(v['LOCATION_DATACENTER Qualifier'] || '').trim(),
        environment: String(v['NETWORK_ZONE Aggregate'] || '').trim(),
      });
    }
    const pickHost = (appId, apiId) => {
      const servers = (serversByApp.get(appId) || []).filter((s) => s.id).sort((a, b) => a.id.localeCompare(b.id));
      for (const role of HOST_ROLE_PREFERENCE) {
        const candidates = servers.filter((s) => s.role === role);
        if (candidates.length) return candidates[hashString(apiId) % candidates.length];
      }
      return servers[0] || null;
    };

    for (const def of discovered.flows || []) {
      const laneById = new Map(def.lanes.map((l) => [l.id, l]));
      const nodeIds = [def.startEvent.id, ...def.tasks.map((t) => t.id), def.endEvent.id];
      const sequenceFlows = nodeIds.slice(1).map((target, i) => ({ id: `Flow_${i + 1}`, sourceId: nodeIds[i], targetId: target, name: '' }));
      let apiNumber = 0;
      const tasks = def.tasks.map((t, index) => {
        apiNumber += 1;
        const apiId = `API-U${String(apiNumber).padStart(3, '0')}`;
        const host = pickHost(t.provider, apiId);
        if (host) extraHosts[host.id] = host;
        usedApps.add(t.provider);
        usedApps.add(t.consumer);
        for (const objectId of [t.request, t.response]) if (objectId) usedObjects.add(objectId);
        return {
          sequence: index + 1,
          id: t.id,
          name: t.name,
          type: 'task',
          laneId: t.lane,
          laneName: laneById.get(t.lane)?.name || '',
          diagramApplications: [appsById.get(t.provider)?.acronym || t.provider],
          incoming: sequenceFlows.filter((f) => f.targetId === t.id).map((f) => ({ id: f.id, sourceId: f.sourceId, name: '' })),
          outgoing: sequenceFlows.filter((f) => f.sourceId === t.id).map((f) => ({ id: f.id, targetId: f.targetId, name: '' })),
          calls: [{
            apiId,
            apiName: `${def.name} — ${t.name} API`,
            method: t.method,
            endpoint: `${def.endpointBase}/${t.slug}`,
            apiType: 'Task Support API',
            lifecycle: 'Production',
            provider: t.provider,
            consumer: t.consumer,
            internal: t.provider === t.consumer,
            host: host?.id || '',
            requestObject: t.request || '',
            responseObject: t.response || '',
          }],
        };
      });
      const laneOf = (id) => (id === def.startEvent.id ? tasks[0].laneId : tasks[tasks.length - 1].laneId);
      flows.push({
        discovered: true,
        diagramId: '',
        name: def.name,
        businessFlow: def.name,
        domain: def.domain,
        subdomain: def.subdomain,
        processId: def.processId,
        processName: '',
        isExecutable: false,
        collaborationId: '',
        participantId: '',
        participantName: '',
        abandonRate: def.abandonRate,
        lanes: def.lanes,
        events: [
          { id: def.startEvent.id, name: def.startEvent.name, type: 'startEvent', laneId: laneOf(def.startEvent.id), incoming: [], outgoing: [{ id: sequenceFlows[0].id, targetId: sequenceFlows[0].targetId }] },
          { id: def.endEvent.id, name: def.endEvent.name, type: 'endEvent', laneId: laneOf(def.endEvent.id), incoming: [{ id: sequenceFlows[sequenceFlows.length - 1].id, sourceId: sequenceFlows[sequenceFlows.length - 1].sourceId }], outgoing: [] },
        ],
        sequenceFlows,
        tasks,
      });
      console.log(`  ${def.name} (discovered, not in BPMN IQ): ${tasks.length} tasks, ${def.lanes.length} lanes, process ${def.processId}`);
    }
  }

  const pick = (ids, source) => Object.fromEntries([...ids].filter((id) => source[id]).map((id) => [id, source[id]]));
  const catalog = {
    generatedAt: new Date().toISOString(),
    source: 'BPMN IQ (server/scripts/export_mockprod_catalog.js)',
    notes: {
      hosts: data.hostAssignmentNote,
      dataObjects: data.dataObjectNote,
    },
    flows,
    applications: Object.fromEntries([...usedApps].map((id) => [id, appsById.get(id) || { id, acronym: id, name: '', domain: '', criticality: '' }])),
    hosts: { ...pick(usedHosts, data.hosts), ...extraHosts },
    dataObjects: { ...pick(usedObjects, data.dataObjects), ...pick(usedObjects, extraObjects) },
  };
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, `${JSON.stringify(catalog, null, 2)}\n`);
  console.log(`Wrote ${outPath}: ${flows.length} flows, ${usedApps.size} applications, ${usedHosts.size} hosts, ${usedObjects.size} data objects`);
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
