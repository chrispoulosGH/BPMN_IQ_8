import { Tag, Select } from 'antd';
import { transitionState, getStatusTransitions, type StatusRefTransition } from './api';

// Re-exported so factory components only need to import from './stateUtils',
// not also reach into './api' directly, for the status_ref fetch.
export { getStatusTransitions };
export type { StatusRefTransition };

// State transition rules — used to live here as a hardcoded STATE_TRANSITIONS
// array (and, independently, drifted into a near-duplicate copy in
// BpmnFactory.tsx). Both now fetch the same status_ref Mongo collection via
// getStatusTransitions() instead, and pass the result in here explicitly.
export function getAllowedActions(transitions: StatusRefTransition[], role: string | null | undefined, currentState: string) {
  const state = (currentState || 'published').toLowerCase();
  if (role === 'Super') {
    return transitions.filter(t => t.from === state);
  }
  return transitions.filter(t => t.role === role && t.from === state);
}

export function stateTagColor(state: string): string {
  switch ((state || 'published').toLowerCase()) {
    case 'published': return 'green';
    case 'approved': return 'blue';
    case 'submitted for approval': return 'orange';
    case 'submitted for publish': return 'cyan';
    case 'staged': return 'purple';
    case 'invalid': return 'red';
    case 'deleted': return 'red';
    default: return 'default';
  }
}

/**
 * Renders a status Tag or Select dropdown for state transitions.
 */
export function renderStateCell(
  transitions: StatusRefTransition[],
  val: string | undefined,
  recordId: string,
  editingId: string | null,
  pendingStateAction: { action: string; to: string } | null,
  userRole: string | null | undefined,
  readOnly: boolean | undefined,
  onTransition: (action: string) => void,
) {
  const currentState = (val || 'published').toLowerCase();
  const actions = getAllowedActions(transitions, userRole, currentState);
  const displayState = (editingId === recordId && pendingStateAction) ? pendingStateAction.to : (val || 'published');
  const tagColor = stateTagColor(displayState);

  if (!actions.length || readOnly || editingId !== recordId) {
    return <Tag color={tagColor}>{displayState}</Tag>;
  }

  return (
    <Select
      size="small"
      value={pendingStateAction ? pendingStateAction.action : '__current__'}
      style={{ width: '100%' }}
      onChange={onTransition}
      options={[
        { label: <Tag color={tagColor}>{val || 'published'}</Tag>, value: '__current__', disabled: true },
        ...actions.map(a => ({ label: `${a.action} → ${a.to}`, value: a.action })),
      ]}
    />
  );
}

/**
 * Execute a state transition API call.
 */
export { transitionState };
