/**
 * Real-time arrivals on a daily curve. Every second, journeys start as a
 * Poisson process whose rate follows dealership hours in SIM_TIMEZONE:
 * quiet overnight (online browsing only), a late-morning ramp, a lunchtime
 * and an after-work peak, busier Saturdays, quieter Sundays.
 *
 *   DAILY_JOURNEYS   average journeys per weekday (default 300)
 *   SIM_TIMEZONE     IANA zone the curve follows (default America/New_York)
 *   MAX_ACTIVE_JOURNEYS  back-pressure cap (default 150)
 */
const DAILY_JOURNEYS = Number(process.env.DAILY_JOURNEYS || 300);
const TIMEZONE = process.env.SIM_TIMEZONE || 'America/New_York';
const MAX_ACTIVE = Number(process.env.MAX_ACTIVE_JOURNEYS || 150);

// Relative traffic by local hour, 0..23.
const HOURLY = [0.6, 0.4, 0.3, 0.2, 0.2, 0.3, 0.6, 1.2, 2.5, 4.5, 6.0, 6.8, 7.5, 7.2, 6.4, 6.0, 6.3, 7.4, 7.8, 6.6, 4.8, 3.2, 1.8, 1.0];
const HOURLY_SUM = HOURLY.reduce((a, b) => a + b, 0);
const DAY_FACTOR = { Sun: 0.65, Mon: 0.9, Tue: 0.95, Wed: 1, Thu: 1.05, Fri: 1.15, Sat: 1.4 };

const formatter = new Intl.DateTimeFormat('en-US', { timeZone: TIMEZONE, hour: 'numeric', minute: 'numeric', weekday: 'short', hourCycle: 'h23' });

function localClock(date = new Date()) {
  const parts = Object.fromEntries(formatter.formatToParts(date).map((p) => [p.type, p.value]));
  return { hour: Number(parts.hour) % 24, minute: Number(parts.minute), weekday: parts.weekday };
}

/** Expected journeys per second right now (interpolated between hours). */
function ratePerSecond(date = new Date()) {
  const { hour, minute, weekday } = localClock(date);
  const weight = HOURLY[hour] + (HOURLY[(hour + 1) % 24] - HOURLY[hour]) * (minute / 60);
  return (DAILY_JOURNEYS * (weight / HOURLY_SUM) * (DAY_FACTOR[weekday] || 1)) / 3600;
}

function startScheduler({ startJourney, activeJourneys }) {
  let started = 0;
  setInterval(() => {
    if (activeJourneys() >= MAX_ACTIVE) return;
    // Poisson draw for this one-second slice.
    const lambda = ratePerSecond();
    let k = 0;
    let p = Math.exp(-lambda);
    let cumulative = p;
    const u = Math.random();
    while (u > cumulative && k < 20) {
      k += 1;
      p *= lambda / k;
      cumulative += p;
    }
    for (let i = 0; i < k; i += 1) {
      started += 1;
      startJourney().catch((err) => console.error('[scheduler] journey failed', err));
    }
  }, 1000).unref?.();

  setInterval(() => {
    const { hour, weekday } = localClock();
    console.log(`[scheduler] ${weekday} ${String(hour).padStart(2, '0')}h ${TIMEZONE}: ~${(ratePerSecond() * 3600).toFixed(1)} journeys/h, ${activeJourneys()} active, ${started} started`);
  }, 5 * 60 * 1000).unref?.();

  const { hour, weekday } = localClock();
  console.log(`[scheduler] ${DAILY_JOURNEYS}/day in ${TIMEZONE}; now ${weekday} ${hour}h → ~${(ratePerSecond() * 3600).toFixed(1)} journeys/h`);
}

