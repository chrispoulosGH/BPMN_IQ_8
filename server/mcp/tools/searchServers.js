'use strict';
const CanonicalData = require('../../models/CanonicalData');
const { getFkApplicationId } = require('../../services/apiOverlap');

const NEIGHBORHOOD = 'System Components';

async function searchServers({ appIdOrAcronym, role, maxAvgUtilPct, limit = 25 } = {}) {
  const servers = await CanonicalData.find(
    { neighborhoodName: NEIGHBORHOOD, componentType: 'Servers' },
    { values: 1, primaryKey: 1 }
  ).lean();

  const appQuery = appIdOrAcronym ? String(appIdOrAcronym).toLowerCase() : null;
  const roleQuery = role ? String(role).toLowerCase() : null;

  const rows = servers
    .map((doc) => {
      const v = doc.values || {};
      const cpu = Number(v['CPU_UTIL_AVG_PCT Qualifier']);
      const mem = Number(v['MEMORY_UTIL_AVG_PCT Qualifier']);
      const appId = getFkApplicationId(v);
      return {
        serverId: v['SERVER_ID Qualifier'],
        serverName: v['SERVER_NAME Component'],
        role: v['SERVER_ROLE Aggregate'],
        applicationId: appId,
        cpuUtilPct: Number.isFinite(cpu) ? cpu : null,
        memoryUtilPct: Number.isFinite(mem) ? mem : null,
        avgUtilPct: Number.isFinite(cpu) && Number.isFinite(mem) ? Math.round((cpu + mem) / 2) : null,
        monthlyCostUsd: Number(v['MONTHLY_COST_USD cost_grp_1']) || null,
        datacenter: v['LOCATION_DATACENTER Qualifier'] || null,
      };
    })
    .filter((r) => !appQuery || r.applicationId.toLowerCase() === appQuery)
    .filter((r) => !roleQuery || String(r.role || '').toLowerCase() === roleQuery)
    .filter((r) => maxAvgUtilPct == null || (r.avgUtilPct != null && r.avgUtilPct <= maxAvgUtilPct))
    .sort((a, b) => (a.avgUtilPct ?? 100) - (b.avgUtilPct ?? 100));

  return { total: rows.length, results: rows.slice(0, limit) };
}

module.exports = { searchServers };
