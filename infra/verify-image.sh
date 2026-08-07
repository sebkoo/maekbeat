#!/usr/bin/env bash
# Executable proofs about the server image itself — the ones that need no
# compose stack. The stack-level proofs live in infra/compose-smoke.sh.
#
#   infra/verify-image.sh
#
# Builds the image twice, for the deploy target and for this machine, and then
# asks it five questions that "it built" and "it started" do not answer:
#
#   1. Does it run as a non-root user?
#   4. Can its healthcheck ever go red?
#   6. Does missing configuration fail fast, naming what is missing?
#   7. Is the repository's own debris out of it?
#   8. Is the deploy-target image really amd64, and does it execute?
#      (Sizes for both architectures are printed at the end.)
#
# The numbers are this repository's acceptance criteria for the container work
# (docs/ROADMAP.md, C19). The gaps are not omissions: 2, 3, 5 and 9 are stack
# properties and are proven in infra/compose-smoke.sh, and 10 is the
# measurement set recorded in infra/README.md.
set -uo pipefail

cd "$(dirname "$0")/.."

REVISION=${BUILD_REVISION:-$(git rev-parse HEAD)}
TARGET_TAG=maekbeat-server:verify-amd64
HOST_TAG=maekbeat-server:verify-host
HOST_PLATFORM="linux/$(docker version --format '{{.Server.Arch}}')"

