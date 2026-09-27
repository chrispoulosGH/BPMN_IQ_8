'use strict';
const { findOverlappingApis: findOverlaps } = require('../../services/apiOverlap');

async function findOverlappingApis({ apiId, limit = 5 }) {
  return findOverlaps(apiId, { limit });
}

module.exports = { findOverlappingApis };
