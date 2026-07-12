#!/bin/bash
# Android build isolation for the sandbox container.
#
# /workspace is a bind mount of the developer's Mac checkout, and Android build
# artifacts embed absolute paths — building in place breaks the next Mac build
# (see CLAUDE.md > Environment). This script mirrors the working tree to a
# container-local copy with its own node_modules and builds there: /workspace
# stays pristine and container builds stay incremental across invocations.
#
# Usage (from anywhere):
#   scripts/container-build.sh :app:assembleDebug -PreactNativeArchitectures=arm64-v8a
#   scripts/container-build.sh :app:compileDebugKotlin
#
# The mirror includes uncommitted and untracked files (full rsync of the tree,
# minus node_modules and build outputs). Requires ANDROID_HOME (defaults to the
# sandbox install at /opt/android-sdk).

set -euo pipefail

SRC=/workspace
DIR=${IVY_BUILD_DIR:-/home/claude/ivy-build}
export ANDROID_HOME=${ANDROID_HOME:-/opt/android-sdk}

[ "$(uname -s)" = "Linux" ] || { echo "container-only script; on macOS just build in place" >&2; exit 1; }

mkdir -p "$DIR"
echo "[container-build] syncing $SRC -> $DIR"
rsync -a --delete \
  --exclude '/.git' \
  --exclude '/node_modules' \
  --exclude '/android/build' \
  --exclude '/android/.gradle' \
  --exclude '/android/app/build' \
  --exclude '/android/local.properties' \
  --exclude '/modules/ivy/android/build' \
  --exclude '.cxx' \
  --exclude '/.expo' \
  "$SRC/" "$DIR/"

# Mirror is a fresh checkout as far as gradle is concerned, except node_modules
# build outputs, which live only in the mirror and persist for incrementality.

# Dependencies: reinstall only when the lockfile changed
LOCK_HASH=$(sha256sum "$DIR/package-lock.json" | cut -d' ' -f1)
if [ ! -d "$DIR/node_modules" ] || [ "$(cat "$DIR/.node_modules_lock_hash" 2>/dev/null)" != "$LOCK_HASH" ]; then
  echo "[container-build] npm ci (lockfile changed or first run)"
  (cd "$DIR" && npm ci --silent --no-audit --no-fund)
  echo "$LOCK_HASH" > "$DIR/.node_modules_lock_hash"
fi

LP_CONTENT=$(printf 'sdk.dir=%s\ncmake.dir=/opt/cmakewrap\n' "$ANDROID_HOME")
if [ "$(cat "$DIR/android/local.properties" 2>/dev/null)" != "$LP_CONTENT" ]; then
  printf '%s\n' "$LP_CONTENT" > "$DIR/android/local.properties"
fi

echo "[container-build] gradle $*"
cd "$DIR/android" && exec ./gradlew --no-daemon --max-workers=8 "$@"
