#!/bin/sh
# Build the desktop app (apps/desktop, the Rune client) and place its binary
# and chord sidecar where the install finds them:
#
#   ~/.spriessen/bin/spriessen-desktop     the app
#   ~/.spriessen/sidecar/bridge.mjs        its chord bridge (Node)
#
# Gated: scripts/install-cli.sh runs it only when DESKTOP_APP_ACTIVE=1,
# so a plain install never needs a Rust toolchain. Run it directly with:
#
#   DESKTOP_APP_ACTIVE=1 sh scripts/build-desktop.sh
set -eu

REPO=$(cd "$(dirname "$0")/.." && pwd)
HOME_DIR="${SPRIESSEN_HOME:-${HOME}/.spriessen}"

if ! command -v cargo >/dev/null 2>&1; then
	echo "build-desktop: DESKTOP_APP_ACTIVE=1 needs a Rust toolchain (cargo). Install rustup first: https://rustup.rs" >&2
	exit 1
fi

echo "Building the desktop app (cargo, release)..."
(cd "${REPO}/apps/desktop" && cargo build --release)

mkdir -p "${HOME_DIR}/bin" "${HOME_DIR}/sidecar"
cp "${REPO}/apps/desktop/target/release/spriessen-desktop" "${HOME_DIR}/bin/spriessen-desktop"
cp "${REPO}/apps/desktop/sidecar/bridge.mjs" "${HOME_DIR}/sidecar/bridge.mjs"
chmod 755 "${HOME_DIR}/bin/spriessen-desktop" "${HOME_DIR}/sidecar/bridge.mjs"

echo "Installed: ${HOME_DIR}/bin/spriessen-desktop"
