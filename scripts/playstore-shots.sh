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

# Clean status bar while shooting: fixed 9:00 clock, full battery and signal,
# no notification icons. Always restored, even if maestro fails.
demo_mode_exit() { "$ADB" shell am broadcast -a com.android.systemui.demo -e command exit >/dev/null 2>&1 || true; }
trap demo_mode_exit EXIT
echo "[shots] entering status bar demo mode"
"$ADB" shell settings put global sysui_demo_allowed 1
"$ADB" shell am broadcast -a com.android.systemui.demo -e command enter >/dev/null
"$ADB" shell am broadcast -a com.android.systemui.demo -e command clock -e hhmm 0900 >/dev/null
"$ADB" shell am broadcast -a com.android.systemui.demo -e command battery -e level 100 -e plugged false >/dev/null
"$ADB" shell am broadcast -a com.android.systemui.demo -e command network -e wifi show -e level 4 -e fully true -e mobile hide >/dev/null
"$ADB" shell am broadcast -a com.android.systemui.demo -e command notifications -e visible false >/dev/null

echo "[shots] running maestro flow"
OUT=playstore/.maestro-out
rm -rf "$OUT" playstore/shots
maestro test --test-output-dir "$OUT" "$@" maestro/playstore/screenshots.yaml

echo "[shots] collecting screenshots"
mkdir -p playstore/shots
find "$OUT" -name '*.png' -path '*takeScreenshot*' -exec cp {} playstore/shots/ \;
rm -rf "$OUT"

echo "[shots] done: $(ls playstore/shots | wc -l | tr -d ' ') screenshots in playstore/shots/"
