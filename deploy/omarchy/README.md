# Paperclip on Omarchy

Runs this repository as a managed Paperclip install on an
[Omarchy](https://omarchy.org) (Arch Linux) desktop, as a systemd user
service with an app-launcher entry.

## First install

Prerequisites, all user-local (no sudo, no shell-profile edits):

```sh
mise install node@24.21.0 cmake@3.31.12
# Rust 1.97.1 (pinned by packages/paperclip-runner/runner/rust-toolchain.toml)
curl -fsSLO https://static.rust-lang.org/rustup/dist/x86_64-unknown-linux-gnu/rustup-init
curl -fsSLO https://static.rust-lang.org/rustup/dist/x86_64-unknown-linux-gnu/rustup-init.sha256
echo "$(cut -d' ' -f1 rustup-init.sha256)  rustup-init" | sha256sum -c -
chmod +x rustup-init && ./rustup-init -y --no-modify-path --profile minimal --default-toolchain none
~/.cargo/bin/rustup toolchain install 1.97.1 --profile minimal --component rustfmt
```

Released Paperclip CLIs (up to `2026.1001.0-canary.4`) cannot install git
refs, so the first install runs this repository's CLI from a checkout:

```sh
export PATH="$(mise where node@24.21.0)/bin:$HOME/.cargo/bin:$(mise where cmake@3.31.12)/cmake-3.31.12-linux-x86_64/bin:$HOME/.local/bin:$PATH"
git clone --depth 1 https://github.com/tbmsindemnify/paperclip-jev.git /tmp/paperclip-jev
cd /tmp/paperclip-jev && corepack pnpm install --frozen-lockfile
corepack pnpm paperclipai install --repo tbmsindemnify/paperclip-jev --ref main --yes
cd ~ && rm -rf /tmp/paperclip-jev
paperclipai onboard --yes --install-service   # local_trusted, 127.0.0.1:3100
```

## Updates

```sh
cp deploy/omarchy/paperclip-update.sh ~/Work/ && ~/Work/paperclip-update.sh
```

## App launcher

```sh
install -m 755 deploy/omarchy/paperclip-app ~/.local/bin/paperclip-app
omarchy-webapp-install "Paperclip" "http://127.0.0.1:3100" \
  "http://127.0.0.1:3100/android-chrome-512x512.png" "$HOME/.local/bin/paperclip-app"
```

`paperclip-app` starts `paperclipai.service` if needed, waits for
`/api/health`, and opens the dashboard URL from the instance's
`runtime-info.json` with `omarchy-launch-webapp`.

## Jev task routing

Add to `~/.paperclip/instances/default/.env` (never commit the key), then
`paperclipai service restart`:

```sh
PAPERCLIP_ISSUE_ROUTER=typesafe
TYPESAFE_API_KEY=...
```

See [doc/TYPESAFE-ISSUE-ROUTER.md](../../doc/TYPESAFE-ISSUE-ROUTER.md).
