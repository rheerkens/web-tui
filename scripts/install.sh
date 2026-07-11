#!/bin/sh
set -eu

REPOSITORY="${WAYPOINT_REPOSITORY:-rheerkens/web-tui}"
VERSION="${WAYPOINT_VERSION:-main}"
PREFIX="${WAYPOINT_PREFIX:-$HOME/.local}"
INSTALL_SERVICE=1

usage() {
  cat <<'EOF'
Install Waypoint Terminal for the current user.

Usage: install.sh [--no-service] [--prefix DIRECTORY]

Environment:
  WAYPOINT_REPOSITORY  GitHub owner/repository (default: rheerkens/web-tui)
  WAYPOINT_VERSION     Git branch, tag, or commit (default: main)
  WAYPOINT_PREFIX      npm installation prefix (default: ~/.local)
  WAYPOINT_HOST        Service bind address (default: 127.0.0.1)

Requires Node.js 20+ and tmux. Linux user services require systemd; macOS uses
launchd. With --no-service, run `waypoint start` after installation.
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --no-service) INSTALL_SERVICE=0 ;;
    --prefix)
      [ "$#" -ge 2 ] || { echo "install.sh: --prefix requires a directory" >&2; exit 2; }
      PREFIX=$2
      shift
      ;;
    -h|--help) usage; exit 0 ;;
    *) echo "install.sh: unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
  shift
done

command -v node >/dev/null 2>&1 || {
  echo "install.sh: Node.js 20 or newer is required: https://nodejs.org/en/download" >&2
  exit 1
}
NODE_MAJOR=$(node -p "Number(process.versions.node.split('.')[0])")
[ "$NODE_MAJOR" -ge 20 ] || {
  echo "install.sh: Node.js 20 or newer is required (found $(node --version))" >&2
  exit 1
}
command -v npm >/dev/null 2>&1 || { echo "install.sh: npm is required" >&2; exit 1; }
command -v tmux >/dev/null 2>&1 || {
  echo "install.sh: tmux is required. Install it with your package manager (for example: apt install tmux or brew install tmux)." >&2
  exit 1
}

mkdir -p "$PREFIX/bin"
PACKAGE_URL="https://github.com/$REPOSITORY/archive/$VERSION.tar.gz"
echo "Installing Waypoint Terminal from $PACKAGE_URL ..."
npm install --global --prefix "$PREFIX" "$PACKAGE_URL"

WAYPOINT="$PREFIX/bin/waypoint"
[ -x "$WAYPOINT" ] || { echo "install.sh: installation completed but $WAYPOINT was not created" >&2; exit 1; }

case ":$PATH:" in
  *":$PREFIX/bin:"*) ;;
  *)
    echo
    echo "Add Waypoint to your PATH:"
    echo "  export PATH=\"$PREFIX/bin:\$PATH\""
    ;;
esac

if [ "$INSTALL_SERVICE" -eq 1 ]; then
  if { [ "$(uname -s)" = "Linux" ] && command -v systemctl >/dev/null 2>&1 && systemctl --user show-environment >/dev/null 2>&1; } || [ "$(uname -s)" = "Darwin" ]; then
    "$WAYPOINT" install-service --host "${WAYPOINT_HOST:-127.0.0.1}"
  else
    echo "An active systemd/launchd user manager was not found; starting Waypoint in the background."
    "$WAYPOINT" start --host "${WAYPOINT_HOST:-127.0.0.1}"
  fi
fi

echo
echo "Installation complete."
echo "  CLI:    $WAYPOINT"
echo "  Status: $WAYPOINT status"
echo "  Help:   $WAYPOINT help"
