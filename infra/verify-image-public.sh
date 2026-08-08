#!/usr/bin/env bash
# Can a stranger pull this image? Asked without any credential this runner holds.
#
#   infra/verify-image-public.sh <registry>/<path>:<tag>
#
# THE README'S FIRST LINE IS A CLAIM ABOUT STATE THIS REPOSITORY DOES NOT OWN.
# Once a quickstart says `docker pull ghcr.io/...`, whether that works depends on
# a GHCR package visibility setting changed through a web UI, by a person, with
# nothing in the tree noticing. That is not hypothetical: C19 recorded that the
# package was private and that anonymous pullability was "deliberately
# unasserted rather than checked by something that cannot fail". It is public
# today. WHEN IT CHANGED IS NOT KNOWABLE FROM ANYTHING HERE — no commit, no log,
# no document records the flip, so nobody can say whether it happened three rows
# ago or last week. That is the gap, and it is a better argument for this check
# than any duration would be: the problem was never that a document went stale,
# it is that no document could have told you either way.
#
# WHY NOT `docker pull`. The publish job runs docker/login-action before it does
# anything, so a plain pull there succeeds on the runner's credentials and
# proves nothing about a stranger — the assertion would test a correlate while
# the authenticated path made the correlate look total. `docker logout` would
# work and was rejected: it mutates shared state that a later step could undo,
# and the guarantee would then depend on step ordering rather than on the check.
#
# So this speaks to the registry over HTTP and NEVER READS THE DOCKER CONFIG.
# curl has no access to ~/.docker/config.json, no credential helper, and is
# handed no Authorization header except the anonymous token it fetches itself.
#
# The property that buys is that the check CANNOT AUTHENTICATE BY ACCIDENT: no
# ambient credential from a prior login step can leak into it. It is not proof
# against somebody editing this file to add a header from a secret tomorrow, and
# it does not need to be — the failure mode here is the runner's existing
# session bleeding through a step that looks independent, not sabotage.
#
# THE TWO ZEROS ARE NOT THE SAME AND ARE NOT REPORTED THE SAME. A registry that
# is unreachable, rate-limiting, or serving a 5xx does not mean the package is
# public; it means nothing was learned. Those exit 1 saying the check DID NOT
# RUN. A green build meaning "we could not tell" is the failure this file exists
# to prevent, so there is no path here that treats an unknown as a pass.
#
# THE REFERENCE IS THE ONE THE README TELLS PEOPLE TO PULL, and that binding is
# the point: a guard watching `:<sha>` while the quickstart says `:latest` is
# watching something nobody was told to use. Today that is `:latest`, because it
# is the only human-typeable tag the publish job pushes — the sha tag is
# immutable and correct and nobody types forty hex characters out of a README.
# If a release ever pushes a version tag, this must assert that one too.
#
# Run by the publish job, which is the only place the image exists in a registry
# and is therefore main-only. It does not run on pull requests, and that is
# acceptable here for a reason rather than by omission: a pull request has not
# pushed anything, so there is no published artifact whose visibility could be
# asked about. The gap it leaves is real and narrow — visibility flipped between
# two pushes to main goes unnoticed until the next one.
set -uo pipefail

REF=${1:?usage: infra/verify-image-public.sh <registry>/<path>:<tag>}

registry=${REF%%/*}
rest=${REF#*/}
repo=${rest%:*}
tag=${rest##*:}

if [ "$rest" = "$repo" ]; then
  printf '  FAIL %s names no tag; pass <registry>/<path>:<tag>\n' "$REF"
  exit 1
fi

note() { printf '       %s\n' "$1"; }
pass() { printf '  ok   %s\n' "$1"; }

fail() {
  printf '  FAIL %s\n' "$1"
  exit 1
}

# Distinct from fail() on purpose: "we could not ask" is not "the answer is no",
# and conflating them would let a flaky network read as a broken package.
didnotrun() {
  printf '  UNKNOWN %s\n' "$1"
  note "The check DID NOT RUN. This is not a pass and not a verdict about the"
  note "package; nothing was learned about whether a stranger can pull it."
  exit 1
}

command -v curl >/dev/null 2>&1 || didnotrun "curl is not on PATH"

# 1. An anonymous token, and its STATUS is already a verdict.
#
#    GHCR does not hand a token to everybody. For a repository an anonymous
#    caller may not see it answers 403 with {"code":"DENIED"} — measured, not
#    assumed: that is what a nonexistent repository returns and what another
#    account's invisible one returns, and the two are indistinguishable from
#    outside by design. So 401/403 here is the private-package signal and is a
#    FAILURE, not an unknown. An earlier draft of this script routed it to
#    "did not run", which would have reported a package going private as a
#    check that could not be performed; the negative control below is what
#    found that.
token_body=$(curl -sS --max-time 30 -w '\n%{http_code}' \
  "https://${registry}/token?scope=repository:${repo}:pull&service=${registry}" 2>/dev/null)
curl_status=$?
[ "$curl_status" -eq 0 ] || didnotrun "could not reach https://${registry}/token (curl exit ${curl_status})"

token_http=$(printf '%s' "$token_body" | tail -1)
case "$token_http" in
200) ;;
401 | 403)
  fail "${REF} is not visible to an anonymous caller (token endpoint HTTP ${token_http})"
  note "GHCR denies a token for a package a caller may not see, and answers the"
  note "same way for one that does not exist. Either the package went private or"
  note "the path is wrong; both break every quickstart that names it."
  ;;
429 | 5??)
  didnotrun "the token endpoint answered HTTP ${token_http}"
  ;;
*)
  didnotrun "unexpected HTTP ${token_http} from the token endpoint"
  ;;
esac

token=$(printf '%s' "$token_body" | sed -n 's/.*"token"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')
[ -n "$token" ] || didnotrun "https://${registry}/token answered 200 with no token field"

# 2. The manifest, with that anonymous token and nothing else. This is the
#    request a stranger's `docker pull` makes first, and the one that 401s or
#    404s when a package is private.
http=$(curl -sS --max-time 30 -o /dev/null -w '%{http_code}' \
  -H "Authorization: Bearer ${token}" \
  -H 'Accept: application/vnd.oci.image.index.v1+json' \
  -H 'Accept: application/vnd.docker.distribution.manifest.list.v2+json' \
  -H 'Accept: application/vnd.oci.image.manifest.v1+json' \
  "https://${registry}/v2/${repo}/manifests/${tag}" 2>/dev/null)
curl_status=$?
[ "$curl_status" -eq 0 ] || didnotrun "could not reach the manifest endpoint (curl exit ${curl_status})"

case "$http" in
200)
  pass "${REF} is anonymously pullable (manifest HTTP 200, no credentials used)"
  ;;
401 | 403)
  fail "${REF} requires authentication (HTTP ${http})"
  note "The package is private, or its visibility was changed. Every quickstart"
  note "telling a reader to pull this is currently broken for that reader."
  ;;
404)
  fail "${REF} is not there anonymously (HTTP 404)"
  note "GHCR answers 404 rather than 401 for a package a caller may not see, so"
  note "this is either a private package or a tag that does not exist."
  ;;
429 | 5??)
  didnotrun "the registry answered HTTP ${http}"
  ;;
*)
  didnotrun "unexpected HTTP ${http} from the manifest endpoint"
  ;;
esac
