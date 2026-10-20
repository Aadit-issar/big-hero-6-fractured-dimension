import { useEffect, useRef, useSyncExternalStore } from 'react';
import { getCameraPose } from '../bridge/poseStore';
import { getAdvisorState, subscribeAdvisor } from '../bridge/advisorStore';
import { advanceNav, dismissNav, getActiveRoute, getGoalResolver, getNavVersion, subscribeNav } from '../bridge/navStore';
import { plannedTargetAt } from '../bridge/navCore';
import { clampToEdge, describeOffsets, guidanceMode, projectToScreen } from '../bridge/hudProjection';
import type { Vec3Tuple } from '../shared/liveLink';
import type { SimulationEngine } from '../simulation/simulationEngine';
import './navHud.css';

const MARGIN = 54;
const GHOST_RADIUS = 2.6;
/** Edge indicators keep clear of the top bar, the telemetry card (left), the control dock (bottom) and the help panel (right). */
const INSETS = { l: 120, t: 120, r: 120, b: 130 };
const MODE_LABEL: Record<string, string> = { intercept: 'INTERCEPT', approach: 'APPROACH', entrance: 'FOLD ENTRANCE', transit: 'TRANSIT', reconnaissance: 'RECON' };
/** Keeps an edge indicator off the other HUD cards: the telemetry card (top left), this route card (top right) and the help panel (bottom right). */
function avoidCards(x: number, y: number, width: number, height: number, card: DOMRect | null): { x: number; y: number } {
  const rects = [{ l: 20, t: 105, r: 360, b: 255 }, { l: width - 330, t: height - 440, r: width, b: height - 95 }];
  if (card) rects.push({ l: card.left - 12, t: card.top - 12, r: card.right + 12, b: card.bottom + 12 });
  for (const q of rects) {
    if (x > q.l && x < q.r && y > q.t && y < q.b) {
      if (x < 120 || x > width - 120) y = y - q.t < q.b - y && q.t > 140 ? q.t - 30 : q.b + 30;
      else x = x - q.l < q.r - x ? q.l - 70 : q.r + 70;
    }
  }
  return { x, y };
}
const dist = (a: Vec3Tuple, b: Vec3Tuple) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const fmtM = (d: number) => `${d.toFixed(d < 100 ? 1 : 0)} m`;
const fmtT = (s: number) => `${s.toFixed(1)} s`;

/** Route guidance inside the Dimension. The 3D route itself (dashed line, waypoint nodes, rendezvous reticle, projected target) is drawn in the
 * scene (src/scene/nav); this layer adds only what needs text: the label of the rendezvous / approach point with its live countdown, an
 * indicator for the real target (a bracket, or an edge arrow when it is off screen), a precision readout close to the active waypoint, one
 * card on the right and, when the route ends, the measured result.
 * The projection uses the published camera pose (position, attitude, field of view), so labels sit exactly on the rendered world.
 * Per-frame values are written straight to the DOM; React re-renders only when the route itself changes. */
