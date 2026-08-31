/**
 * State transition rules by role.
 * Super User can perform all transitions.
 */

const transitions = [
  { role: 'Editor', action: 'submit for approval', from: 'staged', to: 'submitted for approval' },
  { role: 'Editor', action: 'submit for approval', from: 'draft', to: 'submitted for approval' },
  { role: 'Approver', action: 'approve', from: 'submitted for approval', to: 'approved' },
  { role: 'Approver', action: 'reject', from: 'submitted for approval', to: 'draft' },
  { role: 'Editor', action: 'submit for publish', from: 'approved', to: 'submitted for publish' },
  { role: 'Publisher', action: 'publish', from: 'submitted for publish', to: 'published' },
  { role: 'Publisher', action: 'reject', from: 'submitted for publish', to: 'approved' },
];

// 'invalid'/'staged' are set directly by batch-import validation (not via
// the transitions table above); 'deleted' is a legacy state no longer
// reachable through a transition rule but still recognized where it appears.
const VALID_STATES = ['invalid', 'staged', 'draft', 'submitted for approval', 'approved', 'submitted for publish', 'published', 'deleted'];

/**
 * Get allowed transitions for a given role and current state.
 * Super User gets all transitions from that state.
 */
function getAllowedActions(role, currentState) {
  if (role === 'Super') {
    // Super can do any defined transition from the current state
    return transitions.filter(t => t.from === currentState);
  }
  return transitions.filter(t => t.role === role && t.from === currentState);
}

/**
 * Check if a role can perform a specific action on a record in a given state.
 */
function canTransition(role, action, currentState) {
  if (role === 'Super') {
    return transitions.some(t => t.action === action && t.from === currentState);
  }
  return transitions.some(t => t.role === role && t.action === action && t.from === currentState);
}

/**
 * Get the target state for a given action from a given state (role-checked).
 * Returns null if not allowed.
 */
function getTargetState(role, action, currentState) {
  let rule;
  if (role === 'Super') {
    rule = transitions.find(t => t.action === action && t.from === currentState);
  } else {
    rule = transitions.find(t => t.role === role && t.action === action && t.from === currentState);
  }
  return rule ? rule.to : null;
}

/**
 * Check if a role can move a record directly from one state to another,
 * without naming a specific action — used by callers (e.g. the Model
 * Components row editor) that expose a raw "set status to X" control rather
 * than a named action button. Super can perform any defined from→to move;
 * everyone else needs a rule matching their own role.
 */
function canTransitionTo(role, from, to) {
  if (from === to) return true; // no-op edit (saving without changing status)
  if (role === 'Super') {
    return transitions.some(t => t.from === from && t.to === to);
  }
  return transitions.some(t => t.role === role && t.from === from && t.to === to);
}

module.exports = { transitions, VALID_STATES, getAllowedActions, canTransition, getTargetState, canTransitionTo };
