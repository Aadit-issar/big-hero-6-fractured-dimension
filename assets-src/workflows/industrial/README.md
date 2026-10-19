# Industrial kit (family `industrial_*`)
Kit: `kit.py` (tubes, profile sweeps, plates, bolts, welds, grating, deformation helpers), `finish.py` (bevel, smart UV, Cycles wear bake, GLB + LODs), `bake2.py` (WearMaterial copy), `ipylib.py` + `girder.py` (planned-atlas UV for the premium girder).
Assemblers: `a_beams.py`, `a_scaffold.py`, `a_walkway.py`, `a_pipes.py`, `a_electrical.py`.
Build one: `C:/Users/aadit/bh6-bpy-venv/Scripts/python.exe assets-src/workflows/industrial/run.py a_pipes industrial_pipe_elbow_torn` (hold the heavy lock for bakes); all: `bake_all.sh`; girder: `girder.py --stage full`; QA: `qa/shoot_all.sh`.
Reuse: profile sweep+plates+bolts -> 3 steel pieces; tube+couplers -> 2 scaffolds; frame+grating+warp -> 2 walkways; petal pipe+flange -> 2 pipes.
