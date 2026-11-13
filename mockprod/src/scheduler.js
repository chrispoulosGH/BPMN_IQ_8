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

module.exports = { startScheduler, ratePerSecond };
