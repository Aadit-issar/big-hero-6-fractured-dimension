# ATLAS bridge (Dimension side)

A read-only, origin-validated link from the running Dimension to an ATLAS window, plus a compact in-game advisor.

| File | Role |
| --- | --- |
| `src/bridge/atlasLinkProtocol.ts` | protocol v1 types (messages, scene-object scan) |
| `src/bridge/bridgeCore.ts` | pure proximity scan (`scanSceneObjects`) and origin policy (`isAllowedOrigin`) |
| `src/bridge/atlasBridge.ts` | `attachAtlasBridge(engine)`: publishes `observe(engine)` at 4 Hz and a 45-unit proximity scan at 2 Hz; handles handshake, scan requests, validated advisories, destination requests; **L** opens ATLAS |
| `src/bridge/advisoryCore.ts` | pure strict validation of advisories, freshness, bearing maths |
| `src/bridge/advisorStore.ts` | small external store written only by the bridge |
| `src/ui/AtlasAdvisor.tsx`, `atlasAdvisor.css` | HUD pill (always visible with the HUD) and panel (**N**): status, recommendation, bearing arrow and distance, destination picker, limitation |
| `src/app/App.tsx` | one `useEffect(() => attachAtlasBridge(engine))` and `<AtlasAdvisor visible={hudVisible} />` |

* Reads: `observe(engine)` (the frozen sensor), the cached deterministic layout for scanning (never serialised), and `window.__FRACTURED_DIAGNOSTICS__.read()` camera pose for the bearing arrow.
* Writes: nothing in the simulation, rendering or physics. Advisories are display data; they cannot move the explorer.
* Query parameters: `?atlas=<url>` (what **L** opens; default `http://127.0.0.1:5184/?experience=live`), `?atlasOrigin=<origin>` (extra allowed origin), `?advisor=1` (open the panel at start).
* Tests: `tests/atlasBridge.test.ts`, `tests/atlasAdvisory.test.ts`, `e2e/atlas-advisor.spec.ts`.
