import { JobState } from './protocol.js';

/**
 * Valid state transitions for the Job State Machine.
 *
 * Terminal states (SUCCEEDED, FAILED, TIMED_OUT, CANCELLED) cannot transition further.
 */
const ALLOWED_TRANSITIONS: Record<JobState, Set<JobState>> = {
  PENDING: new Set(['DISPATCHED', 'CANCELLED', 'TIMED_OUT']),
  DISPATCHED: new Set(['RUNNING', 'FAILED', 'TIMED_OUT', 'CANCELLED']),
  RUNNING: new Set(['SUCCEEDED', 'FAILED', 'TIMED_OUT', 'CANCELLED']),
  SUCCEEDED: new Set(),
  FAILED: new Set(),
  TIMED_OUT: new Set(),
  CANCELLED: new Set(),
};

/**
 * Checks if a transition from `fromState` to `toState` is structurally valid.
 */
export function isValidStateTransition(fromState: JobState, toState: JobState): boolean {
  if (fromState === toState) return true; // Idempotent no-op
  return ALLOWED_TRANSITIONS[fromState]?.has(toState) ?? false;
}

/**
 * Determines whether a given state is terminal.
 */
export function isTerminalState(state: JobState): boolean {
  return ['SUCCEEDED', 'FAILED', 'TIMED_OUT', 'CANCELLED'].includes(state);
}
