'use strict';
const { apiGet } = require('../apiClient');

async function listBusinessFlows({ domain, nameContains } = {}) {
  const all = await apiGet('/api/diagrams/');
  const domainQuery = domain ? String(domain).toLowerCase() : null;
  const nameQuery = nameContains ? String(nameContains).toLowerCase() : null;

  return all
    .filter((d) => !domainQuery || String(d.domain || '').toLowerCase().includes(domainQuery))
    .filter((d) => !nameQuery || String(d.businessFlow || d.name || '').toLowerCase().includes(nameQuery))
    .map((d) => ({
      diagramId: d._id,
      name: d.businessFlow || d.name,
      domain: d.domain || null,
      status: d.status || null,
      taskCount: Array.isArray(d.tasks) ? d.tasks.length : null,
    }));
}

module.exports = { listBusinessFlows };
