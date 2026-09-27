'use strict';
const { apiGet } = require('../apiClient');

async function getBusinessFlow({ diagramId }) {
  const diagram = await apiGet(`/api/diagrams/${diagramId}`);
  return {
    diagramId: diagram._id,
    name: diagram.businessFlow || diagram.name,
    domain: diagram.domain || null,
    status: diagram.status || null,
    version: diagram.version || 1,
    tasks: (diagram.tasks || []).map((t) => ({
      taskId: t._id,
      name: t.name,
      actor: t.actor || null,
      source: t.source || null,
      target: t.target || null,
      applications: (t.applications || []).map((a) => a.name),
    })),
  };
}

module.exports = { getBusinessFlow };
