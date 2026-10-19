#!/bin/sh
# material + clay hero/front/side for every candidate, plus the contact sheet
cd /c/Users/aadit/BigHero6-wk-industrial
IDS="industrial_steel_girder_premium industrial_ibeam_twisted industrial_ibeam_bolted industrial_column_bent industrial_scaffold_section industrial_scaffold_pole_bent industrial_walkway_section industrial_walkway_torn industrial_pipe_large_fractured industrial_pipe_elbow_torn industrial_cable_bundle industrial_junction_box_broken industrial_facility_panel"
OUT=docs/evidence/parallel-assets/industrial
mkdir -p $OUT
for a in $IDS; do
  node tools/asset-viewer/captureViews.mjs $OUT file:/assets/models/candidates/industrial/$a.glb http://127.0.0.1:4282 hero,front,side material,clay 1000x700 > /dev/null
done
python assets-src/workflows/industrial/qa/contact.py $OUT $OUT/contact-sheet.png $IDS
