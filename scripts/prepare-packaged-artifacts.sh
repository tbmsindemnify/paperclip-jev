#!/usr/bin/env bash
set -euo pipefail

# prepare-packaged-artifacts.sh — Stage files that published packages ship but
# the workspace build does not produce: the UI bundle in server/ui-dist and the
# runtime skills copied into the server and local adapter packages.
#
# Run after `pnpm build` (or the server build closure). Shared by
# scripts/release.sh and git-ref managed installs (cli/src/commands/install.ts)
# so both package the same artifacts.

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

bash "$REPO_ROOT/scripts/prepare-server-ui-dist.sh"

for pkg_dir in server packages/adapters/claude-local packages/adapters/codex-local; do
  rm -rf "$REPO_ROOT/$pkg_dir/skills"
  cp -r "$REPO_ROOT/skills" "$REPO_ROOT/$pkg_dir/skills"
done
echo "  -> Copied skills into server and local adapter packages"