export function NavHud({ engine, visible }: { readonly engine: SimulationEngine; readonly visible: boolean }) {
  useSyncExternalStore(subscribeNav, getNavVersion);
  const linked = useSyncExternalStore(subscribeAdvisor, () => getAdvisorState().linked);
  const active = getActiveRoute();
  const refs = useRef<Record<string, HTMLElement | null>>({});
  const set = (name: string) => (el: HTMLElement | null) => { refs.current[name] = el; };
  const route = active?.route ?? null;
  const routeKey = route ? `${route.routeId}:${route.revision}` : '';

  useEffect(() => {
    let raf = 0;
    const place = (el: HTMLElement | undefined | null, x: number, y: number, opacity: number) => { if (!el) return; el.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px) translate(-50%, -50%)`; el.style.opacity = String(opacity); };
    const tick = () => {
      raf = requestAnimationFrame(tick);
      const a = getActiveRoute();
      const r = refs.current;
      const root = r.root;
      if (!root) return;
      const pose = getCameraPose();
      if (!a || !pose || a.phase === 'cancelled') { root.dataset.on = '0'; return; }
      root.dataset.on = '1';
      const simTime = engine.clock.time;
      advanceNav(pose.position, simTime);
      const cur = getActiveRoute() ?? a;
      const width = window.innerWidth, height = window.innerHeight;
      const route = cur.route, wps = route.waypoints;
      const live = cur.phase === 'active';
      const index = Math.min(cur.activeIndex, wps.length - 1);
      const wp = wps[index]!, last = wps[wps.length - 1]!;
      const project = (p: Vec3Tuple, margin = 0) => projectToScreen(p, pose.viewPosition, pose.quaternion, pose.fovY, width, height, margin);
      // Distances are Baymax's own; the screen position is from the rendered camera (which trails Baymax in Baymax view).
      const dBay = dist(wp.position, pose.position);
      const mode = guidanceMode(dBay, wp.arrivalRadius);
      const body = projectToScreen(wp.position, pose.position, pose.quaternion, pose.fovY, width, height, 0);
      root.dataset.mode = live ? mode : cur.phase;
      root.dataset.kind = wp.kind;
      root.dataset.phase = cur.phase;

      // Active waypoint: precision brackets close in, an edge arrow when it is off screen.
      const p = project(wp.position, 36);
      const lastActive = index === wps.length - 1;
      if (live && p.onScreen) { place(r.marker, p.x, p.y, 1); place(r.edge, 0, 0, 0); }
      else if (live) {
        const e = clampToEdge(p, width, height, MARGIN, INSETS);
        const card = r.card?.getBoundingClientRect() ?? null;
        const ep = avoidCards(e.x, e.y, width, height, card);
        place(r.edge, ep.x, ep.y, 1);
        if (r.edgeArrow) r.edgeArrow.style.transform = `rotate(${e.angle}rad)`;
        place(r.marker, 0, 0, 0);
        if (r.edge) r.edge.dataset.behind = p.inFront ? '0' : '1';
      } else { place(r.marker, 0, 0, 0); place(r.edge, 0, 0, 0); }
      if (r.reticle) r.reticle.style.opacity = mode === 'precision' && live && p.onScreen ? '1' : '0';
      if (r.markerLabel) r.markerLabel.textContent = lastActive || mode === 'precision' ? '' : fmtM(dBay);
      if (r.offsets) r.offsets.textContent = mode === 'precision' && live ? describeOffsets(body.right, body.up, body.ahead) : '';
      if (r.edgeLabel) r.edgeLabel.textContent = `${fmtM(dBay)}${p.inFront ? '' : ' · behind'}`;

      // The three on-screen labels (real target, rendezvous, projected target) are placed together at the end of this block so they never overlap.
      const pend: Record<string, { x: number; y: number; o: number }> = {};
      const put = (name: string, x: number, y: number, o: number) => { pend[name] = { x, y, o }; };
      // End of the route: the planned rendezvous / aim point / approach / entrance, labelled just below the reticle drawn in the scene.
      const i = route.interception;
      const e = project(last.position, 0);
      const toGo = i ? Math.max(0, i.simTime - simTime) : 0;
      let title: string;
      if (i) title = `${i.leadLimited ? 'AIM POINT' : 'PLANNED RENDEZVOUS'} · T + ${toGo.toFixed(0)} s`;
      else if (last.kind === 'entrance') {
        const fold = engine.network.getConnections(simTime).find(c => c.id === route.goal.id);
        title = `FOLD ENTRANCE${fold ? ` · ${fold.state.toUpperCase()}` : ''}`;
      } else title = last.kind === 'approach' ? 'APPROACH POINT' : 'WAYPOINT';
      if (r.endTitle) r.endTitle.textContent = title;
      const dEnd = dist(last.position, pose.position);
      if (r.endSub) r.endSub.textContent = lastActive && mode === 'precision' && live ? describeOffsets(body.right, body.up, body.ahead) : fmtM(dEnd);
      put('end', e.x, e.y + 44, live && e.onScreen && e.distance > 4 ? 1 : 0);

      // The real target (moving goals): a bracket and label where it is, or an edge arrow when it is out of view. Never steers the camera.
      const truth = getGoalResolver()?.(route.goal.id, simTime) ?? null;
      const moving = truth !== null && route.goal.motion !== 'static' && live;
      if (moving) {
        const g = project(truth!.position, 0);
        const label = `${route.goal.label} · ${g.distance.toFixed(0)} m`;
        if (g.onScreen) {
          put('goal', g.x, g.y, g.distance < 400 ? 1 : 0);
          if (r.goalLabel) r.goalLabel.textContent = label;
          place(r.goalEdge, 0, 0, 0);
          // Bracket size follows the object's apparent size, within legible limits.
          const f = 1 / Math.tan((pose.fovY * Math.PI / 180) / 2);
          const px = Math.max(30, Math.min(110, truth!.captureRadius * 0.8 * f / Math.max(0.5, g.depth) * height / 2));
          if (r.goalBox) r.goalBox.style.width = r.goalBox.style.height = `${px}px`;
        } else {
          const ge = clampToEdge(g, width, height, MARGIN, INSETS);
          const gp = avoidCards(ge.x, ge.y, width, height, r.card?.getBoundingClientRect() ?? null);
          place(r.goalEdge, gp.x, gp.y, 1);
          if (r.goalEdgeArrow) r.goalEdgeArrow.style.transform = `rotate(${ge.angle}rad)`;
          if (r.goalEdgeLabel) r.goalEdgeLabel.textContent = label;
          put('goal', 0, 0, 0);
        }
        if (r.targetDist) r.targetDist.textContent = fmtM(g.distance);
      } else { put('goal', 0, 0, 0); place(r.goalEdge, 0, 0, 0); }

      // The projected (forecast) target, labelled where the translucent copy is drawn.
      if (i && route.goal.assetId && live) {
        const gp = project(plannedTargetAt(i, i.simTime), 0);
        // Label above the translucent copy, clear of its apparent size (the copy is roughly GHOST_RADIUS metres across).
        const f = 1 / Math.tan((pose.fovY * Math.PI / 180) / 2);
        const apparent = Math.max(14, Math.min(120, GHOST_RADIUS * f / Math.max(0.5, gp.depth) * height / 2));
        put('ghost', gp.x, gp.y - apparent - 18, gp.onScreen && gp.distance > 6 ? 1 : 0);
      } else put('ghost', 0, 0, 0);
      // Declutter in priority order (real target, rendezvous, projected): try nudging vertically, hide a label that still collides.
      const taken: { l: number; t: number; r: number; b: number }[] = [];
      for (const name of ['goal', 'end', 'ghost']) {
        const item = pend[name], el = r[name];
        if (!item || !el) continue;
        if (item.o === 0) { place(el, item.x, item.y, 0); continue; }
        const w = el.offsetWidth + 8, h = el.offsetHeight + 6;
        let chosen: { x: number; y: number } | null = null;
        for (const k of [0, 1, -1, 2, -2]) {
          // The projected label prefers to move up, the rendezvous label down.
          const dy = k * h * (name === 'ghost' ? -1 : 1);
          const y = item.y + dy;
          const box = { l: item.x - w / 2, t: y - h / 2, r: item.x + w / 2, b: y + h / 2 };
          if (!taken.some(q => box.l < q.r && box.r > q.l && box.t < q.b && box.b > q.t)) { chosen = { x: item.x, y }; taken.push(box); break; }
        }
        if (chosen) place(el, chosen.x, chosen.y, 1); else place(el, item.x, item.y, 0);
      }

      // Card readouts.
      if (r.dist) r.dist.textContent = fmtM(dBay);
      if (r.step) r.step.textContent = `${index + 1} / ${wps.length}`;
      if (r.eta) {
        // Remaining route length from where Baymax is now, at the planning speed (a plan's absolute ETA expires as soon as the player flies slower).
        let len = dBay;
        for (let k = index; k < wps.length - 1; k += 1) len += dist(wps[k]!.position, wps[k + 1]!.position);
        r.eta.textContent = live ? `${(len / Math.max(1, route.speed)).toFixed(0)} s` : '—';
      }
      if (r.rendez) r.rendez.textContent = i ? (live ? `${fmtT(toGo)}` : 'ended') : '';
      if (r.updated) r.updated.style.opacity = live && cur.replacedAtSimTime !== null && simTime - cur.replacedAtSimTime < 9 ? '1' : '0';
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [engine, routeKey]);

  if (!visible || !route || !active) return null;
  const moving = route.interception !== null;
  const out = active.outcome;
  const live = active.phase === 'active';
  const gap = (v: number) => `${v.toFixed(1)} m`;
  return (
    <div className="nav-hud" ref={set('root')} data-on="0" data-testid="nav-hud" data-route={route.routeId} data-revision={route.revision} data-phase={active.phase}>
      <div className="nav-marker" ref={set('marker')} data-testid="nav-marker">
        <div className="nav-reticle" ref={set('reticle')}><i /><i /><i /><i /></div>
        <div className="nav-marker-label"><b ref={set('markerLabel')} /><em ref={set('offsets')} /></div>
      </div>
      <div className="nav-edge" ref={set('edge')} data-testid="nav-edge">
        <div className="nav-edge-arrow" ref={set('edgeArrow')} />
        <span ref={set('edgeLabel')} />
      </div>
      <div className="nav-end" ref={set('end')} data-testid="nav-end"><strong ref={set('endTitle')} /><span ref={set('endSub')} /></div>
      <div className="nav-ghost" ref={set('ghost')}><span>PROJECTED</span></div>
      <div className="nav-goal" ref={set('goal')} data-testid="nav-goal"><div className="nav-goal-bracket" ref={set('goalBox')}><i /><i /><i /><i /></div><span ref={set('goalLabel')} /></div>
      <div className="nav-goal-edge" ref={set('goalEdge')} data-testid="nav-goal-edge"><div className="nav-goal-edge-arrow" ref={set('goalEdgeArrow')} /><span ref={set('goalEdgeLabel')} /></div>
      <aside className="nav-card" ref={set('card')} data-testid="nav-card" data-outcome={out ? (out.success ? 'success' : 'miss') : 'none'}>
        <header>
          <span className="nav-mode">{MODE_LABEL[route.mode] ?? route.mode}</span>
          <strong>{route.goal.label}</strong>
          <button type="button" className="nav-clear" onClick={() => dismissNav()} title="Dismiss guidance">✕</button>
        </header>
        {live ? (
          <>
            <div className="nav-readout">
              <div><b ref={set('dist')} data-testid="nav-distance">—</b><small>to next</small></div>
              <div><b ref={set('eta')}>—</b><small>ETA</small></div>
              <div><b ref={set('step')}>—</b><small>leg</small></div>
            </div>
            {moving && <p className="nav-line"><span>Rendezvous planned in</span><b ref={set('rendez')} /></p>}
            {moving && <p className="nav-line"><span>{route.goal.label}</span><b ref={set('targetDist')} /></p>}
            <p className="nav-reason">{route.reason}</p>
            <p className="nav-updated" ref={set('updated')}>Route updated · target motion revised (r{route.revision})</p>
            {!linked && <p className="nav-lost" data-testid="nav-lost">ATLAS link lost. This route is frozen and no longer revised.</p>}
          </>
        ) : out ? (
          <div className="nav-result" data-testid={out.success ? 'nav-arrived' : 'nav-missed'}>
            <b className="nav-result-title">{out.success ? (moving ? 'RENDEZVOUS ACHIEVED' : 'ARRIVED') : 'MISSED'}</b>
            <dl>
              <dt>Closest approach</dt><dd data-testid="nav-closest">{gap(out.closestApproach)} <small>(capture {gap(out.captureRadius)})</small></dd>
              <dt>{out.success ? 'Encounter time' : 'Decided at'}</dt><dd>t {out.simTime.toFixed(1)} s</dd>
              {out.plannedSimTime !== null && <><dt>Planned time</dt><dd>t {out.plannedSimTime.toFixed(1)} s <small>({Math.abs(out.simTime - out.plannedSimTime).toFixed(1)} s {out.simTime >= out.plannedSimTime ? 'late' : 'early'})</small></dd></>}
              {out.plannedError !== null && <><dt>Prediction error</dt><dd data-testid="nav-error">{gap(out.plannedError)}</dd></>}
            </dl>
            <p className="nav-note">Measured in the Dimension from the object's true position.</p>
          </div>
        ) : null}
        <footer>Route r{route.revision} · planned at {route.speed.toFixed(0)} m/s{route.interception ? ` · meeting planned at t ${route.interception.simTime.toFixed(0)} s` : ''}</footer>
      </aside>
    </div>
  );
}
