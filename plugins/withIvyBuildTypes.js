// Config plugin: custom buildTypes + the build-variant signal.
//
// Build variants and their ivy_build_variant value:
//   debug    → "debug"       dev loop (Metro, __DEV__)
//   maestro  → "maestro"     e2e build: preview clone + test affordances
//   preview  → "production"  standalone testing build, behaves like release
//   release  → "production"  shipping build
//
// The value is an Android string resource: "production" is the default
// (strings.xml), debug/maestro override it via resValue. JS reads it through
// modules/ivy BuildInfoModule — test affordances (e.g. the short sleep-timer
// preset) gate on it, so preview/release carry zero test surface.
const { withAppBuildGradle, withStringsXml, AndroidConfig } = require('expo/config-plugins')

const CUSTOM_BLOCK = [
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
  '        // E2e build for the Maestro suite: a preview clone whose only difference',
  '        // is the variant signal, unlocking test affordances.',
  '        maestro {',
  '            initWith preview',
  '            signingConfig signingConfigs.debug',
  "            matchingFallbacks = ['release', 'debug']",
  "            resValue 'string', 'ivy_build_variant', 'maestro'",
  '        }',
].join('\n')

const DEBUG_RESVALUE = "            resValue 'string', 'ivy_build_variant', 'debug'"

function apply(contents) {
  if (/\n\s*preview\s*\{/.test(contents)) {
    return contents // already applied
  }
  // Anchor on the template's `debug { signingConfig signingConfigs.debug }`
  // block: inject the debug resValue inside it, the custom buildTypes after it.
  const debugBuildType = /(buildTypes\s*\{\s*\n\s*debug\s*\{\s*\n\s*signingConfig signingConfigs\.debug\s*\n)(\s*\})/
  if (!debugBuildType.test(contents)) {
    throw new Error('withIvyBuildTypes: debug buildType anchor not found in app/build.gradle')
  }
  return contents.replace(debugBuildType, `$1${DEBUG_RESVALUE}\n$2\n${CUSTOM_BLOCK}`)
}

module.exports = function withIvyBuildTypes(config) {
  config = withStringsXml(config, (config) => {
    config.modResults = AndroidConfig.Strings.setStringItem(
      [{ $: { name: 'ivy_build_variant', translatable: 'false' }, _: 'production' }],
      config.modResults
    )
    return config
  })

  return withAppBuildGradle(config, (config) => {
    if (config.modResults.language !== 'groovy') {
      throw new Error('withIvyBuildTypes: cannot modify a non-groovy app/build.gradle')
    }
    config.modResults.contents = apply(config.modResults.contents)
    return config
  })
}
