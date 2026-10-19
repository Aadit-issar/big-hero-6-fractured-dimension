import type { AtlasObservation } from '../shared/atlasContract';

/** ATLAS live link, protocol version 1.
 *
 * A read-only, origin-validated window-messaging link from the running Dimension (publisher) to an ATLAS window
 * (consumer). The Dimension never receives world data and never accepts commands that change the simulation:
 * ATLAS may only say hello, request a scan, choose the scan mode or say goodbye. */
export const LINK_CHANNEL = 'fractured-atlas-link';
export const LINK_VERSION = 1;

export type ScanMode = 'continuous' | 'manual';
export type SceneCategory = 'microbot' | 'concrete' | 'rubble' | 'steel' | 'scaffold' | 'walkway' | 'pipe' | 'electrical' | 'panel' | 'landmark' | 'baymax';
export type SceneFamily = 'microbot' | 'concrete' | 'industrial' | 'baymax' | 'capsule';
export type Vec3Tuple = readonly [number, number, number];

/** A scene object acquired by the proximity scanner (NOT part of the Phase 1-3 sensor contract). */
export interface SceneObjectObservation {
  /** Stable for a given Dimension seed and layout. */
  readonly id: string;
  readonly category: SceneCategory;
  readonly family: SceneFamily;
  /** Registry asset label, used only as a classification detail of an object that has been acquired. */
  readonly kind: string;
  /** Rendered anchor position (decorative drift of up to a fraction of a metre is not included). */
  readonly position: Vec3Tuple;
  readonly radius: number;
  /** Distance from the observer at scan time. */
  readonly range: number;
}

export interface SceneScan {
  readonly scanId: number;
  /** engine.clock.time at the scan. */
  readonly time: number;
  readonly observerPosition: Vec3Tuple;
  readonly range: number;
  /** Proximity sphere around the observer: no line-of-sight or occlusion is modelled. */
  readonly coverage: 'proximity-sphere';
  readonly trigger: ScanMode | 'request';
  readonly requestId?: string;
  /** Objects within range (nearest first, capped). */
  readonly objects: readonly SceneObjectObservation[];
  /** Number of in-range objects omitted by the per-scan cap. */
  readonly omitted: number;
}

export interface HelloMessage { readonly channel: typeof LINK_CHANNEL; readonly v: 1; readonly type: 'hello'; readonly atlasSession: string }
export interface ScanRequestMessage { readonly channel: typeof LINK_CHANNEL; readonly v: 1; readonly type: 'scan-request'; readonly requestId: string }
export interface SetModeMessage { readonly channel: typeof LINK_CHANNEL; readonly v: 1; readonly type: 'set-scan-mode'; readonly mode: ScanMode }
export interface ByeMessage { readonly channel: typeof LINK_CHANNEL; readonly v: 1; readonly type: 'bye' }
export type AtlasToDimension = HelloMessage | ScanRequestMessage | SetModeMessage | ByeMessage;

export interface WelcomeMessage {
  readonly channel: typeof LINK_CHANNEL; readonly v: 1; readonly type: 'welcome';
  /** New for every page load of the Dimension: a restarted Dimension is a new session. */
  readonly session: string;
  readonly seq: number;
  readonly startedAtWallMs: number;
  readonly simTime: number;
  readonly sensorRange: number;
  readonly scanRange: number;
  readonly scanMode: ScanMode;
  readonly origin: string;
}
export interface FrameMessage {
  readonly channel: typeof LINK_CHANNEL; readonly v: 1; readonly type: 'frame';
  readonly session: string;
  /** Strictly increasing within a session. */
  readonly seq: number;
  readonly wallMs: number;
  readonly observation: AtlasObservation;
  readonly scan?: SceneScan;
  readonly scanMode: ScanMode;
}
export type DimensionToAtlas = WelcomeMessage | FrameMessage;
