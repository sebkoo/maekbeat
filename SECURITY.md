# Security Policy

## Reporting a vulnerability

Please use GitHub private vulnerability reporting on
[`sebkoo/maekbeat`](https://github.com/sebkoo/maekbeat) — open the
**Security** tab and choose "Report a vulnerability". Do not open a public
issue for security reports.

You can expect an acknowledgment within 7 days.

## Scope

Maekbeat uses synthetic data only. There is no protected health
information anywhere in this repository, so a vulnerability here cannot
expose patient data. Reports about the ingest path (WebSocket), the REST
API, the alert engine, or the AWS infrastructure — C5–C19 in
`docs/ROADMAP.md`, shipped through C14 — are in scope as each lands.

## Dependencies

- Dependency updates run weekly via `.github/dependabot.yml`.
- A CycloneDX SBOM ships with release CI (planned — lands at C22, see
  `docs/ROADMAP.md`).

## Patch cadence

Security fixes land ahead of feature commits. If a fix and a roadmap commit
compete for the next slot, the fix goes first.