failures=0
pass() { printf '  ok   %s\n' "$1"; }
fail() {
  printf '  FAIL %s\n' "$1"
  [ $# -gt 1 ] && printf '       %s\n' "$2"
  failures=$((failures + 1))
}
section() { printf '\n== %s\n' "$1"; }

cleanup() {
  for cid in $HEALTHY_CID $UNHEALTHY_CID; do
    [ -n "$cid" ] && docker rm -f "$cid" >/dev/null 2>&1
  done
  return 0
}
HEALTHY_CID=""
UNHEALTHY_CID=""
trap cleanup EXIT

# ---------------------------------------------------------------------------
section "building $REVISION for linux/amd64 (deploy target) and $HOST_PLATFORM (this machine)"
# ---------------------------------------------------------------------------
for spec in "linux/amd64:$TARGET_TAG" "$HOST_PLATFORM:$HOST_TAG"; do
  platform=${spec%%:*}
  tag=${spec#*:}
  if ! docker build --platform "$platform" -f infra/server.Dockerfile \
    --build-arg BUILD_REVISION="$REVISION" -t "$tag" . >/tmp/maekbeat-build.log 2>&1; then
    tail -20 /tmp/maekbeat-build.log
    fail "build for $platform"
    exit 1
  fi
  pass "built $tag for $platform"
done

# ---------------------------------------------------------------------------
section "8 — architecture"
# ---------------------------------------------------------------------------
# The sharpest container failure is not a subtle one: an image that runs
# perfectly on this laptop cannot execute at all on an amd64 host. Docker on an
# arm64 machine builds arm64 by default and says nothing about it, so the
# assertion is on the built artifact rather than on the command that made it.
target_arch=$(docker image inspect "$TARGET_TAG" --format '{{.Architecture}}')
if [ "$target_arch" = "amd64" ]; then
  pass "the deploy-target image reports amd64"
else
  fail "the deploy-target image reports $target_arch, not amd64" \
    "a build without --platform on this arm64 host produces exactly this"
fi

host_arch=$(docker image inspect "$HOST_TAG" --format '{{.Architecture}}')
[ "$host_arch" = "${HOST_PLATFORM#linux/}" ] &&
  pass "the host image reports $host_arch" ||
  fail "the host image reports $host_arch, expected ${HOST_PLATFORM#linux/}"

# Reporting amd64 and executing on amd64 are different claims, and only the
# second one matters at 3am. This runs the amd64 binary — under Rosetta on this
# host, natively on the target — and makes it answer for itself.
reported=$(docker run --rm --platform linux/amd64 --entrypoint node "$TARGET_TAG" \
  -e 'process.stdout.write(process.arch)' 2>/dev/null)
[ "$reported" = "x64" ] &&
  pass "the amd64 image executes: its node reports process.arch=x64" ||
  fail "the amd64 image did not execute as x64" "got '$reported'"

# ---------------------------------------------------------------------------
section "1 — non-root"
# ---------------------------------------------------------------------------
for tag in "$TARGET_TAG" "$HOST_TAG"; do
  uid=$(docker run --rm --entrypoint id "$tag" -u 2>/dev/null)
  [ -n "$uid" ] && [ "$uid" -ne 0 ] 2>/dev/null &&
    pass "$tag runs as uid $uid" ||
    fail "$tag runs as uid '$uid'" "removing USER from the Dockerfile produces uid 0"
done

# ---------------------------------------------------------------------------
section "6 — missing configuration fails fast and readably"
# ---------------------------------------------------------------------------
# BUILD_REVISION is baked into the image, so removing it means overriding it
# with an empty value — the same thing a deployment does when it templates a
# variable that resolved to nothing.
out=$(docker run --rm -e BUILD_REVISION= "$HOST_TAG" 2>&1)
code=$?
[ "$code" -ne 0 ] &&
  pass "the container exits non-zero ($code) without BUILD_REVISION" ||
  fail "the container started without BUILD_REVISION"
printf '%s' "$out" | grep -q "BUILD_REVISION" &&
  pass "the failure message names the variable" ||
  fail "the failure message does not name BUILD_REVISION" "$(printf '%s' "$out" | head -3)"
# Positive control: the same image with the variable present does start, so the
# assertion above is about the variable and not about the image being broken.
docker run --rm -d --name maekbeat-config-control "$HOST_TAG" >/dev/null 2>&1 &&
  sleep 3 &&
  [ "$(docker inspect -f '{{.State.Running}}' maekbeat-config-control 2>/dev/null)" = "true" ] &&
  pass "control: the same image with BUILD_REVISION set stays up" ||
  fail "control: the image does not start even with BUILD_REVISION set"
docker rm -f maekbeat-config-control >/dev/null 2>&1

# ---------------------------------------------------------------------------
section "7 — no build debris"
# ---------------------------------------------------------------------------
# Scoped to what this repository put there. Third-party packages publish their
# own tests inside their tarballs — zod ships 168 *.test.ts files — and pruning
# a dependency's published contents is not this build's business; the count is
# printed below rather than hidden behind a green tick.
debris=$(docker run --rm --entrypoint sh "$HOST_TAG" -c '
  echo "git=$(find / -name .git -type d 2>/dev/null | wc -l | tr -d " ")"
  echo "ourtests=$(find /srv/maekbeat/src /srv/maekbeat/node_modules/@maekbeat \
      -name "*.test.ts" -o -name "*.spec.ts" 2>/dev/null | wc -l | tr -d " ")"
  echo "vendortests=$(find /srv/maekbeat/node_modules -name "*.test.ts" 2>/dev/null | wc -l | tr -d " ")"
  echo "devdeps=$(ls -d /srv/maekbeat/node_modules/vitest \
      /srv/maekbeat/node_modules/typescript \
      /srv/maekbeat/node_modules/@types \
      /srv/maekbeat/node_modules/@playwright \
      /srv/maekbeat/node_modules/@vitest \
      /srv/maekbeat/node_modules/@maekbeat/vitals-sim 2>/dev/null | wc -l | tr -d " ")"
  echo "scripts=$(ls -d /srv/maekbeat/scripts 2>/dev/null | wc -l | tr -d " ")"
')
eval "$debris"
[ "${git:-1}" = "0" ] && pass "no .git directory" || fail "$git .git director(ies) in the image"
[ "${ourtests:-1}" = "0" ] &&
  pass "no test file from this repository" ||
  fail "$ourtests test file(s) from this repository" "the **/*.test.ts line in .dockerignore is what keeps them out"
[ "${devdeps:-1}" = "0" ] &&
  pass "no dev-only dependency (vitest, typescript, @types, @vitest, @playwright, vitals-sim)" ||
  fail "$devdeps dev-only dependenc(ies) present"
[ "${scripts:-1}" = "0" ] &&
  pass "no apps/server/scripts (demo wiring is not runtime code)" ||
  fail "apps/server/scripts is in the image"
printf '  note %s *.test.ts published by third-party packages remain; not this build to prune.\n' "${vendortests:-?}"

# ---------------------------------------------------------------------------
section "4 — the healthcheck can go red"
# ---------------------------------------------------------------------------
# A healthcheck that has never been observed failing is a green light wired to
# nothing. The control pair: the same image, the same HEALTHCHECK, with and
# without the server behind it.
await_health() {
  cid=$1
  want=$2
  limit=$((SECONDS + 90))
  while [ $SECONDS -lt $limit ]; do
    state=$(docker inspect -f '{{.State.Health.Status}}' "$cid" 2>/dev/null)
    [ "$state" = "$want" ] && return 0
    sleep 2
  done
  printf '       last observed status: %s\n' "${state:-none}"
  return 1
}

HEALTHY_CID=$(docker run -d --platform linux/amd64 "$TARGET_TAG")
await_health "$HEALTHY_CID" healthy &&
  pass "with the server running, docker inspect reports healthy" ||
  fail "the healthy control never reached healthy"

# No server, everything else identical: the entrypoint is replaced by a sleep,
# so the container is up, the healthcheck runs, and /healthz answers nothing.
UNHEALTHY_CID=$(docker run -d --platform linux/amd64 --entrypoint sleep "$TARGET_TAG" 300)
await_health "$UNHEALTHY_CID" unhealthy &&
  pass "with nothing serving, docker inspect reports unhealthy" ||
  fail "the healthcheck never went red" "it is reporting the container's existence, not the server's"

docker rm -f "$HEALTHY_CID" "$UNHEALTHY_CID" >/dev/null 2>&1
HEALTHY_CID=""
UNHEALTHY_CID=""

# ---------------------------------------------------------------------------
section "10 — measurements"
# ---------------------------------------------------------------------------
printf '  runtime      %s (docker %s / %s, compose %s)\n' \
  "$(docker info --format '{{.Name}}' 2>/dev/null)" \
  "$(docker version --format '{{.Client.Version}}')" \
  "$(docker version --format '{{.Server.Version}}')" \
  "$(docker compose version --short)"
# Which image store, because it decides what the two size columns below mean.
# Under containerd, `docker image ls` reports unpacked snapshots and
# `inspect .Size` reports the compressed content store; under the classic store
# both report uncompressed layer content and the two columns collapse to one
# number. The table was read as store-independent once and was not
# (infra/README.md).
if docker info --format '{{json .DriverStatus}}' 2>/dev/null | grep -q 'io.containerd.snapshotter'; then
  store="containerd — ls is unpacked snapshots, inspect .Size is compressed content"
else
  store="classic — both columns report uncompressed layer content"
fi
printf '  image store  %s\n' "$store"
printf '  host         %s, %s CPUs and %s GiB inside the VM\n' "$(uname -sm)" \
  "$(docker info --format '{{.NCPU}}')" \
  "$(docker info --format '{{.MemTotal}}' | awk '{printf "%.1f", $1/1073741824}')"
# Two numbers, because they answer different questions and differ by a factor
# of four here: unpacked is what the host disk holds, and the summed layer
# content is roughly what a pull transfers.
printf '  %-28s %-9s %-9s %s\n' image unpacked layers arch
for tag in "$TARGET_TAG" "$HOST_TAG"; do
  printf '  %-28s %-9s %-9s %s\n' "$tag" \
    "$(docker image ls "$tag" --format '{{.Size}}')" \
    "$(docker image inspect "$tag" --format '{{.Size}}' | awk '{printf "%.0fMB", $1/1000000}')" \
    "$(docker image inspect "$tag" --format '{{.Architecture}}')"
done
printf '  build times are not measured here: a timing run wants an idle machine and\n'
printf '  this script has just built twice. infra/README.md records the numbers and\n'
printf '  the exact commands that produced them.\n'

# ---------------------------------------------------------------------------
if [ "$failures" -gt 0 ]; then
  printf '\n%d image assertion(s) failed.\n' "$failures"
  exit 1
fi
printf '\nimage proofs pass for %s.\n' "$REVISION"
