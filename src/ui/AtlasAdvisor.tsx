import { useEffect, useState, useSyncExternalStore } from 'react';
import { bearingTo, isFresh } from '../bridge/advisoryCore';
import type { Advisory, Bearing } from '../bridge/advisoryCore';
import { getAdvisorState, requestGoal, subscribeAdvisor } from '../bridge/advisorStore';
import './atlasAdvisor.css';

const STATUS_LABEL: Record<Advisory['status'], string> = {
  route: 'CANDIDATE ROUTE', 'needs-revalidation': 'NEEDS REVALIDATION', 'no-route': 'NO SUPPORTED ROUTE', explore: 'OBSERVATION PRIORITY', abstain: 'INSUFFICIENT EVIDENCE',
};

/** Compact ATLAS guidance inside the Dimension. It only displays data validated by the bridge; it never moves the explorer. */
export function AtlasAdvisor({ visible }: { readonly visible: boolean }) {
  const state = useSyncExternalStore(subscribeAdvisor, getAdvisorState);
  const [open, setOpen] = useState(() => new URLSearchParams(window.location.search).get('advisor') === '1');
  const [now, setNow] = useState(() => Date.now());
  const [bearing, setBearing] = useState<Bearing | null>(null);
  const advisory = state.advisory;
  const target = advisory?.target ?? null;

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const el = event.target;
      if (event.code !== 'KeyN' || event.repeat || (el instanceof HTMLElement && el.closest('input, select, textarea'))) return;
      setOpen(v => !v);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => {
      setNow(Date.now());
      if (!open || !target) { setBearing(null); return; }
      // Read-only engineering readout of the camera pose (the same one the HUD's camera line uses).
      const read = window.__FRACTURED_DIAGNOSTICS__?.read();
      if (read) setBearing(bearingTo(read.cameraPosition as [number, number, number], read.cameraQuaternion as [number, number, number, number], target));
    }, 500);
    return () => window.clearInterval(timer);
  }, [open, target]);

  if (!visible) return null;
  const fresh = advisory ? isFresh(state.receivedAtMs, now) : false;
  const pill = !state.linked ? 'press L to link' : !advisory ? 'linked · choose a destination' : fresh ? STATUS_LABEL[advisory.status].toLowerCase() : 'advisory stale';

  return (
    <div className="atlas-advisor" data-testid="atlas-advisor" data-linked={state.linked} data-fresh={fresh}>
      <button type="button" className={`atlas-pill ${state.linked ? (fresh || !advisory ? 'is-linked' : 'is-stale') : ''}`} aria-expanded={open} onClick={() => setOpen(v => !v)}>
        <span className="atlas-dot" /> ATLAS <em>{pill}</em> <kbd>N</kbd>
      </button>
      {open && (
        <section className="atlas-panel glass-panel" aria-label="ATLAS advisor">
          {!state.linked && <p className="atlas-detail">ATLAS is not linked to this session. Press <kbd>L</kbd> to open ATLAS linked to this Dimension, then choose a destination there. ATLAS only knows what Baymax has observed.</p>}
          {state.linked && !advisory && <p className="atlas-detail">Linked. Waiting for guidance from ATLAS.</p>}
          {advisory && (
            <>
              <div className="panel-eyebrow">ATLAS ADVISOR <span>·</span> {STATUS_LABEL[advisory.status]}{!fresh && <b className="atlas-stale"> · STALE</b>}</div>
              <h3 className="atlas-title">{advisory.title}</h3>
              <p className="atlas-detail">{advisory.detail}</p>
              {target && bearing && (
                <div className="atlas-bearing" data-testid="atlas-bearing">
                  <svg viewBox="-20 -20 40 40" width="38" height="38" aria-hidden="true"><circle r="17" className="ring" /><g transform={`rotate(${(-bearing.screenAngle * 180) / Math.PI + 90})`}><path d="M0 -12 L7 8 L0 4 L-7 8 Z" className="arrow" /></g></svg>
                  <span><b>{bearing.distance.toFixed(0)} units</b> · {bearing.words}</span>
                </div>
              )}
              {advisory.goals.length > 0 && (
                <label className="atlas-goal">Destination
                  <select aria-label="ATLAS destination" value={advisory.goal?.id ?? ''} onChange={e => e.target.value && requestGoal(e.target.value)}>
                    <option value="" disabled>{advisory.goal ? advisory.goal.label : 'Choose…'}</option>
                    {advisory.goals.map(g => <option key={g.id} value={g.id}>{g.label}</option>)}
                  </select>
                </label>
              )}
              {advisory.limitations[0] && <p className="atlas-limit">{advisory.limitations[0]}</p>}
            </>
          )}
          <p className="atlas-foot">Guidance only: Baymax is never moved by ATLAS. <kbd>N</kbd> hides this.</p>
        </section>
      )}
    </div>
  );
}
