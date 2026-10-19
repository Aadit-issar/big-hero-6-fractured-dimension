import type { SimulationEngine } from '../simulation/simulationEngine';
import { observe } from '../sensors/atlasSensor';
import { DEFAULT_SENSOR_RANGE } from '../shared/atlasContract';
import { cachedLayout } from '../scene/assets/DimensionAssets';
import { SCENE_SCAN_RANGE, isAllowedOrigin, scanSceneObjects } from './bridgeCore';
import { parseAdvisory } from './advisoryCore';
import { setAdvisorState, setGoalRequester } from './advisorStore';
import { LINK_CHANNEL, LINK_VERSION } from './atlasLinkProtocol';
import type { AtlasToDimension, DimensionToAtlas, ScanMode, SceneScan } from './atlasLinkProtocol';

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
    case 'bye': return true;
    default: return false;
  }
}

interface Peer { readonly source: WindowProxy; readonly origin: string }

/** Publishes read-only observations from a running engine to linked ATLAS windows.
 * It never mutates the engine, never serialises the object registry and never forwards unvalidated input. */
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
  const syncLinked = () => setAdvisorState({ linked: peers.size > 0, session: peers.size > 0 ? session : null, ...(peers.size > 0 ? {} : { advisory: null }) });

  const post = (peer: Peer, message: DimensionToAtlas) => { try { peer.source.postMessage(message, peer.origin); } catch { peers.delete(peer.source); } };
  const welcome = (peer: Peer) => post(peer, {
    channel: LINK_CHANNEL, v: LINK_VERSION, type: 'welcome', session, seq, startedAtWallMs: startedAt, simTime: engine.clock.time,
    sensorRange: DEFAULT_SENSOR_RANGE, scanRange: SCENE_SCAN_RANGE, scanMode: mode, origin: window.location.origin,
  });

  const publish = () => {
    let pruned = false;
    for (const [source] of peers) if (source.closed) { peers.delete(source); pruned = true; }
    if (pruned) syncLinked();
    if (peers.size === 0) return;
    frameCount += 1;
    const observation = observe(engine);
    const request = pendingRequest;
    pendingRequest = null;
    const due = request !== null || (mode === 'continuous' && frameCount % CONTINUOUS_SCAN_EVERY === 0);
    let scan: SceneScan | undefined;
    if (due) {
      const { objects, omitted } = scanSceneObjects(cachedLayout(engine), observation.observerWorldPosition, SCENE_SCAN_RANGE);
      scanId += 1;
      scan = {
        scanId, time: observation.time, observerPosition: observation.observerWorldPosition, range: SCENE_SCAN_RANGE, coverage: 'proximity-sphere',
        trigger: request !== null ? 'request' : mode, ...(request !== null ? { requestId: request } : {}), objects, omitted,
      };
    }
    seq += 1;
    const message: DimensionToAtlas = { channel: LINK_CHANNEL, v: LINK_VERSION, type: 'frame', session, seq, wallMs: Date.now(), observation, ...(scan ? { scan } : {}), scanMode: mode };
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
    if (message.type === 'hello') { const peer = { source, origin: event.origin }; peers.set(source, peer); welcome(peer); syncLinked(); return; }
    if (!peers.has(source) || peers.get(source)!.origin !== event.origin) return;
    if (message.type === 'bye') { peers.delete(source); syncLinked(); }
    else if (message.type === 'set-scan-mode') mode = message.mode;
    else if (message.type === 'scan-request') { pendingRequest = message.requestId; publish(); }
  };

  const atlasUrl = options.atlasUrl ?? params.get('atlas') ?? 'http://127.0.0.1:5184/?experience=live';
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
  return () => { window.clearInterval(timer); window.removeEventListener('message', onMessage); window.removeEventListener('keydown', onKey); peers.clear(); setGoalRequester(null); setAdvisorState({ linked: false, session: null, advisory: null }); };
}
