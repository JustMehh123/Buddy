#!/bin/zsh
# One command: build Buddy if needed, wake him on the Mac, and put him on your
# phone's home screen.
#
#   ./start.sh              normal run
#   ./start.sh --demo       no Mac, no key: just his face and the script
#   ./start.sh --http       skip the local certificate (see README)
#
# Everything else it needs, it fills in itself — a missing npm package, a busy
# port, a missing app bundle.

set -euo pipefail
cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1; then
  echo "Buddy needs Node.js for the little phone server." >&2
  echo "Install it once with:  brew install node     (from https://brew.sh)" >&2
  exit 1
fi

DEMO=0
for arg in "$@"; do
  [[ "$arg" == "--demo" ]] && DEMO=1
done

# The Mac app: build it the first time, then open it (or restart it if it is
# already running so a rebuild takes effect).
if [[ ! -d build/Buddy.app ]]; then
  echo "Building Buddy.app (first run only) — needs the Xcode Command Line Tools."
  if ! ./scripts/build-mac.sh; then
    echo >&2
    echo "The Mac app did not build. If you have not installed Apple's tools yet, run:" >&2
    echo "   xcode-select --install" >&2
    echo "The phone server will still start, so you can see his face in demo mode." >&2
    DEMO=1
  fi
fi
if [[ -d build/Buddy.app ]]; then
  pkill -x BuddyMac >/dev/null 2>&1 || true
  sleep 0.4
  open build/Buddy.app
  echo "Buddy is in your menu bar."
fi

if [[ "$DEMO" == "1" ]]; then
  exec env BUDDY_DEMO=1 node companion/server.mjs
fi

echo "Tip: ./start.sh --demo shows him without the Mac app or a key."
exec node companion/server.mjs "$@"
