#!/usr/bin/env bash
# Run the Maestro e2e suite against an attached device or emulator.
#
# Handles the one prerequisite by hand-running the flows would otherwise need:
# the test fixture must be pushed AND media-scanned so the document picker's
# search can find it (see maestro/README.md).
#
# Usage:
#   npm run test:e2e                              # full suite
#   npm run test:e2e -- maestro/add-clip.yaml     # a single flow
#   npm run test:e2e -- --device emulator-5554    # target a specific device
#   (pass any maestro args after `--`; with none, runs the whole maestro/ dir)
#
# Multiple devices attached: set ANDROID_SERIAL (adb honors it) and also pass
# --device <serial> through to maestro.
set -euo pipefail

ADB="${ADB:-$(command -v adb || echo "${ANDROID_HOME:-$HOME/Library/Android/sdk}/platform-tools/adb")}"
FIXTURE="assets/test/test-audio.m4a"
DEST="/sdcard/Download/test-audio.m4a"

[ -x "$ADB" ] || command -v "$ADB" >/dev/null || { echo "e2e: adb not found (set ANDROID_HOME or ADB)" >&2; exit 1; }
command -v maestro >/dev/null || { echo "e2e: maestro not found — install from https://maestro.mobile.dev" >&2; exit 1; }
[ -f "$FIXTURE" ] || { echo "e2e: fixture missing: $FIXTURE" >&2; exit 1; }

echo "[e2e] pushing + media-scanning $FIXTURE"
"$ADB" push "$FIXTURE" "$DEST" >/dev/null
"$ADB" shell am broadcast -a android.intent.action.MEDIA_SCANNER_SCAN_FILE -d "file://$DEST" >/dev/null

# Default to the whole suite unless the args already name a flow path, so
# `-- --device <serial>` (options only) still runs everything.
has_path=false
for a in "$@"; do
  case "$a" in maestro/*|*.yaml|*.yml) has_path=true ;; esac
done
if [ "$has_path" = true ]; then
  echo "[e2e] maestro test $*"
  exec maestro test "$@"
else
  echo "[e2e] maestro test $* maestro/"
  exec maestro test "$@" maestro/
fi
