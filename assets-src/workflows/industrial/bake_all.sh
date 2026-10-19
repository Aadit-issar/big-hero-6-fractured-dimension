#!/bin/sh
# Bake every industrial candidate (2048 px) one at a time under the shared heavy-job lock.
cd /c/Users/aadit/BigHero6-wk-industrial
export PYTHONDONTWRITEBYTECODE=1
PY=C:/Users/aadit/bh6-bpy-venv/Scripts/python.exe
for pair in "a_beams industrial_ibeam_twisted" "a_beams industrial_ibeam_bolted" "a_beams industrial_column_bent" "a_scaffold industrial_scaffold_section" "a_scaffold industrial_scaffold_pole_bent" "a_walkway industrial_walkway_section" "a_walkway industrial_walkway_torn" "a_pipes industrial_pipe_large_fractured" "a_pipes industrial_pipe_elbow_torn" "a_electrical industrial_cable_bundle" "a_electrical industrial_junction_box_broken" "a_electrical industrial_facility_panel"; do
  set -- $pair
  until mkdir /c/Users/aadit/bh6-heavy.lock 2>/dev/null; do sleep 15; done
  $PY assets-src/workflows/industrial/run.py $1 $2 --px 2048 --samples 16 > /c/Users/aadit/bh6-ind-scratch/bake_$2.log 2>&1
  rmdir /c/Users/aadit/bh6-heavy.lock
done
echo ALLDONE > /c/Users/aadit/bh6-ind-scratch/bake_all.done
