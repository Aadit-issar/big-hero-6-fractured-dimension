#!/bin/sh
# usage: shoot.sh <glb path under /assets/models/candidates/industrial> <outdir>  -> hero/front + clay + closeups
cd /c/Users/aadit/BigHero6-wk-industrial
F=$1; O=$2
node tools/asset-viewer/captureViews.mjs $O file:/assets/models/candidates/industrial/$F http://127.0.0.1:4282 hero,front,side material,clay 1000x700
