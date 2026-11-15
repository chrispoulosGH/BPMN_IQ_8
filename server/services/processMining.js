/**
 * Process mining over traffic that carries NO business context.
 *
 * A "case" is one user session (session.id): its API calls ordered by time.
 * Each call is mapped to the API catalog (app + method + route), which also
 * tells us the established flow and task each API was built for.
 *
 * Each case is compared with every established flow's API sequence (task
 * order from its diagram) by longest common subsequence, where two steps match
 * when they share an API:
 *   score = LCS / max(case length, flow length)
 *   1.0 and equal length  → conformant: the established flow ran with an empty header
 *   ≥ DEVIATION_THRESHOLD → the established flow with deviations (listed)
 *   below                 → undefined: clustered with similar cases into
 *                           "undefined processes" and rebuilt as BPMN
 */

const DEVIATION_THRESHOLD = 0.6;
const CLUSTER_THRESHOLD = 0.75;

const intersects = (a, b) => {
  for (const x of a) if (b.has(x)) return true;
  return false;
};

/** LCS of two step lists under `match(i, j)`; returns its length and matched index pairs. */
function lcsAlign(n, m, match) {
  const dp = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      dp[i][j] = match(i, j) ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const pairs = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (match(i, j) && dp[i][j] === dp[i + 1][j + 1] + 1) {
      pairs.push([i, j]);
      i += 1;
      j += 1;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) i += 1;
    else j += 1;
  }
  return { length: dp[0][0], pairs };
}

/** Similarity of two step sequences whose steps carry `apiIds` (Set). */
function sequenceSimilarity(a, b) {
  if (!a.length || !b.length) return 0;
  return lcsAlign(a.length, b.length, (i, j) => intersects(a[i].apiIds, b[j].apiIds)).length / Math.max(a.length, b.length);
}

/**
 * Best established flow for a case, with its deviations.
 * @param {Array<{apiIds:Set<string>, label:string}>} caseSteps
 * @param {Array<{name:string, steps:Array<{taskId:string, taskName:string, apiIds:Set<string>}>}>} flows
 * @param {Map<string, Set<number>>} flowsByApi  api id → indexes into `flows`
 */
function classifyCase(caseSteps, flows, flowsByApi) {
  const candidates = new Set();
  for (const step of caseSteps) for (const id of step.apiIds) for (const f of flowsByApi.get(id) || []) candidates.add(f);
  let best = null;
  for (const index of candidates) {
    const flow = flows[index];
    const { length, pairs } = lcsAlign(caseSteps.length, flow.steps.length, (i, j) => intersects(caseSteps[i].apiIds, flow.steps[j].apiIds));
    const score = length / Math.max(caseSteps.length, flow.steps.length);
    if (!best || score > best.score || (score === best.score && flow.steps.length < best.flow.steps.length)) best = { flow, score, pairs };
  }
  if (!best) return { kind: 'undefined', score: 0, flow: null, deviations: [] };

  const conformant = best.score === 1 && caseSteps.length === best.flow.steps.length;
  const matchedCase = new Set(best.pairs.map(([i]) => i));
  const matchedFlow = new Set(best.pairs.map(([, j]) => j));
  const deviations = [];
  best.flow.steps.forEach((step, j) => {
    if (matchedFlow.has(j)) return;
    const elsewhere = caseSteps.some((c, i) => !matchedCase.has(i) && intersects(c.apiIds, step.apiIds));
    deviations.push({ type: elsewhere ? 'out-of-order' : 'missing', task: step.taskName });
  });
  caseSteps.forEach((c, i) => {
    if (matchedCase.has(i)) return;
    const flowIndex = best.flow.steps.findIndex((s) => intersects(c.apiIds, s.apiIds));
    if (flowIndex === -1) deviations.push({ type: 'extra', task: c.label });
    else if (matchedFlow.has(flowIndex)) deviations.push({ type: 'repeated', task: best.flow.steps[flowIndex].taskName });
    // else: the other half of an out-of-order pair, already reported
  });
  return {
    kind: conformant ? 'conformant' : best.score >= DEVIATION_THRESHOLD ? 'deviating' : 'undefined',
    score: best.score,
    flow: best.flow,
    deviations,
  };
}

/**
 * Group undefined cases into processes: identical step signatures first, then
 * signatures similar to a larger group's (≥ CLUSTER_THRESHOLD) join it.
 * @param {Array<{steps: Array<{apiIds:Set<string>, key:string}>}>} cases
 */
function clusterCases(cases) {
  const bySignature = new Map();
  for (const c of cases) {
    const signature = c.steps.map((s) => s.key).join(' > ');
    if (!bySignature.has(signature)) bySignature.set(signature, []);
    bySignature.get(signature).push(c);
  }
  const groups = [...bySignature.values()].sort((a, b) => b.length - a.length);
  const clusters = [];
  for (const group of groups) {
    const home = clusters.find((cl) => sequenceSimilarity(cl.medoid.steps, group[0].steps) >= CLUSTER_THRESHOLD);
    if (home) home.variants.push(group);
    else clusters.push({ medoid: group[0], variants: [group] });
  }
  return clusters.map((cl) => ({ medoid: cl.medoid, variants: cl.variants, cases: cl.variants.flat() }));
}

module.exports = { lcsAlign, sequenceSimilarity, classifyCase, clusterCases, DEVIATION_THRESHOLD, CLUSTER_THRESHOLD };
