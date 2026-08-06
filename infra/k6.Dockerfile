# The load generator, as an image rather than a mounted directory.
#
# infra/compose.yaml keeps no host bind mounts, because Colima and Docker
# Desktop differ on mount semantics and a stack that depends on them is a stack
# that runs on one laptop. That applies to the thing measuring the system as
# much as to the system: `docker compose --profile load run k6` should mean the
# same thing on a machine that has never had k6 installed.

FROM grafana/k6:1.4.0

COPY infra/k6 /scripts

# No ENTRYPOINT or CMD of its own: the base image's entrypoint is `k6`, and
# every invocation here names the script and its options, so the profile below
# is a choice at the command line rather than a rebuild.
