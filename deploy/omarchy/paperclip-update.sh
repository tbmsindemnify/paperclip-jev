#!/usr/bin/env bash
# Update Paperclip to the latest tbmsindemnify/paperclip-jev@main and
# hot-restart paperclipai.service. Instance data, settings, and keys in
# ~/.paperclip/instances/default/.env are untouched.
# Build prerequisites (user-local, not on the default PATH):
#   node 24.21.0 and cmake 3.31.12 via mise, rust 1.97.1 via rustup.
set -euo pipefail
echo "== start $(date -Is)"
export PATH="$(mise where node@24.21.0)/bin:$HOME/.cargo/bin:$(mise where cmake@3.31.12)/cmake-3.31.12-linux-x86_64/bin:$HOME/.local/bin:$PATH"
export COREPACK_ENABLE_DOWNLOAD_PROMPT=0
unset NODE_ENV
paperclipai install --repo tbmsindemnify/paperclip-jev --ref main --yes
paperclipai service restart >/dev/null
echo "== installed $(jq -r '"\(.repo)@\(.ref) \(.sha[0:7])"' ~/.paperclip/cli/install.json)"
curl -fsS http://127.0.0.1:3100/api/health | jq -c '{status}'
echo "== done $(date -Is)"
