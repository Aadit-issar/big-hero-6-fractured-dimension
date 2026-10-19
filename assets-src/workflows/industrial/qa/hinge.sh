#!/bin/sh
# usage: hinge.sh <glb> <mode> <outdir>
cd /c/Users/aadit/BigHero6-wk-industrial
node assets-src/workflows/industrial/qa/closeups.mjs $3 file:/assets/models/candidates/industrial/$1 $2 hingeA=0.25,0.45,1,0.30,0.15,-0.22,0 hingeB=-0.2,0.5,-1,0.30,0.15,-0.22,0 endrim=0.4,0.5,1,0.30,0.55,0.15,0 plate=-1,0.3,0.4,0.25,-0.8,-0.25,0
