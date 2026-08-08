#!/usr/bin/env bash
# Does the built image carry a bill of materials, and does it list what this
# repository says it ships?
#
#   infra/verify-image-sbom.sh <oci-archive.tar>
#
# An SBOM that is generated and never checked against anything is a file, not
# evidence. `sbom: true` costs one line and produces an attestation nobody
# reads; what makes it worth having is that something fails when it stops being
# true.
#
# IT READS A TAR, NOT A REGISTRY, AND THAT IS THE DESIGN. `docker buildx
# imagetools inspect` resolves through a registry — pointed at a local tag it
# answers "pull access denied, repository does not exist or may require
# authorization" (measured 2026-08-08). A registry-based check could therefore
# only run in the `publish` job, on pushes to main, against a package that is
# still private, so a fresh clone could not run it at all. An OCI archive is
# readable with tar and jq by anyone who can build the image.
#
# What that buys and what it does not: this runs wherever the image is built,
# which is every push and every pull request, and on a laptop. It is NOT one of
# the hygiene-job guards and is not a /ship-check step, because it needs a
# container build and those are second-scale shell checks. (This line said
# "the eight hygiene guards" until the commit that added a ninth made it stale,
# one commit later — hence no count.)
#
# THE FORMAT IS SPDX, NOT CYCLONEDX. BuildKit's `sbom: true` emits an SPDX
# document with predicate type `https://spdx.dev/Document`, produced by the Syft
# scanner plugin; another format needs `--attest type=sbom,generator=<image>`
# and a generator implementing BuildKit's scanner protocol (checked 2026-08-08
# against docs.docker.com/build/metadata/attestations/sbom/). The C22 row said
# CycloneDX. It was naming a format without checking what the toolchain
# produces, and the row is corrected rather than the toolchain bent to it. No
# claim is made here about what either format is a standard of.
#
# WHAT IS COMPARED, AND WHY IT IS NOT THE WHOLE INVENTORY.
# docs/regulatory/soup-inventory.md holds 50 items across five classes and most
# of them cannot be in a server image: apps/ios has no presence in it, apps/web
# is a different artifact, devDependencies are not installed by
# `pnpm --prod deploy`, and GitHub Actions are not packages at all. Asserting
# containment over the whole inventory would fail on the first run, and the
# tempting repair — weakening the assertion until it passes — produces a check
# that proves nothing.
#
# So the subset is DERIVED FROM THE MANIFEST THAT DECIDES IT, not from a list
# kept beside it: `apps/server/package.json` `dependencies`, minus the
# `@maekbeat/*` workspace links this repository wrote. That is the exact set
# `pnpm --filter @maekbeat/server --prod deploy` copies into the runtime stage,
# so the subset moves when the shipped set moves and a newly added runtime
# dependency is compared without anyone remembering to add it anywhere. There
# is deliberately no exclusion list — an exclusion list is where this kind of
# guard dies, because the next dependency lands outside it in silence.
#
# The inventory's own agreement with that manifest is a different check and
# already exists: scripts/check-soup-inventory.sh diffs the document against
# every package.json in both directions. This script asks the question that one
# cannot — whether the thing actually built contains them.
#
# CONTAINMENT, ONE DIRECTION ONLY. Every derived runtime dependency must appear
# in the SBOM; the SBOM may list hundreds more, because it describes the
# transitive closure and the inventory never claimed to. The reverse direction
# is not asserted and could not be: for transitive packages, absent from the
# inventory is the normal and documented state.
#
# NAME MATCHING IS EXACT, WITH NO NORMALISATION. Syft reports npm packages under
# their package name, scope included, so `@fastify/cors` is compared as
# `@fastify/cors`. No lowercasing, no version stripping, no scope rewriting — if
# the scanner ever names things differently this check goes red rather than
# quietly matching fewer, because a containment check whose misses are invisible
# is worse than none while still reporting a number. A miss fails; nothing is
# skipped.
#
# THE ASSERTION HAS BEEN OBSERVED PASSING, not only refusing. Run against a real
# server image built locally on 2026-08-08: 295 SPDX packages, all 13 runtime
# dependencies present. The exact-match assumption held — Syft reported
# `@fastify/cors` and `@opentelemetry/exporter-trace-otlp-http` under exactly
# those names — and the transitive tail was visibly there and unasserted
# (`@fastify/error`, `@opentelemetry/core`, `ajv`, `abbrev`). A check seen only
# refusing is no better established than one seen only agreeing, which is why
# that run happened before this shipped rather than after the first red runner.
#
# The cost this header deferred to the first run, corrected once there were
# enough runs to correct it: the image job read 1m24s before the SBOM build,
# 1m25s at 6bbae8f, and 1m33s at 80688fb, which changed nothing in that job. So
# the run-to-run variance is around eight seconds and the one-second delta sits
# inside it. What is supported is that the second build's cost is BELOW the
# job's noise floor across three runs — not that it is one second. A single
# observation of a one-second difference against an eight-second spread is not a
# measurement of that difference, and the earlier wording claimed it was.
set -uo pipefail

