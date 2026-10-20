import type { SimulationEngine } from '../simulation/simulationEngine';
import { observe } from '../sensors/atlasSensor';
import { DEFAULT_SENSOR_RANGE } from '../shared/atlasContract';
import { cachedLayout } from '../scene/assets/DimensionAssets';
import { MOVER_DEFS, moversFor } from '../world/movers';
import { foldLabel, islandLabel, setScanReport } from './scanStore';
import type { ScanTag } from './scanStore';
import { SCENE_SCAN_RANGE, isAllowedOrigin, scanDisturbances, scanSceneObjects } from './bridgeCore';
import { parseAdvisory } from './advisoryCore';
import { setAdvisorState, setGoalRequester } from './advisorStore';
import { LINK_CHANNEL, LINK_VERSION } from './atlasLinkProtocol';
import type { AtlasToDimension, DimensionToAtlas, ScanMode, SceneScan } from './atlasLinkProtocol';
import { getCameraPose } from './poseStore';
import { advanceNav, navManager, notifyNavChanged, setGoalResolver } from './navStore';
import { createGoalResolver } from './truth';
import { SPATIAL_MODEL } from '../simulation/spatialModel';
import type { ClockReport, PoseReport, RouteAck } from '../shared/liveLink';

/** A sensor frame is published at 4 Hz, matching the engine's 0.25 s graph lattice. */
const FRAME_INTERVAL_MS = 250;
/** Continuous scene scans are published every other frame (2 Hz). */
const CONTINUOUS_SCAN_EVERY = 2;

function isMessage(data: unknown): data is AtlasToDimension {
  if (typeof data !== 'object' || data === null) return false;
  const m = data as Record<string, unknown>;
  if (m.channel !== LINK_CHANNEL || m.v !== LINK_VERSION) return false;
  switch (m.type) {
    case 'hello': return typeof m.atlasSession === 'string' && m.atlasSession.length <= 80;
    case 'scan-request': return typeof m.requestId === 'string' && m.requestId.length <= 80;
    case 'set-scan-mode': return m.mode === 'continuous' || m.mode === 'manual';
    case 'bye': case 'ping': return true;
    case 'route': return typeof m.session === 'string' && typeof m.route === 'object' && m.route !== null;
    case 'route-cancel': return typeof m.session === 'string' && typeof m.routeId === 'string' && Number.isInteger(m.revision);
    default: return false;
  }
}

/** Copies what this scan reported into the presentation store: labelled objects, islands, folds and disturbance fields (never anything the scan did not report). */
function publishScanTags(scan: SceneScan, observation: { islands: readonly { id: string; worldPosition: readonly [number, number, number] }[]; connections: readonly { id: string; state: import('../shared/atlasContract').ObservedConnectionState; entryWorldPosition: readonly [number, number, number] }[] }, requested: boolean): void {
  const tags: ScanTag[] = [];
  for (const o of scan.objects) if (o.label) tags.push({ id: o.id, kind: 'object', label: o.label, position: o.position, priority: o.family === 'capsule' ? 5 : 3 });
  for (const i of observation.islands) tags.push({ id: i.id, kind: 'island', label: islandLabel(i.id), position: i.worldPosition, priority: 2 });
  for (const c of observation.connections) tags.push({ id: c.id, kind: 'fold', label: foldLabel(c.id), position: c.entryWorldPosition, priority: c.state === 'open' || c.state === 'unstable' ? 4 : 2, state: c.state });
  for (const f of scan.fields ?? []) tags.push({ id: f.id, kind: 'field', label: f.label, position: f.position, priority: 1 });
  setScanReport({ scanId: scan.scanId, wallMs: Date.now(), observer: scan.observerPosition, range: scan.range, requested, tags, count: scan.objects.length + observation.islands.length + observation.connections.length });
}

interface Peer { readonly source: WindowProxy; readonly origin: string; lastAt: number }
/** A peer that has said nothing for this long is not an active controller (its page may have been reloaded or frozen). */
const PEER_SILENT_MS = 7000;

/** Publishes observations from a running engine to linked ATLAS windows and accepts validated route proposals from them.
 * It never moves Baymax, never mutates the simulation, never serialises the object registry and never forwards unvalidated input. */
