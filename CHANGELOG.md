# Changelog

What somebody gets when they pull the image, in the shape
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) asks for.

This is the surface, not the story. Why any of it was built, and what each
commit found on the way, is [docs/ROADMAP.md](docs/ROADMAP.md) — a build log
organised by commit. Nothing here repeats it.

## [Unreleased]

The first release, so there is no previous version to diff against. This is what
exists rather than what changed.

### Added

**One published artifact.** `ghcr.io/sebkoo/maekbeat/server:latest` — the API,
`linux/amd64`, listening on 3000, running as an unprivileged user. The dashboard
and the iOS app are in the repository and are not published; running those needs
a checkout.

**Seven routes.**

| Method | Path                                           | Serves                                                      |
| ------ | ---------------------------------------------- | ----------------------------------------------------------- |
| GET    | `/healthz`                                     | status, uptime, and the commit the image was built from     |
| GET    | `/devices`                                     | every device seen, with ingest counters                     |
| GET    | `/devices/:deviceId/frames`                    | the bounded window of stored frames                         |
| GET    | `/devices/:deviceId/alerts`                    | alert episodes, silence episodes, and the decisions on them |
| POST   | `/devices/:deviceId/alerts/:alertId/decisions` | acknowledge or dismiss an alert                             |
| GET    | `/devices/:deviceId/stream`                    | WebSocket — frames and alert transitions, pushed            |
| GET    | `/ingest`                                      | WebSocket — vitals frames in                                |

**A versioned wire contract.** Everything crossing a boundary is validated
against `packages/protocol` at `v: 1`, and unknown keys are rejected rather than
ignored.

### Not included, and each on purpose

- **No authentication, at any boundary.** Any client may claim any `deviceId`
  and record a decision under any `actor`. The five boundaries and what crosses
  them are in [docs/security/data-flow.md](docs/security/data-flow.md).
- **No persistence.** Every store is in memory and bounded. A restart loses
  frames, alerts and decisions, and the bounds discard the oldest before that.
- **No real data and no hardware.** Every vital comes from
  `packages/vitals-sim`. There is no device, no user, and nothing has been
  clinically validated — [DISCLAIMER.md](DISCLAIMER.md).
