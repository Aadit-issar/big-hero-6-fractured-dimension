import { describe, expect, it } from 'vitest';
import { ADVISORY_STALE_MS, bearingTo, isFresh, parseAdvisory } from '../src/bridge/advisoryCore';
import { LINK_CHANNEL } from '../src/bridge/atlasLinkProtocol';

const base = () => ({
  channel: LINK_CHANNEL, v: 1, type: 'advisory', advisoryVersion: 1, session: 'S1', seq: 5, status: 'route', episode: 1, simTime: 12.5,
  goal: { id: 'ISLAND A', label: 'ISLAND A' }, title: 'Candidate route to ISLAND A', detail: '1 segment, about 36 units.', action: 'follow-route', target: [1, 2, 3],
  waypoints: [[0, 0, 0], [1, 2, 3]], segments: [{ kind: 'approach', caution: false, remembered: false }], limitations: ['No safe path is claimed.'], goals: [{ id: 'ISLAND A', label: 'ISLAND A' }],
});

describe('advisory validation', () => {
  it('accepts a well-formed advisory for this session', () => {
    const a = parseAdvisory(base(), 'S1', 4, LINK_CHANNEL);
    expect(a).not.toBeNull();
    expect(a!.title).toBe('Candidate route to ISLAND A');
    expect(a!.target).toEqual([1, 2, 3]);
  });

  it('rejects another session, replays and out-of-order sequence numbers', () => {
    expect(parseAdvisory({ ...base(), session: 'OTHER' }, 'S1', 0, LINK_CHANNEL)).toBeNull();
    expect(parseAdvisory(base(), 'S1', 5, LINK_CHANNEL)).toBeNull();
    expect(parseAdvisory(base(), 'S1', 9, LINK_CHANNEL)).toBeNull();
  });

  it('rejects wrong channel, version, type and unknown statuses or actions', () => {
    expect(parseAdvisory({ ...base(), channel: 'x' }, 'S1', 0, LINK_CHANNEL)).toBeNull();
    expect(parseAdvisory({ ...base(), advisoryVersion: 2 }, 'S1', 0, LINK_CHANNEL)).toBeNull();
    expect(parseAdvisory({ ...base(), type: 'command' }, 'S1', 0, LINK_CHANNEL)).toBeNull();
    expect(parseAdvisory({ ...base(), status: 'teleport' }, 'S1', 0, LINK_CHANNEL)).toBeNull();
    expect(parseAdvisory({ ...base(), action: 'move-to' }, 'S1', 0, LINK_CHANNEL)).toBeNull();
  });

  it('bounds sizes, rejects control characters and non-finite or absurd coordinates', () => {
    expect(parseAdvisory({ ...base(), title: 'x'.repeat(200) }, 'S1', 0, LINK_CHANNEL)).toBeNull();
    expect(parseAdvisory({ ...base(), detail: 'bad\u0000text' }, 'S1', 0, LINK_CHANNEL)).toBeNull();
    expect(parseAdvisory({ ...base(), waypoints: Array.from({ length: 9 }, () => [0, 0, 0]) }, 'S1', 0, LINK_CHANNEL)).toBeNull();
    expect(parseAdvisory({ ...base(), target: [Number.NaN, 0, 0] }, 'S1', 0, LINK_CHANNEL)).toBeNull();
    expect(parseAdvisory({ ...base(), target: [1e9, 0, 0] }, 'S1', 0, LINK_CHANNEL)).toBeNull();
    expect(parseAdvisory({ ...base(), goals: Array.from({ length: 13 }, (_, i) => ({ id: `g${i}`, label: 'g' })) }, 'S1', 0, LINK_CHANNEL)).toBeNull();
    expect(parseAdvisory({ ...base(), segments: [{ kind: 'run-script', caution: false, remembered: false }] }, 'S1', 0, LINK_CHANNEL)).toBeNull();
    expect(parseAdvisory(null, 'S1', 0, LINK_CHANNEL)).toBeNull();
    expect(parseAdvisory('advisory', 'S1', 0, LINK_CHANNEL)).toBeNull();
  });

  it('drops unknown extra fields: only whitelisted data survives', () => {
    const a = parseAdvisory({ ...base(), evil: 'payload', engine: { reset: true } }, 'S1', 0, LINK_CHANNEL) as unknown as Record<string, unknown>;
    expect(a.evil).toBeUndefined();
    expect(a.engine).toBeUndefined();
  });

  it('treats an advisory as stale after the freshness window', () => {
    expect(isFresh(1000, 1000 + ADVISORY_STALE_MS)).toBe(true);
    expect(isFresh(1000, 1001 + ADVISORY_STALE_MS)).toBe(false);
  });
});

describe('bearing', () => {
  const identity: [number, number, number, number] = [0, 0, 0, 1];
  it('reports a target straight ahead of an unrotated camera (camera looks along -z)', () => {
    const b = bearingTo([0, 0, 0], identity, [0, 0, -10]);
    expect(b.distance).toBeCloseTo(10);
    expect(b.ahead).toBe(true);
    expect(b.words).toBe('straight ahead');
  });
  it('distinguishes right, left, above and behind', () => {
    expect(bearingTo([0, 0, 0], identity, [10, 0, -2]).words).toMatch(/right/);
    expect(bearingTo([0, 0, 0], identity, [-10, 0, -2]).words).toMatch(/left/);
    expect(bearingTo([0, 0, 0], identity, [0, 10, -2]).words).toMatch(/above/);
    const behind = bearingTo([0, 0, 0], identity, [0, 0, 10]);
    expect(behind.ahead).toBe(false);
    expect(behind.words).toMatch(/behind/);
  });
  it('accounts for camera rotation (a 90 degree yaw turns +x into straight ahead)', () => {
    const s = Math.SQRT1_2;
    const yawLeft: [number, number, number, number] = [0, s, 0, s]; // +90 deg about +y: camera looks toward -x
    expect(bearingTo([0, 0, 0], yawLeft, [-10, 0, 0]).words).toBe('straight ahead');
  });
});
