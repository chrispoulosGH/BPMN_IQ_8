/**
 * Batches what the user views and does in the client and sends it to
 * POST /api/activity (server/services/activityLog.js), for the admin User
 * Activity page. Data changes are recorded by the server itself, so only
 * views and UI-only actions are tracked here.
 *
 * Events are sent every few seconds, when 20 are queued, before sign-out,
 * and with a beacon when the page is hidden or closed.
 */
import { postActivity, type ActivityEventInput } from '../api';

const FLUSH_DELAY_MS = 4000;
const MAX_QUEUE = 20;
let queue: ActivityEventInput[] = [];
let timer: ReturnType<typeof setTimeout> | null = null;
let lastView = '';

export function trackActivity(kind: ActivityEventInput['kind'], action: string, extra: Pick<ActivityEventInput, 'detail' | 'target'> = {}) {
  if (!action) return;
  // A view of the same page twice in a row (re-render, re-select) is one view.
  if (kind === 'view') {
    const key = `${action}|${extra.detail || ''}|${extra.target?.id || ''}`;
    if (key === lastView) return;
    lastView = key;
  }
  queue.push({ kind, action, ...extra, at: Date.now() });
  if (queue.length >= MAX_QUEUE) void flushActivity();
  else if (!timer) timer = setTimeout(() => { void flushActivity(); }, FLUSH_DELAY_MS);
}

export async function flushActivity() {
  if (timer) { clearTimeout(timer); timer = null; }
  if (!queue.length) return;
  const events = queue;
  queue = [];
  try {
    await postActivity(events);
  } catch {
    // Activity is best effort; never disturb the user over it.
  }
}

/** Page hidden or closing: send what's queued without waiting (the session cookie goes with it). */
function flushWithBeacon() {
  if (!queue.length || typeof navigator === 'undefined' || !navigator.sendBeacon) return;
  const body = new Blob([JSON.stringify({ sentAt: Date.now(), events: queue })], { type: 'application/json' });
  if (navigator.sendBeacon('/api/activity', body)) {
    queue = [];
    if (timer) { clearTimeout(timer); timer = null; }
  }
}

if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', flushWithBeacon);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flushWithBeacon(); });
}

/** Forget the last view (after sign-out, so the next user's first view is recorded). */
export function resetActivityTracker() {
  lastView = '';
  queue = [];
  if (timer) { clearTimeout(timer); timer = null; }
}
