/**
 * Estimated vendor end of support for server hardware models.
 *
 * The catalog has no end-of-service-life date per model (WARRANTY_EXPIRY is
 * per-unit coverage, usually extended by a support contract), so a model's
 * end of vendor support is ESTIMATED as its generation's release month plus
 * HARDWARE_SUPPORT_YEARS (default 8). Release months are the vendors' public
 * launch dates for each server generation. An administrator can replace any
 * estimate with the vendor's published date (register override).
 */
const SUPPORT_YEARS = Number(process.env.HARDWARE_SUPPORT_YEARS) > 0 ? Number(process.env.HARDWARE_SUPPORT_YEARS) : 8;

const GENERATIONS = [
  { match: /^poweredge r[6-9]40\b/i, generation: 'Dell PowerEdge 14th generation', released: '2017-07' },
  { match: /^poweredge r[6-9]50/i, generation: 'Dell PowerEdge 15th generation', released: '2021-03' },
  { match: /^poweredge r[6-9]60\b/i, generation: 'Dell PowerEdge 16th generation', released: '2023-01' },
  { match: /^proliant dl\d+ gen10 ?(\+|plus)/i, generation: 'HPE ProLiant Gen10 Plus', released: '2021-03' },
  { match: /^proliant dl\d+ gen10$/i, generation: 'HPE ProLiant Gen10', released: '2017-07' },
  { match: /^proliant dl\d+ gen11/i, generation: 'HPE ProLiant Gen11', released: '2023-01' },
  { match: /^thinksystem sr\d+ v2/i, generation: 'Lenovo ThinkSystem V2', released: '2021-04' },
  { match: /^thinksystem sr\d+ v3/i, generation: 'Lenovo ThinkSystem V3', released: '2023-01' },
  { match: /^thinksystem sr\d+$/i, generation: 'Lenovo ThinkSystem (first generation)', released: '2017-07' },
];

/** { date, basis, generation } or null when the model isn't recognised. */
function estimateHardwareEndOfSupport(model) {
  const m = String(model || '').trim();
  const g = GENERATIONS.find((x) => x.match.test(m));
  if (!g) return null;
  const [y, mo] = g.released.split('-').map(Number);
  const date = new Date(Date.UTC(y + SUPPORT_YEARS, mo, 0)); // last day of the release month, SUPPORT_YEARS later
  return { date, generation: g.generation, basis: `Estimated: ${g.generation} released ${g.released} + ${SUPPORT_YEARS} years` };
}

module.exports = { estimateHardwareEndOfSupport, SUPPORT_YEARS };
