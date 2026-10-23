# Ditto fork: staying on upstream

Ditto Desktop is a fork of [pingdotgg/t3code](https://github.com/pingdotgg/t3code)
and keeps taking upstream. Decision and reasoning: DITTO-1147.

## Sync with merge commits, never squash

An upstream sync must land as a merge commit whose second parent is the upstream
commit. A squash sync copies upstream's files without its history, so git keeps
the old merge base: the fork then reads thousands of commits "behind" and the next
sync re-conflicts on every file upstream touched since. That happened with #28.
The catch-up that followed it first recorded #28's upstream point with an
`ours`-strategy merge (no file changes), then merged current upstream.

Merge sync PRs with **Create a merge commit**. If a squash ever lands again, repair
it the same way before the next sync:

```bash
git merge -s ours <upstream-sha-the-squash-contained>
git merge upstream/main
```

## GitHub Actions: mostly disabled

Only two workflows run. Every other one is renamed to `*.yml.disabled`, because
upstream targets paid Blacksmith runners.

- `ci.yml` runs on the standard GitHub-hosted runners, which are free for this
  public repo. `scripts/ditto/ci-standard-runners.sh .github/workflows/ci.yml`
  swaps upstream's `blacksmith-*` labels for `ubuntu-24.04` / `macos-15` /
  `windows-2025`, doubles each swapped job's timeout (fewer cores), and fails
  if a Blacksmith label is left. Re-run it after every sync that touches
  `ci.yml`; it is idempotent. A conflict on a `runs-on:` or `timeout-minutes:`
  line is resolved by taking upstream's line and re-running the script.
- `upstream-sync.yml` (below) already runs on `ubuntu-24.04`.

To enable another workflow, rename it back and run the script on it. Upstream
merges can add new workflow files under their normal names, and those would
run. After each sync, rename any new `.github/workflows/*.yml` to
`.yml.disabled` unless you mean to enable it. Edits upstream makes to existing
disabled workflows follow git's rename detection into the `.disabled` files.

## Weekly sync PR

`.github/workflows/upstream-sync.yml` runs on Mondays (and on demand) and opens
`sync/t3code-<date>-<sha>` with upstream merged in. A clean merge opens a normal
PR; a conflicted one opens a draft with the markers committed and the conflicting
files listed. Resolve on that branch, push, mark ready. Only one sync PR is open
at a time.

It needs an `UPSTREAM_SYNC_TOKEN` repository secret (fine-grained token or app
token on this repo with Contents, Pull requests and Workflows write).
`GITHUB_TOKEN` cannot push merges that touch `.github/workflows`, and PRs it
opens do not run CI. Without the secret the job fails at its first step.

## Resolving conflicts

- Upstream wins on structure. Keep its refactors, renames, deletions and new APIs,
  then re-apply Ditto's intent on top. Never resurrect a file upstream deleted to
  keep a Ditto edit; port the edit to the code's new home.
- `pnpm-lock.yaml` and `apps/web/src/routeTree.gen.ts` are regenerated, not
  hand-merged.
- User-visible "T3 Code" strings read "Ditto". Paths, legacy userData directory
  names, URLs, bundle ids and the client labels sent to T3 Connect stay as
  upstream has them. Re-apply the rebrand to new upstream strings in files you
  touch.

## Where Ditto code goes

Every edit inside an upstream file is a future conflict. Keep them small:

- Put Ditto features in Ditto-owned modules (`apps/web/src/ditto`,
  `apps/server/src/dittoHarness`, `apps/server/src/channels`, the Ditto provider)
  and reach them from upstream code through one hook or registration line.
- Tag each edit to an upstream file with a `// DITTO:` comment saying what it is
  for, so the next resolver can tell a Ditto change from upstream code.
- `packages/contracts` conflicts most. Prefer a Ditto schema module that upstream
  schemas reference over editing upstream schemas field by field.
