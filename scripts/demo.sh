#!/usr/bin/env bash
# usage: bash scripts/demo.sh clip.mov
# needs the analysis worker, the API and a render worker running
set -euo pipefail
API=${API:-http://localhost:3000}
FILE=${1:?usage: bash scripts/demo.sh <video>}
j() { node -pe "const o=JSON.parse(require('fs').readFileSync(0,'utf8')); $1"; }
say() { printf '\n\033[1;36m== %s\033[0m\n' "$1"; sleep 1.5; }

say "Create a project"
P=$(curl -s -X POST $API/projects -H 'content-type: application/json' -d '{"name":"demo"}' | j 'o.id')
echo "project $P"

say "Upload the video (returns immediately; analysis runs in a worker)"
A=$(curl -s -F "file=@$FILE" $API/projects/$P/assets | j 'o.assetId')
echo "asset $A"

say "Wait for analysis"
until [ "$(curl -s $API/assets/$A | j 'o.status')" = "ready" ]; do sleep 0.5; done
curl -s $API/assets/$A | j '`duration ${o.analysis.duration.toFixed(1)}s, ${o.analysis.silences.length} silences found`'
DUR=$(curl -s $API/assets/$A | j 'o.analysis.duration')

say "Put the clip on the timeline"
curl -s -X POST $API/projects/$P/timeline/ops -H 'content-type: application/json' \
  -d "{\"ops\":[{\"type\":\"add_clip\",\"trackId\":\"V1\",\"assetId\":\"$A\",\"start\":0,\"in\":0,\"out\":$DUR}]}" \
  | j '`timeline version ${o.version}`'

say "Remove the silences (planner -> typed, validated ops -> new timeline version)"
curl -s -X POST $API/projects/$P/edit/remove-silences -H 'content-type: application/json' -d '{}' \
  | j '`removed ${o.removedSeconds}s with ${o.ops.length} ripple_delete ops -> version ${o.timeline.version}`'

say "Export: chunks render in parallel, then get stitched"
E=$(curl -s -X POST $API/projects/$P/exports -H 'content-type: application/json' -d '{"chunkSeconds":2}' | j 'o.exportId')
while true; do
  S=$(curl -s $API/exports/$E)
  echo "$S" | j '`${o.status}   ${o.done_chunks}/${o.total_chunks} chunks   ${o.progress}%`'
  [ "$(echo "$S" | j 'o.status')" = "done" ] && break
  sleep 1
done
echo "$S" | j '`finished in ${o.elapsedSeconds}s`'

curl -s $API/exports/$E/download -o demo-output.mp4
say "Original vs edited duration"
printf 'original: %ss\n' "$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$FILE")"
printf 'edited:   %ss\n' "$(ffprobe -v error -show_entries format=duration -of csv=p=0 demo-output.mp4)"
