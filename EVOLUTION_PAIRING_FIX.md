# Evolution API / WhatsApp pairing (2026-10-23)

This **isolated branch** contains a Docker build for a pinned commit of the upstream
[2.3.7 pairing patch PR #2759](https://github.com/evolution-foundation/evolution-api/pull/2759).
It does **not** modify the academy backend application or its production branch.

The existing Render service `srv-d9qgcciju40c73b69p1g` currently builds
`evolution-foundation/evolution-api` on `main`, which still uses `baileys@7.0.0-rc.9`
and does not contain the patch for `companion_reg_refresh`.

## Build

```sh
docker build -f Dockerfile -t evolution-pairing:verify .
```

Source is pinned to `ErgoCodes/evolution-api@5cdf324044d4ddb178f1be487b42cfba2c346c47`
rather than following the fork's branch head. `npm ci` uses the patched
lockfile and vendored patch-package patch. Build checks require
`baileys@7.0.0-rc14` and `handleCompanionRegRefresh` in the built dependency.

## Before any production migration

1. Confirm the CI image build passes and review upstream PR #2759.
2. In Render, capture **variable names only** (do not publish values), existing database
   and Redis connection design, session storage and any disk mounts. Confirm backups
   and ensure live session credentials are persistent. Do not delete or logout any
   WhatsApp instance.
3. Validate with a test Evolution service configured using a **separate database
   and Redis namespace**; no production instance may be attached in parallel.
4. The deploy branch contains a default `Dockerfile` identical to
   `Dockerfile.evolution`: Render can retain its existing `./Dockerfile` path.
   After verification and backup, change the existing service's Git repository
   to `djara88/academy-backend` and branch
   `deploy/evolution-baileys-pairing-fix`. Render will start a deployment
   automatically on source change. This source
   change cannot currently be made through the connected Render tools.
5. After deploying, scan an up-to-date QR once, confirm
   `instance/connectionState` reports `open` and verify inbound/outbound test
   messages. Do not log the QR, webhook secret or API key.
6. Roll back by selecting the previous Render deployment / original source
   configuration, leaving databases and session storage untouched.

The patch is community-proposed, not a published official release. Its use
requires a staging test and backup; do not assume compatibility solely from CI.
