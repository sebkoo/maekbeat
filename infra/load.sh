#!/usr/bin/env bash
# The load rig: k6 in a container, against the compose stack.
#
#   infra/load.sh                 # the whole matrix, about six minutes
#   RUN_MS=5000 infra/load.sh     # a faster, noisier pass
#
# Every number this prints describes THIS machine under THIS runtime. None is a
# capacity claim, none extrapolates, and none gates CI — the reason is
# docs/DECISIONS.md #24, and the short form is that a shared runner's numbers
# are not comparable run to run, so a CI load gate is a flake generator in a
# performance costume. What does gate CI is the deterministic half:
# apps/server/src/load.test.ts and apps/server/src/fanout-bound.test.ts.
#
# The questions this can answer honestly are all differential — the same
# profile with one thing changed, on one machine, minutes apart:
#
#   1. What does turning OTLP export on cost in throughput and latency?
#      (C18 proved tracing does not change alert output. This is its price.)
#   2. What does one stalled subscriber cost the healthy ones?
#   3. Does the alert path's cost track device count or frame rate?
set -uo pipefail

cd "$(dirname "$0")/.."

export BUILD_REVISION=${BUILD_REVISION:-$(git rev-parse HEAD)}
COMPOSE=(docker compose -f infra/compose.yaml)
RESULTS=$(mktemp -d)
RUN_MS=${RUN_MS:-20000}

section() { printf '\n== %s\n' "$1"; }
note() { printf '   %s\n' "$1"; }

teardown() {
  [ -n "${STALLED_CID:-}" ] && "${COMPOSE[@]}" rm -sf stalled >/dev/null 2>&1
  "${COMPOSE[@]}" --profile load down --remove-orphans >/dev/null 2>&1
  rm -rf "$RESULTS"
  return 0
}
trap teardown EXIT

# Brings the stack up with tracing either off or pointed at the sink collector.
# `unset` rather than empty: the environment contract rejects an empty endpoint
# with a startup error instead of reading it as "off" (apps/server/src/config.ts),
# which is why compose.yaml passes this one through as a bare list entry.
bring_up() {
  local tracing=$1
  "${COMPOSE[@]}" --profile load down --remove-orphans >/dev/null 2>&1
  if [ "$tracing" = "on" ]; then
    export OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=http://collector:4318/v1/traces
    "${COMPOSE[@]}" --profile load up -d --wait collector >/dev/null 2>&1
  else
    unset OTEL_EXPORTER_OTLP_TRACES_ENDPOINT
  fi
  "${COMPOSE[@]}" up -d --wait server >/dev/null 2>&1 || {
    note "the server did not come up healthy"
    exit 1
  }
}

# Runs one k6 script while sampling the server's RSS, then prints the metrics
# that matter for that profile. $1 label, $2 script, rest are VAR=VALUE.
run_k6() {
  local label=$1 script=$2
  shift 2
  local out="$RESULTS/$label.txt"
  local cid
  cid=$("${COMPOSE[@]}" ps -q server 2>/dev/null)

  env "$@" "${COMPOSE[@]}" --profile load run --rm k6 \
    run --quiet "/scripts/$script" >"$out" 2>&1 &
  local k6_pid=$!

  # Sampled while the run is in flight, which is the only time "steady state"
  # means anything; reading it after k6 exits reads an idle server.
  : >"$RESULTS/$label.rss"
  while kill -0 "$k6_pid" 2>/dev/null; do
    docker stats --no-stream --format '{{.MemUsage}}' "$cid" 2>/dev/null |
      awk '{print $1}' >>"$RESULTS/$label.rss"
    sleep 2
  done
  wait "$k6_pid"
  local status=$?

  if [ $status -ne 0 ]; then
    note "k6 exited $status — thresholds below, full log in the run output"
  fi
  grep -E "✓|✗|frames_acked|frames_rejected|ack_latency_ms|fanout_delivery_ms|fanout_alert_ms|fanout_frames_delivered|fanout_alerts_delivered" \
    "$out" | sed 's/^ */   /'
  note "server memory during the run (peak of $(wc -l <"$RESULTS/$label.rss" | tr -d ' ') samples): $(sort -h "$RESULTS/$label.rss" 2>/dev/null | tail -1)"
  return $status
}

printf 'Maekbeat load rig — %s\n' "$(date -u '+%Y-%m-%d %H:%M UTC')"
printf 'revision %s\n' "$BUILD_REVISION"

