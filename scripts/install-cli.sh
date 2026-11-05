#!/bin/sh
# Install the `spriessen` command from this checkout, in one step:
#
#   sh scripts/install-cli.sh             # into ~/.local/bin
#   sh scripts/install-cli.sh --prefix /usr/local/bin
#   sh scripts/install-cli.sh --uninstall
#
# It syncs dependencies, builds the web app and the CLI, and writes a small
# launcher that runs the CLI with the repo's own Node (the one `vp node`
# resolves from mise.toml) — never whatever `node` happens to be first on
# PATH. `spriessen update` pulls and re-runs it. Everything goes through vp.
set -eu

REPO=$(cd "$(dirname "$0")/.." && pwd)
PREFIX="$HOME/.local/bin"
UNINSTALL=0
while [ $# -gt 0 ]; do
	case "$1" in
	--prefix) PREFIX=$2; shift 2 ;;
	--uninstall) UNINSTALL=1; shift ;;
	-h | --help) sed -n '2,11p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
	*) echo "install-cli: unknown option $1 (try --help)" >&2; exit 1 ;;
	esac
done
TARGET="$PREFIX/spriessen"

if [ "$UNINSTALL" = 1 ]; then
	rm -f "$TARGET"
	echo "Removed $TARGET. Your sign-in and node token stay in ~/.config/spriessen."
	exit 0
fi

VP=$(command -v vp || true)
[ -n "$VP" ] || VP="$HOME/.vite-plus/bin/vp"
if [ ! -x "$VP" ]; then
	echo "install-cli: Vite+ (vp) is not installed. Install it first: https://viteplus.dev" >&2
	exit 1
fi

# Run a step quietly; on failure show what it said, then stop.
step() {
	label=$1
	shift
	echo "$label"
	if ! out=$("$@" 2>&1); then
		printf '%s\n' "$out" >&2
		echo "install-cli: that step failed (output above)." >&2
		exit 1
	fi
}

cd "$REPO"
step "1/4 Installing dependencies…" "$VP" install --frozen-lockfile
step "2/4 Building the web app…" "$VP" -C apps/web build
step "3/4 Building the spriessen command…" "$VP" -C apps/cli build
NODE=$("$VP" node -e 'process.stdout.write(process.execPath)')

echo "4/4 Writing $TARGET…"
mkdir -p "$PREFIX"
cat >"$TARGET" <<EOF
#!/bin/sh
# The spriessen command, installed from $REPO by scripts/install-cli.sh.
NODE="$NODE"
if [ ! -x "\$NODE" ]; then
	# vp moved to another Node build since the install: ask it again.
	NODE=\$(cd "$REPO" && "$VP" node -e 'process.stdout.write(process.execPath)') || exit 1
fi
# Where this launcher lives: \`spriessen update\` reinstalls it here.
SPRIESSEN_LAUNCHER="$TARGET" exec "\$NODE" "$REPO/apps/cli/bin/spriessen.mjs" "\$@"
EOF
chmod 755 "$TARGET"

echo
echo "Installed: $TARGET"
case ":$PATH:" in
*":$PREFIX:"*) ;;
*) echo "Add it to your PATH first:  export PATH=\"$PREFIX:\$PATH\"  (in ~/.zshrc or ~/.bashrc)" ;;
esac
echo "Next: spriessen login, then just spriessen. Keep a server running with: spriessen daemon install"