// ── Standalone flows (every flow that isn't part of a customer journey) ──────
//
// Each business domain runs on its own clock; volumes are per flow per average
// day, scaled by STANDALONE_DAILY_SCALE (default 1):
//   dealership  customer-facing: dealership hours, busy Saturdays          ~24/day
//   office      back-office: weekdays 08-18, little at weekends             ~6/day
//   plant       manufacturing / supply chain: three shifts, 24/7            ~30/day
//   always-on   connected vehicle & mobility: 24/7 with an evening peak     ~36/day
// Flow names adjust it: annual/strategic/budget work ~0.5/day; programs,
// audits, launches, campaigns and planning x0.4; recalls x0.5.
const PROFILES = {
  dealership: { daily: 24, hourly: HOURLY, days: DAY_FACTOR },
  office: {
    daily: 6,
    hourly: [0.05, 0.05, 0.05, 0.05, 0.05, 0.1, 0.3, 1.2, 4, 6, 6.5, 6, 4.5, 5.5, 6.2, 6, 5, 3, 1, 0.4, 0.2, 0.1, 0.05, 0.05],
    days: { Sun: 0.05, Mon: 1, Tue: 1.05, Wed: 1.05, Thu: 1, Fri: 0.85, Sat: 0.1 },
  },
  plant: {
    daily: 30,
    hourly: [3.5, 3.5, 3.4, 3.4, 3.3, 2.6, 4, 4.4, 4.5, 4.5, 4.4, 4, 4.3, 4.4, 2.8, 4.2, 4.4, 4.3, 4.2, 4, 3.9, 3.8, 2.6, 3.4],
    days: { Sun: 0.3, Mon: 1, Tue: 1, Wed: 1, Thu: 1, Fri: 0.95, Sat: 0.6 },
  },
  'always-on': {
    daily: 36,
    hourly: [2, 1.5, 1.2, 1, 1, 1.3, 2.2, 3.5, 4, 3.6, 3.4, 3.5, 3.8, 3.6, 3.5, 3.8, 4.4, 5.4, 6.2, 6.6, 6.4, 5.4, 4, 2.8],
    days: { Sun: 1.15, Mon: 0.95, Tue: 0.95, Wed: 0.95, Thu: 1, Fri: 1.05, Sat: 1.2 },
  },
};
const DOMAIN_PROFILE = {
  'Sales & Distribution': 'dealership',
  'Finance & Insurance': 'dealership',
  'Warranty & Protection Services': 'dealership',
  'After-Sales & Service': 'dealership',
  'Marketing & Customer Experience': 'dealership',
  'Corporate Functions': 'office',
  'Dealer Network Operations': 'office',
  'Engineering & Product Development': 'office',
  'Manufacturing & Supply Chain': 'plant',
  'Connected Vehicle & Mobility': 'always-on',
};
const STANDALONE_SCALE = Number(process.env.STANDALONE_DAILY_SCALE ?? 1);
const MAX_ACTIVE_STANDALONE = Number(process.env.MAX_ACTIVE_STANDALONE || 400);

function profileFor(flow) {
  return DOMAIN_PROFILE[String(flow.domain || '').replace(/&amp;/g, '&')] || 'office';
}

function dailyVolume(flow) {
  const profile = PROFILES[profileFor(flow)];
  const name = flow.name.toLowerCase();
  if (/annual|yearly|strategic|budget/.test(name)) return 0.5 * STANDALONE_SCALE;
  let volume = profile.daily;
  if (/program|audit|launch|campaign|planning|development/.test(name)) volume *= 0.4;
  if (/recall/.test(name)) volume *= 0.5;
  return volume * STANDALONE_SCALE;
}

function profileRatePerSecond(profileName, perDay, date = new Date()) {
  const profile = PROFILES[profileName];
  const { hour, minute, weekday } = localClock(date);
  const sum = profile.hourly.reduce((a, b) => a + b, 0);
  const weight = profile.hourly[hour] + (profile.hourly[(hour + 1) % 24] - profile.hourly[hour]) * (minute / 60);
  return (perDay * (weight / sum) * (profile.days[weekday] ?? 1)) / 3600;
}

function poisson(lambda) {
  let k = 0;
  let p = Math.exp(-lambda);
  let cumulative = p;
  const u = Math.random();
  while (u > cumulative && k < 20) {
    k += 1;
    p *= lambda / k;
    cumulative += p;
  }
  return k;
}

/**
 * @param {object} options
 * @param {object[]} options.flows  catalog flows to run standalone
 * @param {(flow: object) => Promise<unknown>} options.startInstance
 * @param {() => number} options.activeInstances
 */
function startFlowScheduler({ flows, startInstance, activeInstances }) {
  if (STANDALONE_SCALE <= 0 || !flows.length) {
    console.log('[scheduler] standalone flows off');
    return;
  }
  const plan = flows.map((flow) => ({ flow, profile: profileFor(flow), perDay: dailyVolume(flow) }));
  let started = 0;
  setInterval(() => {
    if (activeInstances() >= MAX_ACTIVE_STANDALONE) return;
    for (const entry of plan) {
      const n = poisson(profileRatePerSecond(entry.profile, entry.perDay));
      for (let i = 0; i < n; i += 1) {
        started += 1;
        startInstance(entry.flow).catch((err) => console.error('[scheduler] instance failed', err));
      }
    }
  }, 1000).unref?.();

  const byProfile = {};
  for (const entry of plan) byProfile[entry.profile] = (byProfile[entry.profile] || 0) + entry.perDay;
  const total = plan.reduce((n, e) => n + e.perDay, 0);
  console.log(`[scheduler] ${plan.length} standalone flows, ~${Math.round(total)} instances on an average day (${Object.entries(byProfile).map(([k, v]) => `${k} ${Math.round(v)}`).join(', ')})`);
  setInterval(() => console.log(`[scheduler] standalone: ${activeInstances()} active, ${started} started`), 5 * 60 * 1000).unref?.();
}

module.exports = { startScheduler, ratePerSecond, startFlowScheduler, profileFor, dailyVolume };
