import type { Advisory } from './advisoryCore';

/** Small external store the advisor HUD reads. Written only by the bridge; read-only for the UI. */
export interface AdvisorState {
  /** At least one origin-validated ATLAS window has completed the handshake. */
  readonly linked: boolean;
  readonly session: string | null;
  readonly advisory: Advisory | null;
  readonly receivedAtMs: number;
}

let state: AdvisorState = { linked: false, session: null, advisory: null, receivedAtMs: 0 };
const listeners = new Set<() => void>();
let requester: ((goalId: string) => void) | null = null;

export const getAdvisorState = (): AdvisorState => state;
export const subscribeAdvisor = (listener: () => void): (() => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
export function setAdvisorState(patch: Partial<AdvisorState>): void {
  const next = { ...state, ...patch };
  if (next.linked === state.linked && next.session === state.session && next.advisory === state.advisory && next.receivedAtMs === state.receivedAtMs) return;
  state = next;
  listeners.forEach(l => l());
}
/** Asks the linked ATLAS to guide toward one of the goals it listed. ATLAS accepts only goals it has recorded. */
export function requestGoal(goalId: string): void { requester?.(goalId); }
export function setGoalRequester(fn: ((goalId: string) => void) | null): void { requester = fn; }