section "environment"
note "host      $(uname -srm) / $(sysctl -n hw.model 2>/dev/null || echo 'unknown model')"
note "runtime   docker $(docker version --format '{{.Server.Version}}' 2>/dev/null), context $(docker context show 2>/dev/null)"
note "vm        $(docker info --format '{{.NCPU}} CPUs' 2>/dev/null), $(docker info --format '{{.MemTotal}}' 2>/dev/null | awk '{printf "%.1f GiB", $1/1073741824}')"
note "arch      $(docker info --format '{{.Architecture}}' 2>/dev/null) (images built for the host, not the deploy target)"
note "k6        $(docker run --rm maekbeat-k6:compose version 2>/dev/null | head -1)"
note "profile   ${RUN_MS} ms per run"

"${COMPOSE[@]}" --profile load build k6 >/dev/null 2>&1

section "1 — baseline: ingest throughput and acknowledgement latency"
bring_up off
run_k6 ingest-off ingest.js RUN_MS="$RUN_MS" RATE_HZ=50 VUS=8 DEVICES_PER_VU=2

section "2 — baseline: fan-out delivery latency"
run_k6 fanout-off fanout.js RUN_MS="$RUN_MS" RATE_HZ=50 DEVICES=8

section "3 — differential: what OTLP export costs"
bring_up on
run_k6 ingest-on ingest.js RUN_MS="$RUN_MS" RATE_HZ=50 VUS=8 DEVICES_PER_VU=2
run_k6 fanout-on fanout.js RUN_MS="$RUN_MS" RATE_HZ=50 DEVICES=8

section "4 — differential: what a stalled subscriber costs the healthy ones"
bring_up off
# On the compose network, not the host. A k6 VU cannot refuse to read — the
# runtime drains the socket for you — and neither, it turns out, can a host-side
# client: a published port is a proxy that reads from the server eagerly and
# buffers on its own side, so 9000 frames pushed at a host-side stalled
# subscriber produced zero drops where the in-process test crosses the same
# bound in about 5000. The peer stalling the server has to share its network.
"${COMPOSE[@]}" --profile load up -d stalled >/dev/null 2>&1
STALLED_CID=up
for _ in $(seq 1 40); do
  "${COMPOSE[@]}" logs stalled 2>&1 | grep -q attached && break
  sleep 0.25
done
if "${COMPOSE[@]}" logs stalled 2>&1 | grep -q attached; then
  note "a stalled subscriber is attached to k6-fanout-0, and reads nothing"
else
  note "WARNING: the stalled subscriber never attached; this comparison is void"
fi
# 4a — the cost to the healthy ones, at the same profile as section 2, so the
# two are comparable. This is the question as asked.
run_k6 fanout-stalled fanout.js RUN_MS="$RUN_MS" RATE_HZ=50 DEVICES=8
note "stalled peer: $("${COMPOSE[@]}" logs stalled 2>&1 | tail -1 | sed 's/^[^|]*| //')"

# 4b — where the bound actually lands, which is not where the arithmetic says.
# 256 KiB at 211 bytes a message is about 1240 frames, and a stalled subscriber
# sails past that: its own kernel receive buffer holds several megabytes before
# the server's write queue grows at all. Measured here, the drop needs roughly
# 36 000 frames — about 7.6 MB published — because `bufferedAmount` is the
# server's own queue and the operating system's buffers sit in front of it.
# Nothing at 50 Hz reaches it inside a run of any reasonable length, which is
# why this step drives one device hard instead of raising the profile above.
note "driving k6-fanout-0 hard, to reach the bound rather than infer it"
run_k6 fanout-drop fanout.js RUN_MS="${DROP_MS:-60000}" RATE_HZ=1000 DEVICES=1
note "server log: $("${COMPOSE[@]}" logs server 2>/dev/null | grep -c 'fell behind the send buffer limit') subscriber(s) dropped for falling behind"
"${COMPOSE[@]}" rm -sf stalled >/dev/null 2>&1
unset STALLED_CID

section "5 — differential: does the alert path track device count or rate?"
# The same total frames per second split two ways, with breaching values so the
# engine really runs a window and raises: 32 devices at 12.5 Hz against 8
# devices at 50 Hz is 400 frames/s either way, and what differs is how many
# independent windows the engine keeps.
#
# The VU count is held at 8 for both, which is the correction that makes this a
# comparison at all. A first version varied it — 8 VUs against 4 — so the two
# runs also differed in how many sockets the server was reading from, and the
# latency gap it produced could have been either cause.
note "spread — 32 devices over 8 sockets at 12.5 Hz"
run_k6 spread ingest.js RUN_MS="$RUN_MS" RATE_HZ=12.5 VUS=8 DEVICES_PER_VU=4 BREACH=1
note "concentrated — 8 devices over 8 sockets at 50 Hz"
run_k6 concentrated ingest.js RUN_MS="$RUN_MS" RATE_HZ=50 VUS=8 DEVICES_PER_VU=1 BREACH=1

printf '\nThese describe this laptop under this runtime, not the system capacity.\n'
printf 'No extrapolation, and no claim about how many devices this supports.\n'
printf 'Recorded with the environment in infra/README.md.\n'
