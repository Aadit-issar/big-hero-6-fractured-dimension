import { useEffect, useRef, useSyncExternalStore } from 'react';
import { getCameraPose } from '../bridge/poseStore';
import { projectToScreen } from '../bridge/hudProjection';
import { getScanReport, getScanVersion, subscribeScan, tagsPinned } from '../bridge/scanStore';
import type { ScanTag } from '../bridge/scanStore';
import './scanLayer.css';

/** ATLAS's reading of the world, drawn over the Dimension: a sonar-style pulse when a scan is requested, and elegant tags on the objects, islands,
 * folds and fields that scan reported. Tags show for a few seconds after a requested scan, or stay on while pinned (T). Everything shown was
 * already reported to ATLAS by the sensors; positions are projected from the published camera pose, so the tags sit on the rendered world. */
const SLOTS = 9;
const SHOW_MS = 9000, PULSE_MS = 2200;
/** Screen regions held by the fixed HUD (telemetry card, route card, help panel, control dock, advisor): tags stay out of them. */
const blocked = (x: number, y: number, w: number, h: number) =>
  (x < 370 && y > 100 && y < 262) || (x > w - 340 && ((y > 110 && y < 360) || (y > h - 450 && y < h - 85))) || y > h - 95 || y < 76 || (Math.abs(x - w / 2) < 170 && y > h - 190);
const KIND_LABEL: Record<ScanTag['kind'], string> = { island: 'ISLAND', fold: 'FOLD', object: 'OBJECT', field: 'FIELD' };
const fmtD = (d: number) => `${d < 100 ? d.toFixed(0) : Math.round(d / 10) * 10} m`;

export function AtlasScanLayer({ visible }: { readonly visible: boolean }) {
  useSyncExternalStore(subscribeScan, getScanVersion);
  const root = useRef<HTMLDivElement>(null);
  const slots = useRef<(HTMLDivElement | null)[]>([]);
  const pulse = useRef<HTMLDivElement>(null);
  const chip = useRef<HTMLDivElement>(null);
  const lastPulse = useRef(0);

  useEffect(() => {
    let raf = 0;
    const tick = () => {
      raf = requestAnimationFrame(tick);
      const el = root.current; if (!el) return;
      const scan = getScanReport(), pose = getCameraPose();
      const now = Date.now();
      const W = window.innerWidth, H = window.innerHeight;
      if (!scan || !pose) { el.dataset.on = '0'; return; }
      // A requested scan fires the pulse once.
      if (scan.requestedAt > 0 && scan.requestedAt !== lastPulse.current) {
        lastPulse.current = scan.requestedAt;
        const p = pulse.current;
        if (p) { p.dataset.run = '0'; void p.offsetWidth; p.dataset.run = '1'; }
      }
      const recent = scan.requestedAt > 0 && now - scan.requestedAt < SHOW_MS;
      const showTags = tagsPinned() || recent;
      el.dataset.on = '1';
      el.dataset.tags = showTags ? '1' : '0';
      if (pulse.current) pulse.current.dataset.live = scan.requestedAt > 0 && now - scan.requestedAt < PULSE_MS ? '1' : '0';
      if (chip.current) {
        chip.current.dataset.on = recent ? '1' : '0';
        const t = chip.current.firstElementChild as HTMLElement | null, s = chip.current.lastElementChild as HTMLElement | null;
        if (t && !t.dataset.set) { t.dataset.set = '1'; t.textContent = 'ATLAS SCAN'; }
        if (s) { const txt = `${Math.round(scan.range)} m reach · ${scan.count} mapped`; if (s.textContent !== txt) s.textContent = txt; }
      }
      // Rank the tags: priority first, then nearness; place greedily so labels never overlap.
      const placed: { x: number; y: number; w: number }[] = [];
      const cands = scan.tags.map(tag => {
        const sp = projectToScreen(tag.position, pose.viewPosition, pose.quaternion, pose.fovY, W, H, 40);
        return { tag, sp };
      }).filter(c => showTags && visible && c.sp.onScreen && c.sp.distance > 5 && c.sp.distance < 260 && !blocked(c.sp.x, c.sp.y, W, H))
        .sort((a, b) => b.tag.priority - a.tag.priority || a.sp.distance - b.sp.distance);
      let used = 0;
      for (const c of cands) {
        if (used >= SLOTS) break;
        const w = 46 + c.tag.label.length * 7;
        let y = c.sp.y;
        for (const dy of [0, -30, 30, -60, 60]) {
          const yy = c.sp.y + dy;
          if (!placed.some(p => Math.abs(p.y - yy) < 28 && Math.abs(p.x - c.sp.x) < (p.w + w) / 2 + 6)) { y = yy; break; }
          y = NaN;
        }
        if (Number.isNaN(y)) continue;
        placed.push({ x: c.sp.x, y, w });
        const slot = slots.current[used]; used += 1;
        if (!slot) continue;
        slot.style.transform = `translate(${c.sp.x.toFixed(1)}px, ${c.sp.y.toFixed(1)}px)`;
        slot.style.opacity = String(Math.max(0.45, Math.min(1, 1.15 - c.sp.distance / 230)));
        slot.dataset.kind = c.tag.kind;
        slot.dataset.state = c.tag.state ?? '';
                const name = slot.querySelector('b'), tagEl = slot.querySelector('small'), d = slot.querySelector('em');
        if (name && name.textContent !== c.tag.label) name.textContent = c.tag.label;
        if (tagEl) { const t = c.tag.state ? `${KIND_LABEL[c.tag.kind]} · ${c.tag.state}` : KIND_LABEL[c.tag.kind]; if (tagEl.textContent !== t) tagEl.textContent = t; }
        if (d) d.textContent = fmtD(c.sp.distance);
        const off = y - c.sp.y;
        slot.style.setProperty('--off', `${off.toFixed(1)}px`);
        slot.style.setProperty('--len', `${Math.hypot(26, off).toFixed(1)}px`);
        slot.style.setProperty('--ang', `${Math.atan2(off, 26).toFixed(3)}rad`);
      }
      for (let i = used; i < SLOTS; i += 1) { const slot = slots.current[i]; if (slot) slot.style.opacity = '0'; }
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [visible]);

  return (
    <div className="scan-layer" ref={root} data-on="0" data-tags="0" data-testid="scan-layer" aria-hidden="true">
      <div className="scan-pulse" ref={pulse} data-run="0" data-live="0"><i /><i /><i /></div>
      <div className="scan-chip" ref={chip} data-on="0" data-testid="scan-chip"><b /><span /></div>
      {Array.from({ length: SLOTS }, (_, i) => (
        <div key={i} className="scan-tag" ref={el => { slots.current[i] = el; }} data-kind="object" style={{ opacity: 0 }}>
          <span className="scan-tag-stem" /><i className="scan-tag-dot" />
          <span className="scan-tag-body"><b /><small /><em /></span>
        </div>
      ))}
    </div>
  );
}
