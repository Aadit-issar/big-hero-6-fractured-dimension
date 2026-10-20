import type { ObservedConnectionState } from '../shared/atlasContract';
import type { Vec3Tuple } from '../shared/liveLink';

/** What ATLAS's last scan reported, kept for the Dimension's own presentation layer (the tag overlay and the scan pulse). It is a copy of what was
 * already published to ATLAS, so showing it reveals nothing the sensors did not report. Rendering only. */
export type ScanTagKind = 'island' | 'fold' | 'object' | 'field';
export interface ScanTag { readonly id: string; readonly kind: ScanTagKind; readonly label: string; readonly position: Vec3Tuple; readonly priority: number; readonly state?: ObservedConnectionState }
export interface ScanReport { readonly scanId: number; readonly wallMs: number; readonly observer: Vec3Tuple; readonly range: number; readonly requested: boolean; /** Wall time of the latest scan ATLAS asked for (continuous scans keep refreshing the tags without restarting the pulse). */ readonly requestedAt: number; readonly tags: readonly ScanTag[]; readonly count: number }

let current: ScanReport | null = null;
let pinned = false;
let version = 0;
const listeners = new Set<() => void>();
const bump = () => { version += 1; listeners.forEach(l => l()); };

export const getScanReport = (): ScanReport | null => current;
export const subscribeScan = (l: () => void): (() => void) => { listeners.add(l); return () => { listeners.delete(l); }; };
export const getScanVersion = (): number => version;
export function setScanReport(report: Omit<ScanReport, 'requestedAt'> | null): void {
  current = report ? { ...report, requestedAt: report.requested ? report.wallMs : current?.requestedAt ?? 0 } : null;
  bump();
}
export const tagsPinned = (): boolean => pinned;
export function toggleScanTags(): void { pinned = !pinned; bump(); }

const titleCase = (s: string) => s.replace(/[-_]+/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
/** "island-01" becomes "Island 01"; connection ids already read "F01". */
export const islandLabel = (id: string) => titleCase(id);
export const foldLabel = (id: string) => `Fold ${id}`;
