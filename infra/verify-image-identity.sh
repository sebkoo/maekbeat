#!/usr/bin/env bash
# Is this image the commit it claims to be?
#
#   infra/verify-image-identity.sh <image-ref> [expected-revision]
#
# Acceptance criterion 5 of the C19 container work, asked of one already-built
# image rather than of a running stack. infra/compose-smoke.sh asks it of the
# composed stack, which is where it was first written; this asks it of an
# artifact, because that is what a CI job holds after a build and what a
# registry receives before anyone runs it.
#
# It is a separate script from infra/verify-image.sh for one reason: that script
# builds what it inspects, so it can only ever be checking a build that just
# happened. The failure being defended against is a layer that did NOT happen —
# a cache hit serving an older tree — and to catch that, the check has to be
# pointable at an image somebody else built. Layer caching is what makes that
# risk real rather than theoretical, and CI is where the caching is.
#
# The expected revision defaults to `git rev-parse HEAD` and is deliberately not
# read from BUILD_REVISION. Comparing an image built from $BUILD_REVISION
# against $BUILD_REVISION is a value agreeing with itself; the anchor has to
# come from the working tree the build was made from.
set -uo pipefail

cd "$(dirname "$0")/.."

REF=${1:?usage: infra/verify-image-identity.sh <image-ref> [expected-revision]}
EXPECTED=${2:-$(git rev-parse HEAD)}

failures=0
pass() { printf '  ok   %s\n' "$1"; }
fail() {
  printf '  FAIL %s\n' "$1"
  [ $# -gt 1 ] && printf '       %s\n' "$2"
  failures=$((failures + 1))
}

CID=""
cleanup() {
  [ -n "$CID" ] && docker rm -f "$CID" >/dev/null 2>&1
  return 0
}
trap cleanup EXIT

printf '\n== identity of %s against %s\n' "$REF" "$EXPECTED"

# ---------------------------------------------------------------------------
# What the build recorded.
# ---------------------------------------------------------------------------
label=$(docker image inspect "$REF" \
  --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' 2>/dev/null)
[ "$label" = "$EXPECTED" ] &&
  pass "org.opencontainers.image.revision is $label" ||
  fail "org.opencontainers.image.revision is '$label'" "expected $EXPECTED"

# ---------------------------------------------------------------------------
# What the process says. The label is metadata a build writes; this is the
# running software answering for itself, and the two agree only when the layer
# that runs is the layer that was built.
# ---------------------------------------------------------------------------
CID=$(docker run -d -p 127.0.0.1:0:3000 "$REF" 2>/dev/null)
if [ -z "$CID" ]; then
  fail "the image did not start"
  printf '\n%d identity assertion(s) failed.\n' "$((failures + 1))"
  exit 1
fi
port=$(docker port "$CID" 3000/tcp | head -1 | sed 's/.*://')

served=""
for _ in $(seq 1 60); do
  served=$(curl -fsS "http://127.0.0.1:$port/healthz" 2>/dev/null |
    sed -n 's/.*"revision":"\([^"]*\)".*/\1/p')
  [ -n "$served" ] && break
  sleep 1
done
[ "$served" = "$EXPECTED" ] &&
  pass "/healthz serves revision $served" ||
  fail "/healthz serves revision '$served'" "expected $EXPECTED"

# ---------------------------------------------------------------------------
if [ "$failures" -gt 0 ]; then
  printf '\n%d identity assertion(s) failed for %s.\n' "$failures" "$REF"
  exit 1
fi
printf '\n%s is %s.\n' "$REF" "$EXPECTED"
