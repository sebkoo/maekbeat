#!/usr/bin/env bash
# Executable proofs about the composed stack. The image-level ones are in
# infra/verify-image.sh; these need both containers running.
#
#   infra/compose-smoke.sh
#
#   5. Is the stack that is running actually this commit?
#   2. Does the containerised server serve the system the goldens describe?
#   3. Does the C13 Playwright smoke pass against it, unchanged?
#   9. Does a stop finish inside the grace period with a client that ignores
#      the close frame — or does it end in SIGKILL?
#
# Identity first, deliberately. Every other assertion here is about behaviour,
# and a container built from stale layers behaves correctly while being the
# wrong software; asking "which commit is this" after three green suites would
# be asking it too late to mean anything.
set -uo pipefail

cd "$(dirname "$0")/.."

# The revision under test comes from the working tree and is not accepted from
# the environment. compose builds from this tree whatever BUILD_REVISION says,
# so an overridden value labels both images, is served by /healthz and is what
# every assertion below compares against — three places agreeing with each other
# and with nothing in the repository. This is not hypothetical: a run with
# BUILD_REVISION set three commits behind passed every proof in this file,
# including the identity ones, and was recorded NOT CAUGHT
# (docs/ai/mutation-log.md). An identity check whose expected value is supplied
# by whoever asked for the build is a value agreeing with itself.
#
# It refuses rather than silently overriding, because a caller that set the
# variable meant something by it and a quiet correction hides which run happened.
HEAD_REVISION=$(git rev-parse HEAD)
if [ -n "${BUILD_REVISION:-}" ] && [ "$BUILD_REVISION" != "$HEAD_REVISION" ]; then
  printf 'BUILD_REVISION is %s but this working tree is %s.\n' "$BUILD_REVISION" "$HEAD_REVISION"
  printf 'compose builds from the tree, so these have to agree or the identity proofs\n'
  printf 'below compare the build argument against itself. Unset it, or check out the\n'
  printf 'commit you meant to smoke.\n'
  exit 1
fi
export BUILD_REVISION=$HEAD_REVISION
COMPOSE=(docker compose -f infra/compose.yaml)
API_URL=http://127.0.0.1:3000
WEB_URL=http://127.0.0.1:8080

failures=0
pass() { printf '  ok   %s\n' "$1"; }
fail() {
  printf '  FAIL %s\n' "$1"
  [ $# -gt 1 ] && printf '       %s\n' "$2"
  failures=$((failures + 1))
}
section() { printf '\n== %s\n' "$1"; }

teardown() {
  [ -n "${PEER_PID:-}" ] && kill "$PEER_PID" 2>/dev/null
  "${COMPOSE[@]}" down --remove-orphans >/dev/null 2>&1
  return 0
}
trap teardown EXIT

section "bringing up the stack at $BUILD_REVISION"
# --build, not "up": a run that reuses whatever images happen to be tagged is
# the exact thing the identity check below exists to catch, and starting from a
# cache hit would leave the check testing the previous run.
if ! "${COMPOSE[@]}" up --build --detach --wait >/tmp/maekbeat-compose.log 2>&1; then
  tail -30 /tmp/maekbeat-compose.log
  fail "the stack did not come up healthy"
  exit 1
fi
pass "both services are up and healthy"

# ---------------------------------------------------------------------------
section "5 — the running stack is this commit"
# ---------------------------------------------------------------------------
label_of() {
  docker inspect -f '{{index .Config.Labels "org.opencontainers.image.revision"}}' \
    "$("${COMPOSE[@]}" ps -q "$1")" 2>/dev/null
}
for service in server web; do
  got=$(label_of "$service")
  [ "$got" = "$BUILD_REVISION" ] &&
    pass "the $service container carries org.opencontainers.image.revision=$BUILD_REVISION" ||
    fail "the $service container is labelled '$got'" "expected $BUILD_REVISION"
done

# The label says what was built. This says what is answering — and the two are
# the same value only when the layer that runs is the layer that was built.
served=$(curl -fsS "$API_URL/healthz" | sed -n 's/.*"revision":"\([^"]*\)".*/\1/p')
[ "$served" = "$BUILD_REVISION" ] &&
  pass "/healthz serves revision $served" ||
  fail "/healthz serves revision '$served'" "expected $BUILD_REVISION"

# ---------------------------------------------------------------------------
section "2 — the container serves the real system"
# ---------------------------------------------------------------------------
node infra/replay-golden.mjs "$API_URL" || fail "the golden replay failed against the container"

# ---------------------------------------------------------------------------
section "3 and 5 — the C13 smoke, unchanged, against the compose stack"
# ---------------------------------------------------------------------------
# The suite is the one in apps/web/e2e. It is pointed here by configuration and
# not by a fork: E2E_BASE_URL and E2E_API_URL empty playwright.config.ts's
# webServer list, so no local processes start and the two containers are the
# system under test. E2E_EXPECTED_REVISION turns identity.spec.ts from a skip
# into an assertion.
E2E_BASE_URL=$WEB_URL \
  E2E_API_URL=$API_URL \
  E2E_EXPECTED_REVISION=$BUILD_REVISION \
  pnpm --filter @maekbeat/web test:e2e ||
  fail "the C13 smoke failed against the compose stack"

# ---------------------------------------------------------------------------
section "9 — graceful shutdown with a client that ignores the close frame"
# ---------------------------------------------------------------------------
# C18 named this residual and left it: app.close() asks @fastify/websocket to
# close its clients and does not destroy one that never answers. In a process
# that residual is a slow exit; under an orchestrator it is SIGKILL after the
# grace period, which discards the span flush C18 shipped and reports 137 to
# whatever is watching the deployment.
peer_log=$(mktemp)
node infra/rude-peer.mjs 127.0.0.1 3000 >"$peer_log" 2>&1 &
PEER_PID=$!
for _ in $(seq 1 40); do
  grep -q attached "$peer_log" && break
  sleep 0.25
done
if grep -q attached "$peer_log"; then
  pass "a peer that answers nothing is attached to /ingest"
else
  fail "the rude peer never completed the handshake" "$(head -2 "$peer_log")"
fi

server_cid=$("${COMPOSE[@]}" ps -q server)
started=$(date +%s)
"${COMPOSE[@]}" stop -t 10 server >/dev/null 2>&1
elapsed=$(($(date +%s) - started))
exit_code=$(docker inspect -f '{{.State.ExitCode}}' "$server_cid" 2>/dev/null)

# 137 is 128+9: the grace period expired and the container was killed. Any
# assertion about the flush, the log line or the exit status is downstream of
# this one, because SIGKILL discards all three.
[ "$exit_code" != "137" ] &&
  pass "the container exited $exit_code, not 137" ||
  fail "the container was SIGKILLed (137)" "the stop did not finish inside the 10 s grace period"
[ "$elapsed" -lt 10 ] &&
  pass "the stop finished in ${elapsed}s, inside the 10 s grace period" ||
  fail "the stop took ${elapsed}s" "at or past the grace period is a stop the orchestrator ended, not the server"
grep -q "destroyed by peer" "$peer_log" &&
  pass "the server destroyed the peer rather than waiting for it" ||
  fail "the peer was never destroyed" "$(tail -2 "$peer_log")"
rm -f "$peer_log"

# ---------------------------------------------------------------------------
if [ "$failures" -gt 0 ]; then
  printf '\n%d stack assertion(s) failed.\n' "$failures"
  exit 1
fi
printf '\nstack proofs pass for %s.\n' "$BUILD_REVISION"
