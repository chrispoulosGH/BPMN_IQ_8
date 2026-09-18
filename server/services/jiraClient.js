// Jira Cloud REST client for the "Process Change Radar" feature — pulls
// not-yet-Done issues that name one of three custom fields (Business Process
// Flow/Application/API, created in Jira for this purpose) and normalizes
// them into a shape server/routes/processChangeRadar.js can match against
// Diagram documents. The Business Process Flow field names a diagram
// directly (matched against Diagram.businessFlow/name); Application/API name
// applications on a diagram's tasks (matched against Diagram.tasks[].applications).
//
// Config (server/.env — see the JIRA_* block there):
//   JIRA_BASE_URL              e.g. https://yourcompany.atlassian.net
//   JIRA_EMAIL                 the account the API token belongs to
//   JIRA_API_TOKEN             created at id.atlassian.com/manage-profile/security/api-tokens
//   JIRA_PROJECT_KEYS          optional comma-separated project keys to scope the search to
//   JIRA_BOARD_ID              optional agile board id — when set, "currently or planned to be
//                              impacted" narrows to that board's ACTIVE sprint(s) ("currently")
//                              plus FUTURE sprint(s) ("planned"), instead of just not-Done status;
//                              a board with no active/future sprints means nothing qualifies.
//   JIRA_BUSINESS_FLOW_FIELD_NAME default "Business Process Flow"
//   JIRA_APPLICATION_FIELD_NAME default "Application"
//   JIRA_API_FIELD_NAME        default "API"
//   JIRA_DUE_DATE_FIELD_NAME   optional — leave unset to use Jira's standard Due Date field
//   JIRA_STORY_POINTS_FIELD_NAME optional comma-separated field-name candidates to try, in order
//   JIRA_STORY_POINTS_TO_DAYS  conversion ratio, e.g. "1" = 1 story point = 1 dev day

const JIRA_BASE_URL = String(process.env.JIRA_BASE_URL || '').trim().replace(/\/+$/, '');
const JIRA_EMAIL = String(process.env.JIRA_EMAIL || '').trim();
const JIRA_API_TOKEN = String(process.env.JIRA_API_TOKEN || '').trim();
const JIRA_PROJECT_KEYS = String(process.env.JIRA_PROJECT_KEYS || '')
  .split(',').map((s) => s.trim()).filter(Boolean);
const JIRA_BOARD_ID = String(process.env.JIRA_BOARD_ID || '').trim();
const JIRA_BUSINESS_FLOW_FIELD_NAME = String(process.env.JIRA_BUSINESS_FLOW_FIELD_NAME || 'Business Process Flow').trim();
const JIRA_APPLICATION_FIELD_NAME = String(process.env.JIRA_APPLICATION_FIELD_NAME || 'Application').trim();
const JIRA_API_FIELD_NAME = String(process.env.JIRA_API_FIELD_NAME || 'API').trim();
const JIRA_DUE_DATE_FIELD_NAME = String(process.env.JIRA_DUE_DATE_FIELD_NAME || '').trim();
const JIRA_STORY_POINTS_FIELD_NAMES = String(process.env.JIRA_STORY_POINTS_FIELD_NAME || 'Story Points,Story point estimate')
  .split(',').map((s) => s.trim()).filter(Boolean);
const STORY_POINTS_TO_DAYS = Number(process.env.JIRA_STORY_POINTS_TO_DAYS);
const STORY_POINT_DAY_RATIO = Number.isFinite(STORY_POINTS_TO_DAYS) && STORY_POINTS_TO_DAYS > 0 ? STORY_POINTS_TO_DAYS : 1;

function isJiraConfigured() {
  return Boolean(JIRA_BASE_URL && JIRA_EMAIL && JIRA_API_TOKEN);
}

function authHeader() {
  return `Basic ${Buffer.from(`${JIRA_EMAIL}:${JIRA_API_TOKEN}`).toString('base64')}`;
}

