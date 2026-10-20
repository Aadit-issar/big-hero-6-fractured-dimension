/** First person (the camera is Baymax's eye) or Baymax view (the camera trails Baymax, who is drawn). Rendering only: flight, the explorer
 * and everything ATLAS reports use the flight position in both modes. Toggled with V; Baymax view is the default; `?view=first` starts in first person. */
export type ViewMode = 'first' | 'baymax';
let mode: ViewMode = (() => { try { return new URLSearchParams(window.location.search).get('view') === 'first' ? 'first' : 'baymax'; } catch { return 'baymax'; } })();
const listeners = new Set<() => void>();
export const getViewMode = (): ViewMode => mode;
export const subscribeViewMode = (l: () => void): (() => void) => { listeners.add(l); return () => { listeners.delete(l); }; };
/** Hide Baymax's body (key 1) for clean renders of the Dimension itself. Rendering only: flight, the camera and everything ATLAS reports are unchanged. */
let hidden = false;
export const getBaymaxHidden = (): boolean => hidden;
export const subscribeBaymaxHidden = (l: () => void): (() => void) => { listeners.add(l); return () => { listeners.delete(l); }; };
export function toggleBaymaxHidden(): void { hidden = !hidden; listeners.forEach(l => l()); }
export function toggleViewMode(): void { mode = mode === 'first' ? 'baymax' : 'first'; listeners.forEach(l => l()); }
