import type { SimulationEngine } from '../simulation/simulationEngine';
import { SPATIAL_MODEL } from '../simulation/spatialModel';
import type { DimensionLayout } from '../scene/assets/placement';
import { MOVER_DEFS, moversFor } from '../world/movers';
import type { GoalResolver } from './navCore';

/** Goal truth, inside the Dimension: where a goal id really is right now. Used only to decide arrival and to report distance, never sent to ATLAS.
 * Islands return null (their approach waypoint decides arrival, since the goal is a region around the island, not its centre). */
export function createGoalResolver(engine: SimulationEngine, layout: () => DimensionLayout): GoalResolver {
  return (goalId, simTime) => {
    const mover = MOVER_DEFS.find(m => m.id === goalId);
    if (mover) {
      const state = moversFor(engine).states().find(s => s.id === goalId);
      return state ? { position: state.position, captureRadius: mover.radius + 4 } : null;
    }
    const fold = engine.network.getConnections(simTime).find(c => c.id === goalId);
    if (fold) return { position: fold.entryWorldPosition, captureRadius: SPATIAL_MODEL.approachRadius };
    const obj = /^obj-(\d+)$/.exec(goalId);
    if (obj) {
      const d = layout().debris[Number(obj[1])];
      return d ? { position: d.position, captureRadius: d.radius + 3 } : null;
    }
    return null;
  };
}
