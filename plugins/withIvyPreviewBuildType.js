// Config plugin: add the `preview` buildType to the generated android/app/build.gradle.
const { withAppBuildGradle } = require('expo/config-plugins')

const PREVIEW_BLOCK = [
  '        // Standalone testing build: embedded JS bundle (no Metro), no dev-launcher,',
  '        // debug-signed so it installs over the dev build (and vice versa) without',
  '        // losing app data. Logs still reach logcat (ReactNativeJS).',
  "        // 'release' must come FIRST in the fallbacks: expo-dev-launcher/dev-menu",
  '        // select their no-op stub via the release variant — falling back to their',
  '        // debug variant compiles the full launcher UI in.',
  '        preview {',
  '            initWith debug',
  '            signingConfig signingConfigs.debug',
  '            debuggable false',
  "            matchingFallbacks = ['release', 'debug']",
  '        }',
].join('\n')

function apply(contents) {
  if (/\n\s*preview\s*\{/.test(contents)) {
    return contents // already applied
  }
  // Insert right after the debug buildType (before release), matching the
  // template's `debug { signingConfig signingConfigs.debug }` block.
  const debugBuildType = /(buildTypes\s*\{\s*\n\s*debug\s*\{\s*\n\s*signingConfig signingConfigs\.debug\s*\n(\s*)\})/
  if (!debugBuildType.test(contents)) {
    throw new Error('withIvyPreviewBuildType: debug buildType anchor not found in app/build.gradle')
  }
  return contents.replace(debugBuildType, `$1\n${PREVIEW_BLOCK}`)
}

module.exports = function withIvyPreviewBuildType(config) {
  return withAppBuildGradle(config, (config) => {
    if (config.modResults.language !== 'groovy') {
      throw new Error('withIvyPreviewBuildType: cannot modify a non-groovy app/build.gradle')
    }
    config.modResults.contents = apply(config.modResults.contents)
    return config
  })
}
