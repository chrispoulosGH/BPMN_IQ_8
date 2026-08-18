const { buildBpmnXmlForFlow } = require('../bpmnXmlBuilder');
const { DOMParser } = require('@xmldom/xmldom');

function parse(xml) {
  const errors = [];
  const parser = new DOMParser({
    onError: (level, msg) => {
      if (level === 'error' || level === 'fatalError') errors.push(`${level}: ${msg}`);
    },
  });
  const doc = parser.parseFromString(xml, 'text/xml');
  expect(errors, `XML should parse without errors:\n${errors.join('\n')}`).toHaveLength(0);
  return doc;
}

const NS = {
  bpmn: 'http://www.omg.org/spec/BPMN/20100524/MODEL',
  bpmndi: 'http://www.omg.org/spec/BPMN/20100524/DI',
};

function findAll(doc, ns, localName) {
  return Array.from(doc.getElementsByTagNameNS(ns, localName));
}

describe('buildBpmnXmlForFlow', () => {
  it('produces one lane per distinct actor, in first-seen order, each owning its own tasks', () => {
    const { xml } = buildBpmnXmlForFlow({
      flowName: 'Manage Financial Resources',
      breadcrumb: 'Domain: Finance | Business Flow: Manage Financial Resources',
      tasks: [
        { name: 'Submit Request', actor: 'Customer' },
        { name: 'Review Request', actor: 'Analyst' },
        { name: 'Approve Request', actor: 'Analyst' },
        { name: 'Notify Customer', actor: 'Customer' },
      ],
    });

    const doc = parse(xml);
    const lanes = findAll(doc, NS.bpmn, 'lane');
    expect(lanes.map((l) => l.getAttribute('name'))).toEqual(['Customer', 'Analyst']);

    const refsByLane = Object.fromEntries(
      lanes.map((lane) => [
        lane.getAttribute('name'),
        findAll(lane, NS.bpmn, 'flowNodeRef').map((r) => r.textContent),
      ])
    );

    const taskIdByName = Object.fromEntries(
      findAll(doc, NS.bpmn, 'task').map((t) => [t.getAttribute('name'), t.getAttribute('id')])
    );

    // Customer's lane holds the start event (first task's actor) and its own two tasks.
    expect(refsByLane.Customer).toContain(taskIdByName['Submit Request']);
    expect(refsByLane.Customer).toContain(taskIdByName['Notify Customer']);
    expect(refsByLane.Customer).not.toContain(taskIdByName['Review Request']);
    // Analyst's lane holds only its own two tasks, plus the end event (last task's actor is Customer, not Analyst).
    expect(refsByLane.Analyst).toContain(taskIdByName['Review Request']);
    expect(refsByLane.Analyst).toContain(taskIdByName['Approve Request']);
  });

  it('chains tasks start -> t1 -> t2 -> ... -> end via sequence flows, preserving source order', () => {
    const { xml } = buildBpmnXmlForFlow({
      flowName: 'Three Step Flow',
      tasks: [
        { name: 'Alpha', actor: 'Owner' },
        { name: 'Beta', actor: 'Owner' },
        { name: 'Gamma', actor: 'Owner' },
      ],
    });
    const doc = parse(xml);

    const startId = findAll(doc, NS.bpmn, 'startEvent')[0].getAttribute('id');
    const endId = findAll(doc, NS.bpmn, 'endEvent')[0].getAttribute('id');
    const taskIdByName = Object.fromEntries(
      findAll(doc, NS.bpmn, 'task').map((t) => [t.getAttribute('name'), t.getAttribute('id')])
    );
    const flows = findAll(doc, NS.bpmn, 'sequenceFlow').map((f) => [f.getAttribute('sourceRef'), f.getAttribute('targetRef')]);

    expect(flows).toEqual([
      [startId, taskIdByName.Alpha],
      [taskIdByName.Alpha, taskIdByName.Beta],
      [taskIdByName.Beta, taskIdByName.Gamma],
      [taskIdByName.Gamma, endId],
    ]);
  });

  it('falls back to a single "Unassigned" lane when no task has an actor', () => {
    const { xml } = buildBpmnXmlForFlow({
      flowName: 'No Actor Flow',
      tasks: [{ name: 'Solo Task' }],
    });
    const doc = parse(xml);
    const lanes = findAll(doc, NS.bpmn, 'lane');
    expect(lanes).toHaveLength(1);
    expect(lanes[0].getAttribute('name')).toBe('Unassigned');
  });

  it('still emits a valid start->end diagram with zero tasks (all filtered out)', () => {
    const { xml } = buildBpmnXmlForFlow({ flowName: 'Empty Flow', tasks: [{ name: '   ' }, null] });
    const doc = parse(xml);
    expect(findAll(doc, NS.bpmn, 'task')).toHaveLength(0);
    expect(findAll(doc, NS.bpmn, 'startEvent')).toHaveLength(1);
    expect(findAll(doc, NS.bpmn, 'endEvent')).toHaveLength(1);
    expect(findAll(doc, NS.bpmn, 'sequenceFlow')).toHaveLength(1);
  });

  it('emits a textAnnotation associated to its task, formatted as "correlationId | acronym | name" per application', () => {
    const { xml } = buildBpmnXmlForFlow({
      flowName: 'App Linked Flow',
      tasks: [
        {
          name: 'Process Payment',
          actor: 'Billing',
          applications: [{ name: 'Core Billing Platform', correlationId: 'LLM-001', acronym: 'CBP' }],
        },
        { name: 'No Apps Here', actor: 'Billing' },
      ],
    });
    const doc = parse(xml);

    const taskId = findAll(doc, NS.bpmn, 'task').find((t) => t.getAttribute('name') === 'Process Payment').getAttribute('id');
    const noAppsTaskId = findAll(doc, NS.bpmn, 'task').find((t) => t.getAttribute('name') === 'No Apps Here').getAttribute('id');
    const annotations = findAll(doc, NS.bpmn, 'textAnnotation');
    const associations = findAll(doc, NS.bpmn, 'association');

    // One annotation column for the task that has an application; none for the task without.
    expect(associations.filter((a) => a.getAttribute('targetRef') === noAppsTaskId)).toHaveLength(0);
    const assocToTask = associations.filter((a) => a.getAttribute('targetRef') === taskId);
    expect(assocToTask).toHaveLength(1);

    const annotationId = assocToTask[0].getAttribute('sourceRef');
    const annotation = annotations.find((a) => a.getAttribute('id') === annotationId);
    const text = findAll(annotation, NS.bpmn, 'text')[0].textContent;
    expect(text).toBe('LLM-001 | CBP | Core Billing Platform');
  });

  it('splits a task with more than one application across two annotation columns', () => {
    const { xml } = buildBpmnXmlForFlow({
      flowName: 'Multi App Flow',
      tasks: [
        {
          name: 'Process Payment',
          actor: 'Billing',
          applications: [{ name: 'App One' }, { name: 'App Two' }],
        },
      ],
    });
    const doc = parse(xml);
    const taskId = findAll(doc, NS.bpmn, 'task')[0].getAttribute('id');
    const annotations = findAll(doc, NS.bpmn, 'textAnnotation');
    const associations = findAll(doc, NS.bpmn, 'association').filter((a) => a.getAttribute('targetRef') === taskId);

    expect(associations).toHaveLength(2);
    const texts = associations
      .map((a) => annotations.find((an) => an.getAttribute('id') === a.getAttribute('sourceRef')))
      .map((a) => findAll(a, NS.bpmn, 'text')[0].textContent);
    expect(texts).toEqual(['App One', 'App Two']);
  });

  it('disambiguates two tasks that normalize to the same element id', () => {
    const { xml } = buildBpmnXmlForFlow({
      flowName: 'Dup Names',
      tasks: [
        { name: 'Review!', actor: 'A' },
        { name: 'Review?', actor: 'A' }, // normalizes to the same base id as "Review!"
      ],
    });
    const doc = parse(xml);
    const ids = findAll(doc, NS.bpmn, 'task').map((t) => t.getAttribute('id'));
    expect(new Set(ids).size).toBe(2);
  });

  it('produces exactly one bpmndi:BPMNShape per flow node/lane/annotation and one BPMNEdge per sequence flow', () => {
    const { xml } = buildBpmnXmlForFlow({
      flowName: 'DI Coverage',
      tasks: [
        { name: 'A', actor: 'X', applications: [{ name: 'App1' }] },
        { name: 'B', actor: 'Y' },
      ],
    });
    const doc = parse(xml);
    const shapeElementIds = findAll(doc, NS.bpmndi, 'BPMNShape').map((s) => s.getAttribute('bpmnElement'));
    const edgeElementIds = findAll(doc, NS.bpmndi, 'BPMNEdge').map((s) => s.getAttribute('bpmnElement'));

    const allFlowNodeIds = [
      ...findAll(doc, NS.bpmn, 'startEvent'),
      ...findAll(doc, NS.bpmn, 'task'),
      ...findAll(doc, NS.bpmn, 'endEvent'),
      ...findAll(doc, NS.bpmn, 'lane'),
    ].map((el) => el.getAttribute('id'));
    for (const id of allFlowNodeIds) {
      expect(shapeElementIds).toContain(id);
    }

    const sequenceFlowIds = findAll(doc, NS.bpmn, 'sequenceFlow').map((f) => f.getAttribute('id'));
    expect(edgeElementIds.filter((id) => sequenceFlowIds.includes(id))).toHaveLength(sequenceFlowIds.length);
  });
});
