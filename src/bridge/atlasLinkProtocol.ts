import type { AtlasObservation } from '../shared/atlasContract';
import { LIVE_CHANNEL, LIVE_VERSION } from '../shared/liveLink';
import type { ClockReport, NavReport, ObservedDisturbance, ObservedIslandForm, PoseReport, QuatTuple, RouteAck } from '../shared/liveLink';

/** ATLAS live link, protocol version 2 (the wire contract itself is src/shared/liveLink.ts).
 *
 * An origin-validated window-messaging link between the running Dimension and an ATLAS window. The Dimension publishes poses, clock,
 * observations and scans, and acknowledges routes. ATLAS may say hello, request a scan, choose the scan mode, send advisories and propose
 * routes; none of these can move Baymax or alter the simulation. */
export const LINK_CHANNEL = LIVE_CHANNEL;
export const LINK_VERSION = LIVE_VERSION;
export type { RouteAck };

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
  /** Human name of an identified object (movers carry one; scattered wreckage does not). */
  readonly label?: string;
  /** Attitude at scan time (x, y, z, w) for objects whose attitude is observable. Never a velocity. */
  readonly orientation?: QuatTuple;
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
  /** Observable dimensional disturbance regions within sensor range. */
  readonly fields?: readonly ObservedDisturbance[];
  /** Shape descriptors of islands within sensor range (extent and generator seed). */
  readonly islandForms?: readonly ObservedIslandForm[];
}

export interface HelloMessage { readonly channel: typeof LINK_CHANNEL; readonly v: typeof LINK_VERSION; readonly type: 'hello'; readonly atlasSession: string }
export interface ScanRequestMessage { readonly channel: typeof LINK_CHANNEL; readonly v: typeof LINK_VERSION; readonly type: 'scan-request'; readonly requestId: string }
export interface SetModeMessage { readonly channel: typeof LINK_CHANNEL; readonly v: typeof LINK_VERSION; readonly type: 'set-scan-mode'; readonly mode: ScanMode }
export interface ByeMessage { readonly channel: typeof LINK_CHANNEL; readonly v: typeof LINK_VERSION; readonly type: 'bye' }
/** The route payload is validated by parseRouteCommand (src/shared/liveLink.ts) and bound to this Dimension session. */
export interface RouteMessage { readonly channel: typeof LINK_CHANNEL; readonly v: typeof LINK_VERSION; readonly type: 'route'; readonly session: string; readonly route: unknown }
export interface RouteCancelMessage { readonly channel: typeof LINK_CHANNEL; readonly v: typeof LINK_VERSION; readonly type: 'route-cancel'; readonly session: string; readonly routeId: string; readonly revision: number }
export interface PingMessage { readonly channel: typeof LINK_CHANNEL; readonly v: typeof LINK_VERSION; readonly type: 'ping' }
export type AtlasToDimension = HelloMessage | ScanRequestMessage | SetModeMessage | ByeMessage | RouteMessage | RouteCancelMessage | PingMessage;

export interface WelcomeMessage {
  readonly channel: typeof LINK_CHANNEL; readonly v: typeof LINK_VERSION; readonly type: 'welcome';
  /** New for every page load of the Dimension: a restarted Dimension is a new session. */
  readonly session: string;
  readonly seq: number;
  readonly startedAtWallMs: number;
  readonly simTime: number;
  readonly sensorRange: number;
  readonly scanRange: number;
  readonly scanMode: ScanMode;
  readonly origin: string;
  readonly seed: number;
  readonly modelVersion: string;
  readonly clock: ClockReport;
  readonly pose: PoseReport | null;
}
export interface FrameMessage {
  readonly channel: typeof LINK_CHANNEL; readonly v: typeof LINK_VERSION; readonly type: 'frame';
  readonly session: string;
  /** Strictly increasing within a session. */
  readonly seq: number;
  readonly wallMs: number;
  readonly observation: AtlasObservation;
  readonly scan?: SceneScan;
  readonly scanMode: ScanMode;
  /** Baymax's own pose and measured motion. */
  readonly pose: PoseReport;
  /** The authoritative simulation clock (the observation's own `time` equals `clock.time`). */
  readonly clock: ClockReport;
  /** Progress of the active ATLAS route, if one is installed. */
  readonly nav?: NavReport;
}
export interface RouteAckMessage extends RouteAck { readonly channel: typeof LINK_CHANNEL; readonly v: typeof LINK_VERSION }
export type DimensionToAtlas = WelcomeMessage | FrameMessage | RouteAckMessage;
