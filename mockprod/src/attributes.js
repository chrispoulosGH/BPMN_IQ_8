/**
 * Telemetry attribute dictionary — the contract between the simulator and
 * anything that reads the traces back (Observe queries, tools/reconstruct-bpmn.js).
 *
 * OpenTelemetry has no semantic conventions for business processes, so these
 * live under custom namespaces:
 *   bpmn.*      the BPMN 2.0 model element a span belongs to (ids are the real
 *               element ids from the diagram XML, so the model can be rebuilt)
 *   business.*  the business transaction (journey, customer) across flows
 *   app.*       the business application (also on the resource as app.id etc.)
 *   api.*       the catalog API being called
 *   sim.*       simulator internals (injected faults, incidents)
 *
 * The bpmn.process.* / bpmn.task.* / business.* keys travel as W3C baggage, and
 * a span processor in every service copies them onto every span — so even an
 * auto-instrumented HTTP span in a downstream app knows its flow and task.
 */
module.exports = {
  // Process (business flow) — on every span of an instance
  PROCESS_ID: 'bpmn.process.id', // XML <process id>
  PROCESS_NAME: 'bpmn.process.name', // business flow name
  PROCESS_INSTANCE_ID: 'bpmn.process.instance_id',
  PROCESS_DIAGRAM_ID: 'bpmn.diagram.id', // BPMN IQ diagram _id
  PROCESS_DOMAIN: 'bpmn.domain',
  PROCESS_SUBDOMAIN: 'bpmn.subdomain',
  PROCESS_PARTICIPANT_ID: 'bpmn.participant.id',
  PROCESS_PARTICIPANT_NAME: 'bpmn.participant.name',
  PROCESS_COLLABORATION_ID: 'bpmn.collaboration.id',
  PROCESS_OUTCOME: 'bpmn.process.outcome', // completed | failed | abandoned (root span)
  PROCESS_LANES: 'bpmn.process.lanes', // root span: ["Lane_x|Name", ...]

  // Task (flow node) — on the task span and every span beneath it
  TASK_ID: 'bpmn.task.id',
  TASK_NAME: 'bpmn.task.name',
  TASK_TYPE: 'bpmn.task.type', // task | userTask | serviceTask ...
  TASK_SEQUENCE: 'bpmn.task.sequence', // 1-based position in this instance
  LANE_ID: 'bpmn.lane.id',
  LANE_NAME: 'bpmn.lane.name', // actor / role
  TASK_PERFORMER: 'bpmn.task.performer', // human | system
  TASK_OUTCOME: 'bpmn.task.outcome',
  // Sequence flows (task span): enough to redraw the edges exactly
  INCOMING_FLOW_ID: 'bpmn.sequence_flow.incoming.id',
  INCOMING_FLOW_SOURCE_ID: 'bpmn.sequence_flow.incoming.source_id',
  OUTGOING_FLOW_ID: 'bpmn.sequence_flow.outgoing.id',
  OUTGOING_FLOW_TARGET_ID: 'bpmn.sequence_flow.outgoing.target_id',

  // Application
  APP_ID: 'app.id',
  APP_ACRONYM: 'app.acronym',
  APP_NAME: 'app.name',
  APP_DOMAIN: 'app.domain',
  APP_CRITICALITY: 'app.criticality',
  TASK_APP_ID: 'bpmn.task.application.id', // task span: the app(s) the task runs in, from its diagram (string[])
  TASK_APP_ACRONYM: 'bpmn.task.application.acronym', // string[]; may differ from api.provider.app_id

  // API
  API_ID: 'api.id',
  API_NAME: 'api.name',
  API_TYPE: 'api.type',
  API_LIFECYCLE: 'api.lifecycle',
  API_PROVIDER_APP_ID: 'api.provider.app_id',
  API_CONSUMER_APP_ID: 'api.consumer.app_id',
  API_REQUEST_OBJECT: 'api.request.data_object',
  API_RESPONSE_OBJECT: 'api.response.data_object',
  HANDOFF_DATA_OBJECT: 'api.handoff.data_object',

  // Business transaction
  JOURNEY_ID: 'business.journey.id',
  JOURNEY_TYPE: 'business.journey.type',
  JOURNEY_STEP: 'business.journey.step',
  CUSTOMER_ID: 'business.customer.id',
  DEALER_CODE: 'business.dealer.code',

  // Simulator
  SIM_FAULT: 'sim.fault',
  SIM_INCIDENT: 'sim.incident.active',

  // Prefixes copied from baggage onto every span
  BAGGAGE_PREFIXES: ['bpmn.', 'business.'],
};