async function jiraFetch(path, options = {}) {
  const res = await fetch(`${JIRA_BASE_URL}${path}`, {
    ...options,
    headers: {
      Authorization: authHeader(),
      Accept: 'application/json',
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Jira API ${res.status} ${res.statusText} (${path}): ${body.slice(0, 500) || 'no body'}`);
  }
  return res.json();
}

// Field ids (e.g. "customfield_10045") are per-site, so fields are resolved
// by display name at runtime instead of being hardcoded — cached for this
// process's lifetime since field definitions essentially never change while
// the server is running.
let fieldNameCache = null;
async function loadJiraFieldsByName() {
  if (fieldNameCache) return fieldNameCache;
  const fields = await jiraFetch('/rest/api/3/field');
  fieldNameCache = new Map();
  for (const field of fields || []) {
    if (field?.name && field?.id) fieldNameCache.set(String(field.name).trim().toLowerCase(), field.id);
  }
  return fieldNameCache;
}

function resolveFieldId(byName, candidateNames) {
  for (const name of candidateNames) {
    const id = byName.get(String(name).trim().toLowerCase());
    if (id) return id;
  }
  return null;
}

// A custom field's value can come back from Jira in several shapes depending
// on how it was configured (plain text, single-select, multi-select, labels)
// — normalize any of them into a flat list of trimmed strings.
function extractFieldValues(raw) {
  if (raw === null || raw === undefined) return [];
  if (Array.isArray(raw)) return raw.flatMap(extractFieldValues);
  if (typeof raw === 'string') {
    return raw.split(/[\r\n,;]+/).map((s) => s.trim()).filter(Boolean);
  }
  if (typeof raw === 'object') {
    if (typeof raw.value === 'string') return [raw.value.trim()].filter(Boolean);
    if (typeof raw.name === 'string') return [raw.name.trim()].filter(Boolean);
    if (typeof raw.displayName === 'string') return [raw.displayName.trim()].filter(Boolean);
  }
  return [];
}

function extractStoryPoints(raw) {
  if (typeof raw === 'number') return raw;
  const parsed = parseFloat(raw);
  return Number.isFinite(parsed) ? parsed : 0;
}

// cf[NNNNN] is JQL's id-based field reference — more robust than quoting the
// field's display name (which can collide with reserved words or, in rare
// cases, not be unique on a site).
function toJqlFieldRef(fieldId) {
  const numericId = String(fieldId).replace(/^customfield_/, '');
  return `cf[${numericId}]`;
}

// Active sprint(s) = "currently" impacted; future sprint(s) = "planned" to
// be — closed sprints are excluded either way. Paginates the Agile API's
// own startAt/maxResults/isLast scheme (separate from the search API's).
async function getRelevantSprintIds(boardId) {
  const ids = [];
  let startAt = 0;
  const maxResults = 50;
  for (let page = 0; page < 10; page += 1) { // safety cap — up to 500 sprints
    const data = await jiraFetch(`/rest/agile/1.0/board/${boardId}/sprint?state=active,future&startAt=${startAt}&maxResults=${maxResults}`);
    const batch = data.values || [];
    for (const sprint of batch) {
      if (sprint?.id != null) ids.push(sprint.id);
    }
    startAt += batch.length;
    if (data.isLast !== false || !batch.length) break;
  }
  return ids;
}

// /rest/api/3/search was retired (Jira now returns 410 Gone) in favor of
// /rest/api/3/search/jql, which pages via an opaque nextPageToken instead of
// startAt/total — see https://developer.atlassian.com/changelog/#CHANGE-2046.
async function searchAllIssues(jql, fieldIds) {
  const issues = [];
  const maxResults = 100;
  const maxPages = 20; // safety cap — up to 2000 issues
  let nextPageToken;
  for (let page = 0; page < maxPages; page += 1) {
    const data = await jiraFetch('/rest/api/3/search/jql', {
      method: 'POST',
      body: JSON.stringify({
        jql,
        maxResults,
        fields: fieldIds,
        ...(nextPageToken ? { nextPageToken } : {}),
      }),
    });
    const batch = data.issues || [];
    issues.push(...batch);
    if (data.isLast !== false || !batch.length || !data.nextPageToken) break;
    nextPageToken = data.nextPageToken;
  }
  return issues;
}

/**
 * Fetches every not-Done/Closed Jira issue that names at least one of the
 * Business Process Flow/Application/API custom fields, normalized for the
 * Process Change Radar route to match against Diagram documents. Throws with
 * `.code` set to 'JIRA_NOT_CONFIGURED' or 'JIRA_FIELDS_NOT_FOUND' for the
 * two config problems the route needs to report distinctly.
 */
async function getProcessChangeIssues() {
  if (!isJiraConfigured()) {
    const err = new Error('Jira is not configured. Set JIRA_BASE_URL, JIRA_EMAIL, and JIRA_API_TOKEN in server/.env, then restart the server.');
    err.code = 'JIRA_NOT_CONFIGURED';
    throw err;
  }

  const byName = await loadJiraFieldsByName();
  const businessFlowFieldId = resolveFieldId(byName, [JIRA_BUSINESS_FLOW_FIELD_NAME]);
  const applicationFieldId = resolveFieldId(byName, [JIRA_APPLICATION_FIELD_NAME]);
  const apiFieldId = resolveFieldId(byName, [JIRA_API_FIELD_NAME]);
  const storyPointsFieldId = resolveFieldId(byName, JIRA_STORY_POINTS_FIELD_NAMES);
  const dueDateFieldId = JIRA_DUE_DATE_FIELD_NAME ? resolveFieldId(byName, [JIRA_DUE_DATE_FIELD_NAME]) : 'duedate';

  const linkFieldIds = [businessFlowFieldId, applicationFieldId, apiFieldId].filter(Boolean);
  if (!linkFieldIds.length) {
    const err = new Error(
      `None of the configured Jira fields were found on this site (looked for "${JIRA_BUSINESS_FLOW_FIELD_NAME}", "${JIRA_APPLICATION_FIELD_NAME}", "${JIRA_API_FIELD_NAME}"). `
      + 'Check JIRA_BUSINESS_FLOW_FIELD_NAME / JIRA_APPLICATION_FIELD_NAME / JIRA_API_FIELD_NAME in server/.env match the exact field names in Jira.'
    );
    err.code = 'JIRA_FIELDS_NOT_FOUND';
    throw err;
  }

  const jqlParts = ['statusCategory != Done'];
  if (JIRA_PROJECT_KEYS.length) {
    jqlParts.push(`project in (${JIRA_PROJECT_KEYS.map((key) => `"${key}"`).join(',')})`);
  }

  // A configured board narrows "currently or planned to be impacted" from
  // "any open ticket" down to "actually scheduled": active sprint(s) =
  // currently, future sprint(s) = planned. Backlog items with no sprint yet
  // don't count as either.
  if (JIRA_BOARD_ID) {
    let sprintIds = [];
    let sprintFetchFailed = false;
    try {
      sprintIds = await getRelevantSprintIds(JIRA_BOARD_ID);
    } catch (err) {
      sprintFetchFailed = true;
      console.warn(`[jiraClient] Failed to load sprints for board ${JIRA_BOARD_ID} — falling back to status-only filtering:`, err.message);
    }
    if (sprintFetchFailed) {
      // Couldn't tell — don't pretend nothing's planned, just skip the
      // sprint filter for this call and rely on statusCategory alone.
    } else if (!sprintIds.length) {
      // Successfully confirmed: no active/future sprint on this board, so
      // nothing is currently-or-planned. Distinct from a fetch failure above.
      return [];
    } else {
      jqlParts.push(`sprint in (${sprintIds.join(',')})`);
    }
  }

  jqlParts.push(`(${linkFieldIds.map((id) => `${toJqlFieldRef(id)} is not EMPTY`).join(' OR ')})`);
  const jql = jqlParts.join(' AND ');

  const fieldIds = [...new Set([
    'summary', 'status', 'issuetype', 'priority', 'assignee', 'updated',
    dueDateFieldId, ...linkFieldIds, ...(storyPointsFieldId ? [storyPointsFieldId] : []),
  ])];

  const rawIssues = await searchAllIssues(jql, fieldIds);
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  return rawIssues.map((issue) => {
    const fields = issue.fields || {};
    const dueDateRaw = dueDateFieldId ? fields[dueDateFieldId] : null;
    const dueDate = dueDateRaw ? String(dueDateRaw).slice(0, 10) : null;
    const isOverdue = Boolean(dueDate) && new Date(dueDate) < today;
    const storyPoints = storyPointsFieldId ? extractStoryPoints(fields[storyPointsFieldId]) : 0;

    return {
      key: issue.key,
      url: `${JIRA_BASE_URL}/browse/${issue.key}`,
      summary: fields.summary || '',
      status: fields.status?.name || 'Unknown',
      statusCategory: fields.status?.statusCategory?.name || 'Unknown',
      issueType: fields.issuetype?.name || null,
      priority: fields.priority?.name || null,
      assignee: fields.assignee?.displayName || null,
      updated: fields.updated || null,
      dueDate,
      isOverdue,
      storyPoints,
      devDays: Math.round(storyPoints * STORY_POINT_DAY_RATIO * 100) / 100,
      businessFlowNames: businessFlowFieldId ? extractFieldValues(fields[businessFlowFieldId]) : [],
      applicationNames: applicationFieldId ? extractFieldValues(fields[applicationFieldId]) : [],
      apiNames: apiFieldId ? extractFieldValues(fields[apiFieldId]) : [],
    };
  });
}

module.exports = { isJiraConfigured, getProcessChangeIssues };
