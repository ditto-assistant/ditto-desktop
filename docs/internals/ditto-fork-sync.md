# Ditto Desktop fork operations

Ditto Desktop is a curated fork of T3 Code, not a mirror. Upstream changes are
reviewed individually so the fork can retain its local-first chat integrations
without inheriting unrelated product deployment infrastructure.

## Automated upstream review

`curated-upstream-sync.yml` runs daily and can also be started manually. A
future GitHub App or webhook listener can trigger it with the
`upstream-t3code-updated` repository dispatch event.

The workflow asks OpenCode to inspect every new upstream commit, port only the
relevant changes, and open a draft-quality review PR with selected and skipped
commit rationales. It never merges the result automatically. The cursor in
`.github/upstream-sync-base` advances in that PR so skipped commits are not
reconsidered on every daily run.

Configure these repository secrets:

- `OPENROUTER_API_KEY`: used only by OpenCode during the scheduled review.
- `FORK_SYNC_TOKEN`: a fine-grained token or GitHub App token with contents and
  pull-request write access. A separate token is required so the opened PR
  triggers the fork's normal CI.
- `DITTO_TELEGRAM_API_ID` and `DITTO_TELEGRAM_API_HASH`: optional until Ditto's
  Telegram application is registered. When present, desktop preview builds
  embed the complete pair into the device-local Telegram sidecar.

The optional `FORK_SYNC_MODEL` repository variable overrides the default
`openrouter/z-ai/glm-5.3-flash` model.

## Deployment boundary

This repository builds and tests a desktop application. It does not deploy a
web application, relay service, or mobile application. The inherited upstream
deployment and release workflows are deliberately absent. CI runs
`check-fork-policy.mjs` so a curated upstream sync cannot accidentally restore
them.

Desktop preview packaging remains enabled. A Ditto-specific signed desktop
release workflow can be added separately when its signing and release channels
are ready.
