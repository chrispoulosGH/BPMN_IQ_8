// Integration test: seeds a small, known Business Capability -> Business Process Flow ->
// Task -> Application hierarchy (the same shape the materializer produces from an uploaded
// spreadsheet) directly into CanonicalComponent, runs the real generation pipeline against it,
// and asserts the resulting Diagram faithfully reflects that source data — not just that some
// diagram got created. Requires a reachable MONGO_URI (loaded from server/.env, same as the app
// itself); the suite skips itself with a warning if one isn't configured.
require('dotenv').config();
const mongoose = require('mongoose');
const CanonicalComponent = require('../../models/CanonicalComponent');
const Diagram = require('../../models/Diagram');
const { generateFlowDiagramsForNeighborhood } = require('../generateFlowDiagrams');

const hasMongoUri = Boolean(process.env.MONGO_URI);
const NEIGHBORHOOD = `__vitest_diagram_gen_test__${Date.now()}`;

const d = hasMongoUri ? describe : describe.skip;

d('generateFlowDiagramsForNeighborhood (integration)', () => {
  let seededIds;

  beforeAll(async () => {
    await mongoose.connect(process.env.MONGO_URI);

    const insert = (doc) => CanonicalComponent.create(doc);

    const capability = await insert({
      neighborhoodName: NEIGHBORHOOD,
      componentType: 'Business Capability',
      primaryKey: 'Manage Test Resources',
      values: { name: 'Manage Test Resources' },
      parentRefs: [],
      childrenRefs: [],
    });

    const flow = await insert({
      neighborhoodName: NEIGHBORHOOD,
      componentType: 'Business Process Flow',
      primaryKey: 'Vitest Sample Flow',
      values: { name: 'Vitest Sample Flow' },
      parentRefs: [capability._id],
      childrenRefs: [],
    });

    const appX = await insert({
      neighborhoodName: NEIGHBORHOOD,
      componentType: 'Application',
      primaryKey: 'App X',
      values: { 'Application Component': 'App X', 'CORRELATION_ID Qualifier': 'LLM-900', 'X_ATT2_ITAP_U_APPL_ACRON_NM Qualifier': 'APX' },
      parentRefs: [],
      childrenRefs: [],
    });

    const appY = await insert({
      neighborhoodName: NEIGHBORHOOD,
      componentType: 'Application',
      primaryKey: 'App Y',
      values: { 'Application Component': 'App Y', 'CORRELATION_ID Qualifier': 'LLM-901' },
      parentRefs: [],
      childrenRefs: [],
    });

    const taskA = await insert({
      neighborhoodName: NEIGHBORHOOD,
      componentType: 'Task',
      primaryKey: 'Submit Test Request',
      values: { name: 'Submit Test Request', actor_qualifier: 'Requester' },
      parentRefs: [flow._id],
      childrenRefs: [appX._id],
    });

    const taskB = await insert({
      neighborhoodName: NEIGHBORHOOD,
      componentType: 'Task',
      primaryKey: 'Approve Test Request',
      values: { name: 'Approve Test Request', actor_qualifier: 'Approver' },
      parentRefs: [flow._id],
      childrenRefs: [appY._id],
    });

    flow.childrenRefs = [taskA._id, taskB._id];
    await flow.save();

    seededIds = { capability, flow, appX, appY, taskA, taskB };
  });

  afterAll(async () => {
    await CanonicalComponent.deleteMany({ neighborhoodName: NEIGHBORHOOD });
    await Diagram.deleteMany({ neighborhoodName: NEIGHBORHOOD });
    await mongoose.disconnect();
  });

  it('generates a diagram whose task order, actors, and linked applications match the seeded source data', async () => {
    const result = await generateFlowDiagramsForNeighborhood({ neighborhoodName: NEIGHBORHOOD });
    expect(result.skipped).toBe(false);
    expect(result.created).toBe(1);

    const diagram = await Diagram.findOne({ neighborhoodName: NEIGHBORHOOD, name: 'Vitest Sample Flow' }).lean();
    expect(diagram).toBeTruthy();
    expect(diagram.sourcedFrom).toBe('BPMN Automation');
    expect(diagram.businessFlow).toBe('Vitest Sample Flow');
    expect(diagram.businessCapability).toBe('Manage Test Resources');

    // Task order and actor assignment must match the source Task docs' childrenRefs order on the Flow.
    expect(diagram.tasks.map((t) => t.name)).toEqual(['Submit Test Request', 'Approve Test Request']);
    expect(diagram.tasks[0].actor).toBe('Requester');
    expect(diagram.tasks[1].actor).toBe('Approver');
    expect(diagram.tasks[0].source).toBeNull();
    expect(diagram.tasks[0].target).toBe('Approve Test Request');
    expect(diagram.tasks[1].source).toBe('Submit Test Request');
    expect(diagram.tasks[1].target).toBeNull();

    // Each task's applications must match the source Application docs referenced by that task's childrenRefs.
    const appFields = (apps) => apps.map(({ name, correlationId }) => ({ name, correlationId }));
    expect(appFields(diagram.tasks[0].applications)).toEqual([{ name: 'App X', correlationId: 'LLM-900' }]);
    expect(appFields(diagram.tasks[1].applications)).toEqual([{ name: 'App Y', correlationId: 'LLM-901' }]);

    // The generated BPMN XML itself must contain both actor lanes and both task names.
    expect(diagram.xml).toContain('name="Requester"');
    expect(diagram.xml).toContain('name="Approver"');
    expect(diagram.xml).toContain('name="Submit Test Request"');
    expect(diagram.xml).toContain('name="Approve Test Request"');
    // And the linked-application annotation must carry the correlation id + acronym for App X.
    expect(diagram.xml).toContain('LLM-900 | APX | App X');
  });

  it('is idempotent: re-running for the same neighborhood updates rather than duplicating the diagram', async () => {
    const first = await Diagram.findOne({ neighborhoodName: NEIGHBORHOOD, name: 'Vitest Sample Flow' }).lean();

    const result = await generateFlowDiagramsForNeighborhood({ neighborhoodName: NEIGHBORHOOD });
    expect(result.updated).toBe(1);
    expect(result.created).toBe(0);

    const count = await Diagram.countDocuments({ neighborhoodName: NEIGHBORHOOD, name: 'Vitest Sample Flow' });
    expect(count).toBe(1);

    const second = await Diagram.findOne({ neighborhoodName: NEIGHBORHOOD, name: 'Vitest Sample Flow' }).lean();
    expect(String(second._id)).toBe(String(first._id));
  });

  it('does not overwrite a manually-created diagram that already owns the flow name', async () => {
    const manualName = 'Vitest Sample Flow Manual Conflict';
    await CanonicalComponent.updateOne(
      { neighborhoodName: NEIGHBORHOOD, componentType: 'Business Process Flow', primaryKey: 'Vitest Sample Flow' },
      { $set: { primaryKey: manualName, 'values.name': manualName } }
    );
    await Diagram.create({
      neighborhoodName: NEIGHBORHOOD,
      name: manualName,
      xml: '<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" id="Definitions_Manual"/>',
      sourcedFrom: 'manual',
      status: 'draft',
    });

    const result = await generateFlowDiagramsForNeighborhood({ neighborhoodName: NEIGHBORHOOD });
    expect(result.conflicts).toBe(1);

    const manualDiagram = await Diagram.findOne({ neighborhoodName: NEIGHBORHOOD, name: manualName }).lean();
    expect(manualDiagram.sourcedFrom).toBe('manual');
    expect(manualDiagram.xml).toContain('Definitions_Manual');
  });
});
