#!/usr/bin/env bash
# DITTO: rewrites upstream's Blacksmith runner labels in a workflow to the
# standard GitHub-hosted runners, which are free for this public repo, and
# doubles job-level timeouts because those runners have fewer cores.
# Idempotent: re-run it after an upstream sync touches the workflow.
#   scripts/ditto/ci-standard-runners.sh .github/workflows/ci.yml
set -euo pipefail
file="${1:?usage: $0 <workflow.yml>}"
tmp="$(mktemp)"
awk '
  /^    runs-on: blacksmith-[0-9]+vcpu-ubuntu-2404/ { sub(/blacksmith-[0-9]+vcpu-ubuntu-2404/, "ubuntu-24.04"); swapped = 1 }
  /^    runs-on: blacksmith-[0-9]+vcpu-macos-[0-9]+/ { sub(/blacksmith-[0-9]+vcpu-macos-[0-9]+/, "macos-15"); swapped = 1 }
  /^    runs-on: blacksmith-[0-9]+vcpu-windows-2025/ { sub(/blacksmith-[0-9]+vcpu-windows-2025/, "windows-2025"); swapped = 1 }
  # The job-level timeout follows runs-on; double it once, on the swapped job.
  swapped && /^    timeout-minutes: [0-9]+$/ { n = $2; sub(/[0-9]+$/, n * 2); swapped = 0 }
  /^  [A-Za-z0-9_-]+:$/ { swapped = 0 }
  { print }
' "$file" > "$tmp"
mv "$tmp" "$file"
if grep -n 'blacksmith-[0-9]*vcpu' "$file"; then
  echo "error: Blacksmith runner labels remain in $file" >&2
  exit 1
fi
