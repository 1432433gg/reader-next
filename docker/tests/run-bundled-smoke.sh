#!/usr/bin/env bash
set -euo pipefail
IMAGE=${1:?Usage: run-bundled-smoke.sh IMAGE}
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
EVIDENCE=${BUNDLE_CHECK_OUTPUT:-"$ROOT/bundle-check-logs"}
mkdir -p "$EVIDENCE"
test_id="reader-bundle-${RANDOM}-$$"
network=$test_id
fixture=$test_id-fixture
gateway=$test_id-egress
renderer=$test_id-webview
control=$test_id-control
reader=$test_id-reader
volume=$test_id-data
cleanup() {
  local name
  for name in "$fixture" "$gateway" "$renderer" "$control" "$reader"; do
    docker logs "$name" >"$EVIDENCE/$name.log" 2>&1 || true
  done
  docker inspect "$gateway" "$renderer" "$reader" >"$EVIDENCE/containers.json" 2>/dev/null || true
  docker exec "$gateway" iptables-save >"$EVIDENCE/iptables.txt" 2>/dev/null || true
  docker exec "$gateway" ip6tables-save >"$EVIDENCE/ip6tables.txt" 2>/dev/null || true
  docker rm -fv "$reader" "$renderer" "$control" "$fixture" "$gateway" >/dev/null 2>&1 || true
  docker volume rm "$volume" >/dev/null 2>&1 || true
  docker network rm "$network" >/dev/null 2>&1 || true
}
trap cleanup EXIT
[[ $(docker image inspect -f '{{index .Config.Labels "io.reader-next.bundled-webview"}}' "$IMAGE") == 1 ]]
docker network create "$network" >/dev/null
docker volume create "$volume" >/dev/null
docker run -d --no-healthcheck --name "$fixture" --network "$network" --network-alias fixture \
  -v "$ROOT/docker/tests:/tests:ro" "$IMAGE" node /tests/fixture.cjs >/dev/null
fixture_ip=$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' "$fixture")
docker run -d --health-cmd "test -f /run/egress-ready" --health-interval 2s --name "$gateway" --network "$network" --network-alias remote-webview \
  --user 0:0 --cap-drop ALL --cap-add NET_ADMIN --security-opt no-new-privileges \
  -e EGRESS_DENY_CIDRS=192.0.2.1/32 -e EGRESS_ALLOW_TCP="$fixture_ip:19090" \
  "$IMAGE" egress >/dev/null
ready=false
for ((attempt=0; attempt<50; attempt++)); do
  if docker exec "$gateway" test -f /run/egress-ready; then ready=true; break; fi
  sleep 0.2
done
[[ $ready == true ]]
docker run -d --no-healthcheck --name "$renderer" --network "container:$gateway" \
  --cap-drop ALL --security-opt no-new-privileges "$IMAGE" webview >/dev/null
docker run -d --no-healthcheck --name "$control" --network "$network" --network-alias control-webview \
  --cap-drop ALL --security-opt no-new-privileges "$IMAGE" webview >/dev/null
docker run -d --name "$reader" --network "$network" --network-alias reader \
  -e SERVER_PORT=8080 -e SECURE=false -e CHAPTER_UPDATE_INTERVAL_HOURS=0 \
  -e REMOTE_WEBVIEW_URL=http://remote-webview:8050 \
  -v "$volume:/app/storage" "$IMAGE" >/dev/null
[[ $(docker exec "$reader" id -u) == 10001 ]]
[[ $(docker exec "$renderer" id -u) == 10001 ]]
docker run --rm --network "$network" -v "$ROOT/docker/tests:/tests:ro" \
  "$IMAGE" node /tests/check-bundle.cjs | tee "$EVIDENCE/results.txt"