cd "$(dirname "$0")/.."

ARCHIVE=${1:?usage: infra/verify-image-sbom.sh <oci-archive.tar>}
MANIFEST=apps/server/package.json

failures=0
pass() { printf '  ok   %s\n' "$1"; }
fail() {
  printf '  FAIL %s\n' "$1"
  failures=$((failures + 1))
}
note() { printf '       %s\n' "$1"; }

for tool in jq tar; do
  command -v "$tool" >/dev/null 2>&1 || {
    fail "$tool is required and not on PATH; the check did not run"
    exit 1
  }
done

if [ ! -f "$ARCHIVE" ]; then
  fail "$ARCHIVE does not exist; the check did not run"
  note "The build step that writes the OCI archive did not produce it. This is"
  note "not a passing SBOM — it is no SBOM."
  exit 1
fi

if [ ! -f "$MANIFEST" ]; then
  fail "$MANIFEST does not exist; there is nothing to derive the runtime set from"
  exit 1
fi

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

tar -xf "$ARCHIVE" -C "$work" || {
  fail "$ARCHIVE is not a readable tar; the check did not run"
  exit 1
}

if [ ! -f "$work/index.json" ]; then
  fail "$ARCHIVE has no index.json, so it is not an OCI layout; the check did not run"
  exit 1
fi

# ---------------------------------------------------------------------------
# 1. Find the SPDX predicate.
#
# Every blob is scanned for the predicate type rather than the manifest tree
# being walked, because the walk has more shapes to get wrong than the search
# and both fail closed. An image built without `sbom: true` still carries a
# provenance attestation, so "an attestation exists" proves nothing — the
# predicate type is what separates the bill of materials from the build record.
# ---------------------------------------------------------------------------
spdx_blob=""
for blob in "$work"/blobs/sha256/*; do
  [ -f "$blob" ] || continue
  ptype=$(jq -r 'if type == "object" then (.predicateType // empty) else empty end' "$blob" 2>/dev/null)
  if [ "$ptype" = "https://spdx.dev/Document" ]; then
    spdx_blob=$blob
    break
  fi
done

if [ -z "$spdx_blob" ]; then
  fail "$ARCHIVE carries no SPDX SBOM attestation"
  note "\`sbom: true\` is opt-in on docker/build-push-action and defaults to off."
  note "A SLSA provenance attestation is attached by default and is not this."
  exit 1
fi
pass "SPDX attestation found (predicateType https://spdx.dev/Document)"

names=$(jq -r '.predicate.SPDX.packages[]?.name // .predicate.packages[]?.name // empty' \
  "$spdx_blob" 2>/dev/null | sort -u | grep -v '^$' || true)
sbom_count=$(printf '%s\n' "$names" | grep -c . || true)

if [ "$sbom_count" -eq 0 ]; then
  fail "the SPDX document lists no packages"
  note "An empty bill of materials satisfies every containment check ever"
  note "written, so it is rejected rather than passed."
  exit 1
fi
pass "the SPDX document lists $sbom_count package name(s)"

# ---------------------------------------------------------------------------
# 2. Derive the runtime set from the manifest that decides it.
# ---------------------------------------------------------------------------
declared=$(jq -r '.dependencies // {} | keys[]' "$MANIFEST" 2>/dev/null |
  grep -v '^@maekbeat/' | sort -u || true)
declared_count=$(printf '%s\n' "$declared" | grep -c . || true)

if [ "$declared_count" -eq 0 ]; then
  fail "read no runtime dependencies out of $MANIFEST"
  note "A check with nothing to compare passes vacuously, which is the failure"
  note "this line exists to prevent."
  exit 1
fi

# ---------------------------------------------------------------------------
# 3. Containment.
# ---------------------------------------------------------------------------
missing=""
for dep in $declared; do
  printf '%s\n' "$names" | grep -qxF "$dep" || missing="$missing $dep"
done

if [ -n "$missing" ]; then
  for dep in $missing; do
    fail "$MANIFEST ships \`$dep\` at runtime; the image's SBOM does not name it"
  done
  note "Either the image does not contain what the manifest says it ships, or"
  note "the scanner names packages differently than this script compares them."
  note "Both are real and neither is waived here."
else
  pass "all $declared_count runtime dependencies appear in the SBOM"
fi

if [ "$failures" -gt 0 ]; then
  printf '\n%s check(s) failed for %s\n' "$failures" "$ARCHIVE"
  exit 1
fi

# The count checked, not the count some document holds: 50 inventory items when
# 13 were compared is the "3 compare ranges" defect wearing different clothes.
printf '\nSBOM verified: %s SPDX packages, %s of %s runtime dependencies compared and all present.\n' \
  "$sbom_count" "$declared_count" "$declared_count"
