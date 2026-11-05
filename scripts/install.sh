#!/bin/sh
# Spriessen in one line:
#
#   curl -fsSL https://raw.githubusercontent.com/orgrigami/ultiv/main/scripts/install.sh | sh
#
# Everything lands in ~/.spriessen ($SPRIESSEN_HOME): the source in
# sources/, your data in data/, your keys in .env, the CLI's sign-in in
# config/. Only the `spriessen` command goes elsewhere (~/.local/bin).
# Running it again is `spriessen update`: fast-forward, rebuild, restart daemons.
#
# Needs git and Vite+ (vp). Settings: SPRIESSEN_HOME, SPRIESSEN_REPO (the git
# URL to clone), SPRIESSEN_BRANCH (default main), SPRIESSEN_BIN (default
# ~/.local/bin).
set -eu

# Everything runs from main(), called on the last line: a download cut short
# defines a function and runs nothing.
main() {
	HOME_DIR=${SPRIESSEN_HOME:-$HOME/.spriessen}
	SOURCE="$HOME_DIR/sources"
	REPO=${SPRIESSEN_REPO:-https://github.com/orgrigami/ultiv.git}
	BRANCH=${SPRIESSEN_BRANCH:-main}
	BIN=${SPRIESSEN_BIN:-$HOME/.local/bin}

	need git "Install git first (your package manager has it)."
	if ! command -v vp >/dev/null 2>&1 && [ ! -x "$HOME/.vite-plus/bin/vp" ]; then
		fail "Install Vite+ (vp) first: https://viteplus.dev, then run this again."
	fi

	mkdir -p "$HOME_DIR"
	chmod 700 "$HOME_DIR"
	fetch_source
	write_env
	echo "Building…"
	# The launcher remembers a non-default home.
	if [ "$HOME_DIR" = "$HOME/.spriessen" ]; then
		SPRIESSEN_NO_NEXT_STEPS=1 sh "$SOURCE/scripts/install-cli.sh" --prefix "$BIN"
	else
		SPRIESSEN_HOME="$HOME_DIR" SPRIESSEN_NO_NEXT_STEPS=1 sh "$SOURCE/scripts/install-cli.sh" --prefix "$BIN"
	fi
	restart_daemons

	cat <<EOF

Spriessen is installed in $HOME_DIR.
  1. Add a model provider key to $HOME_DIR/.env (e.g. KENARI_API_KEY=…)
  2. Start it:      spriessen daemon install     (or in the foreground: spriessen serve)
  3. Sign in:       spriessen login              (the first time, this sets your passcode)
  4. Open it:       http://127.0.0.1:8787  or just run  spriessen
Update later with: spriessen update
EOF
}

fail() {
	echo "spriessen install: $1" >&2
	exit 1
}

need() {
	command -v "$1" >/dev/null 2>&1 || fail "$2"
}

fetch_source() {
	if [ -d "$SOURCE/.git" ]; then
		echo "Updating the source in $SOURCE…"
		if [ -n "$(git -C "$SOURCE" status --porcelain --untracked-files=no)" ]; then
			fail "$SOURCE has local changes; commit or stash them, then run this again."
		fi
		git -C "$SOURCE" fetch --quiet origin "$BRANCH" || fail "Couldn't fetch from $REPO."
		git -C "$SOURCE" merge --ff-only --quiet FETCH_HEAD ||
			fail "$SOURCE has commits the remote doesn't; it only fast-forwards. Sort them out with git."
	elif [ -e "$SOURCE" ]; then
		fail "$SOURCE exists but isn't a git checkout; move it away, then run this again."
	else
		echo "Downloading the source into $SOURCE…"
		git clone --quiet --branch "$BRANCH" "$REPO" "$SOURCE" ||
			fail "Couldn't clone $REPO (a private repository needs your git access, e.g. SPRIESSEN_REPO=git@github.com:orgrigami/ultiv.git)."
	fi
}

# A rerun is an update: installed daemons restart onto the new code, as
# `spriessen update` does.
restart_daemons() {
	for role in server node; do
		case "$(uname -s)" in
		Darwin) unit="$HOME/Library/LaunchAgents/id.spriessen.$role.plist" ;;
		*) [ "$role" = server ] && unit="$HOME/.config/systemd/user/spriessen.service" ||
			unit="$HOME/.config/systemd/user/spriessen-node.service" ;;
		esac
		if [ -e "$unit" ]; then
			echo "Restarting the $role daemon…"
			"$BIN/spriessen" daemon restart "$role" >/dev/null ||
				echo "Couldn't restart it; run: spriessen daemon restart $role" >&2
		fi
	done
}

# The keys file, once: the example's settings, with a fresh vault key so
# stored secrets work from the first start. Never overwritten, never printed.
write_env() {
	ENV_FILE="$HOME_DIR/.env"
	[ -e "$ENV_FILE" ] && return 0
	KEY=$(od -An -N32 -tx1 /dev/urandom | tr -d ' \n')
	(umask 077 && sed "s/^VAULT_KEY=\$/VAULT_KEY=$KEY/" "$SOURCE/.env.example" >"$ENV_FILE")
	echo "Created $ENV_FILE (with a new vault key; keep a copy of it with your backups)."
}

main "$@"
