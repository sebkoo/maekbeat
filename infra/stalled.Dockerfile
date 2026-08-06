# A stalled fan-out subscriber, on the compose network rather than the host.
#
# The host version of this does not work, and finding that out is the reason
# this image exists. Reached through a published port, the stalled client cannot
# create backpressure at all: Docker's port forward is a proxy that reads from
# the server container eagerly and buffers on its own side, so the server's
# socket never fills and `bufferedAmount` never grows. Measured — 9000 frames
# pushed at a host-side stalled subscriber produced zero drops, where the
# in-process test crosses the same bound in about 5000.
#
# So the peer that is supposed to stop reading has to sit on the same network as
# the thing it is stalling. infra/stalled-subscriber.mjs is unchanged and still
# runs from the host for manual pokes; this is how infra/load.sh runs it.

FROM node:22.22.0-alpine3.22

COPY infra/stalled-subscriber.mjs /srv/stalled-subscriber.mjs

USER node

ENTRYPOINT ["node", "/srv/stalled-subscriber.mjs"]
