#!/usr/bin/env bash
# Recreate the Play Store screenshots against an attached device or emulator.
#
# Pipeline: generate demo audio (cached) → clear app data → push the seed
# bundle (playstore/data.json + artwork + audio) into the app's external files
# dir → run the Maestro flow (the app seeds itself on launch) → collect shots
# into playstore/shots/.
#
# Requirements:
#   - The app installed on the target (any variant; preview recommended)
#   - adb + maestro on PATH (same as scripts/e2e.sh)
#   - An emulator, or a debuggable build on a physical device (adb must be able
#     to write to /sdcard/Android/data/<app>/files)
#
# Customize the data in playstore/data.json. After editing titles/covers, also
# re-run playstore/generate-artwork.py (needs Pillow) and commit the PNGs.
#
# Usage:
#   scripts/playstore-shots.sh                      # default device
#   scripts/playstore-shots.sh --device emulator-5554
set -euo pipefail
cd "$(dirname "$0")/.."

APP=com.salezica.ivy
DEMO="/sdcard/Android/data/$APP/files/demo"
ADB="${ADB:-$(command -v adb || echo "${ANDROID_HOME:-$HOME/Library/Android/sdk}/platform-tools/adb")}"

[ -x "$ADB" ] || command -v "$ADB" >/dev/null || { echo "playstore-shots: adb not found (set ANDROID_HOME or ADB)" >&2; exit 1; }
command -v maestro >/dev/null || { echo "playstore-shots: maestro not found — install from https://maestro.mobile.dev" >&2; exit 1; }
command -v node >/dev/null || { echo "playstore-shots: node not found" >&2; exit 1; }

echo "[shots] generating demo audio"
node playstore/gen-audio.js

echo "[shots] clearing app data"
"$ADB" shell pm clear "$APP" >/dev/null

echo "[shots] pushing seed bundle"
"$ADB" shell mkdir -p "$DEMO"
"$ADB" push playstore/artwork/. "$DEMO/" >/dev/null
"$ADB" push playstore/cache/. "$DEMO/" >/dev/null
# seed.json last: its presence triggers seeding, so the rest must already be there
"$ADB" push playstore/data.json "$DEMO/seed.json" >/dev/null

echo "[shots] running maestro flow"
rm -rf maestro/playstore/shots
maestro test "$@" maestro/playstore/screenshots.yaml

echo "[shots] collecting screenshots"
rm -rf playstore/shots
mkdir -p playstore/shots
mv maestro/playstore/shots/* playstore/shots/
rmdir maestro/playstore/shots

echo "[shots] done: $(ls playstore/shots | wc -l | tr -d ' ') screenshots in playstore/shots/"