export function attachAtlasBridge(engine: SimulationEngine, options: { atlasUrl?: string } = {}): () => void {
  const params = new URLSearchParams(window.location.search);
  const explicit = params.get('atlasOrigin');
  const session = crypto.randomUUID();
  const startedAt = Date.now();
  const peers = new Map<WindowProxy, Peer>();
  let seq = 0;
  let scanId = 0;
  let mode: ScanMode = 'continuous';
  let frameCount = 0;
  let pendingRequest: string | null = null;
  let lastAdvisorySeq = 0;
  let seenReset = engine.resetRevision;
  const activePeers = () => [...peers.values()].filter(p => Date.now() - p.lastAt < PEER_SILENT_MS).length;
  const syncLinked = () => { const n = activePeers(); setAdvisorState({ linked: n > 0, session: n > 0 ? session : null, ...(n > 0 ? {} : { advisory: null }) }); };
  const layout = () => cachedLayout(engine);
  setGoalResolver(createGoalResolver(engine, layout));

  const post = (peer: Peer, message: DimensionToAtlas) => { try { peer.source.postMessage(message, peer.origin); } catch { peers.delete(peer.source); } };

  const clockReport = (): ClockReport => ({ time: engine.clock.time, running: engine.clock.isRunning, timeScale: engine.clock.timeScale, visible: typeof document === 'undefined' ? true : !document.hidden });
  const poseReport = (): PoseReport => {
    const cam = getCameraPose();
    const o = engine.explorer.worldPosition;
    if (!cam) return { position: [o[0], o[1], o[2]], quaternion: [0, 0, 0, 1], forward: [0, 0, -1], velocity: [0, 0, 0] };
    const [x, y, z, w] = cam.quaternion;
    // Forward is the camera's −Z axis rotated by the attitude.
    const forward = [-2 * (x * z + w * y), -2 * (y * z - w * x), -(1 - 2 * (x * x + y * y))] as const;
    return { position: cam.position, quaternion: cam.quaternion, forward, velocity: cam.velocity };
  };

  const welcome = (peer: Peer) => post(peer, {
    channel: LINK_CHANNEL, v: LINK_VERSION, type: 'welcome', session, seq, startedAtWallMs: startedAt, simTime: engine.clock.time,
    sensorRange: DEFAULT_SENSOR_RANGE, scanRange: SCENE_SCAN_RANGE, scanMode: mode, origin: window.location.origin,
    seed: engine.seed, modelVersion: SPATIAL_MODEL.version, clock: clockReport(), pose: poseReport(),
  });

  const sendAck = (peer: Peer, ack: Omit<RouteAck, 'type' | 'session' | 'seq'>) => {
    seq += 1;
    post(peer, { channel: LINK_CHANNEL, v: LINK_VERSION, ...ack, type: 'route-ack', session, seq });
  };

  const publish = () => {
    for (const [source] of peers) if (source.closed) peers.delete(source);
    syncLinked();
    // A reset of the simulation starts a new run of the world: a route issued for the previous run is stale.
    if (engine.resetRevision !== seenReset) { seenReset = engine.resetRevision; navManager().clear(); notifyNavChanged(); }
    if (peers.size === 0) return;
    frameCount += 1;
    const observation = observe(engine);
    const request = pendingRequest;
    pendingRequest = null;
    const due = request !== null || (mode === 'continuous' && frameCount % CONTINUOUS_SCAN_EVERY === 0);
    let scan: SceneScan | undefined;
    if (due) {
      const movers = moversFor(engine);
      const states = movers.states();
      const { objects, omitted } = scanSceneObjects(layout(), observation.observerWorldPosition, SCENE_SCAN_RANGE, undefined, { states, defs: MOVER_DEFS });
      const fields = scanDisturbances(observation.observerWorldPosition, movers.disturbanceStates());
      const inRange = new Set(observation.islands.map(i => i.id));
      const islandForms = engine.world.islands.flatMap((island, index) => (inRange.has(island.id) ? [{ id: island.id, index, radius: island.radius, height: island.height, facetSeed: island.facetSeed, color: island.color }] : []));
      scanId += 1;
      scan = {
        scanId, time: observation.time, observerPosition: observation.observerWorldPosition, range: SCENE_SCAN_RANGE, coverage: 'proximity-sphere',
        trigger: request !== null ? 'request' : mode, ...(request !== null ? { requestId: request } : {}), objects, omitted, ...(fields.length ? { fields } : {}), ...(islandForms.length ? { islandForms } : {}),
      };
    }
    if (scan) publishScanTags(scan, observation, request !== null);
    const pose = poseReport();
    const nav = advanceNav(pose.position, engine.clock.time);
    seq += 1;
    const message: DimensionToAtlas = {
      channel: LINK_CHANNEL, v: LINK_VERSION, type: 'frame', session, seq, wallMs: Date.now(), observation, ...(scan ? { scan } : {}), scanMode: mode,
      pose, clock: clockReport(), ...(nav ? { nav } : {}),
    };
    for (const peer of peers.values()) post(peer, message);
  };

  const onMessage = (event: MessageEvent) => {
    if (!event.source || event.source === window || !isAllowedOrigin(event.origin, explicit)) return;
    // Advisories are data from a handshaken peer, validated field by field and bound to this session. They cannot change the simulation.
    if (typeof event.data === 'object' && event.data !== null && (event.data as { type?: unknown }).type === 'advisory') {
      const known = peers.get(event.source as WindowProxy);
      if (!known || known.origin !== event.origin) return;
      const advisory = parseAdvisory(event.data, session, lastAdvisorySeq, LINK_CHANNEL);
      if (!advisory) return;
      lastAdvisorySeq = advisory.seq;
      setAdvisorState({ advisory, receivedAtMs: Date.now() });
      return;
    }
    if (!isMessage(event.data)) return;
    const source = event.source as WindowProxy;
    const message = event.data;
    if (message.type === 'hello') {
      const peer: Peer = { source, origin: event.origin, lastAt: Date.now() }; peers.set(source, peer); welcome(peer); syncLinked();
      // A different ATLAS page (a reload or a new window) does not inherit the route of the one before it.
      const current = navManager().current();
      if (current && current.route.atlasSession !== message.atlasSession && current.phase === 'active') { navManager().dismiss(); notifyNavChanged(); }
      return;
    }
    const peer = peers.get(source);
    if (!peer || peer.origin !== event.origin) return;
    peer.lastAt = Date.now();
    if (message.type === 'ping') return;
    if (message.type === 'bye') { peers.delete(source); syncLinked(); }
    else if (message.type === 'set-scan-mode') mode = message.mode;
    else if (message.type === 'scan-request') { pendingRequest = message.requestId; publish(); }
    else if (message.type === 'route') {
      const raw = message.route as { routeId?: unknown; revision?: unknown };
      if (message.session !== session) {
        sendAck(peer, { routeId: typeof raw.routeId === 'string' ? raw.routeId.slice(0, 80) : 'unknown', revision: Number.isInteger(raw.revision) ? (raw.revision as number) : -1, status: 'rejected', code: 'wrong-session', detail: 'The route was addressed to a different Dimension session.', simTime: engine.clock.time });
        return;
      }
      const offer = navManager().offer(message.route, engine.clock.time);
      sendAck(peer, offer.ack);
      if (offer.accepted) notifyNavChanged();
    } else if (message.type === 'route-cancel') {
      if (message.session !== session) return;
      const offer = navManager().cancel(message.routeId, message.revision, engine.clock.time);
      sendAck(peer, offer.ack);
      if (offer.accepted) notifyNavChanged();
    }
  };

  const atlasUrl = options.atlasUrl ?? params.get('atlas') ?? 'http://127.0.0.1:5184/?experience=command';
  const onKey = (event: KeyboardEvent) => {
    const target = event.target;
    if (event.code !== 'KeyL' || event.repeat || (target instanceof HTMLElement && target.closest('input, select, textarea'))) return;
    window.open(atlasUrl, 'fractured-atlas');
  };

  setGoalRequester(goalId => {
    seq += 1;
    for (const peer of peers.values()) { try { peer.source.postMessage({ channel: LINK_CHANNEL, v: LINK_VERSION, type: 'select-goal', session, seq, goalId }, peer.origin); } catch { peers.delete(peer.source); } }
  });
  window.addEventListener('message', onMessage);
  window.addEventListener('keydown', onKey);
  const timer = window.setInterval(publish, FRAME_INTERVAL_MS);
  return () => {
    window.clearInterval(timer); window.removeEventListener('message', onMessage); window.removeEventListener('keydown', onKey); peers.clear();
    setGoalRequester(null); setGoalResolver(undefined); navManager().clear(); notifyNavChanged(); setAdvisorState({ linked: false, session: null, advisory: null });
  };
}
