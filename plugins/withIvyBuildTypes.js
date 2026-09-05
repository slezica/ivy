// Config plugin: custom buildTypes + the build-variant signal + the maestro
// build's test plumbing.
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
//
// Maestro-only plumbing for the e2e suite (docs/2026-09-05-r8-obfuscation.md):
//   - ivy_whisper_model_url resValue: the Whisper model downloads from the
//     toolkit bridge (reached through `adb reverse`, so the device-side port is
//     fixed) instead of HuggingFace. Only the maestro build has the resource.
//   - usesCleartextTraffic: that URL is plain http on loopback, which Android
//     blocks by default (no localhost exemption). A manifest placeholder turns
//     it on for debug (matching Expo's own debug manifest) and maestro; every
//     other variant resolves to "false", the platform default since targetSdk 28.
const { withAppBuildGradle, withAndroidManifest, withStringsXml, AndroidConfig } = require('expo/config-plugins')

// Device-side address of the toolkit bridge's model endpoint (bin/ivy.ts maps
// it to the bridge's actual port with `adb reverse`). Exported for the toolkit.
const BRIDGE_DEVICE_PORT = 7799
const WHISPER_MODEL_URL = `http://127.0.0.1:${BRIDGE_DEVICE_PORT}/model`

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
  '            // R8 like release: the template wires minify into release {} only and',
  '            // initWith copies debug\'s false. Same switch as release so the tested',
  '            // (maestro) bytecode is the shipped bytecode (docs/2026-09-05-r8-obfuscation.md).',
  '            minifyEnabled enableMinifyInReleaseBuilds',
  '            proguardFiles getDefaultProguardFile("proguard-android.txt"), "proguard-rules.pro"',
  '        }',
  '        // E2e build for the Maestro suite: a preview clone whose only difference',
  '        // is the variant signal, unlocking test affordances. NOT debuggable:',
  '        // debuggable true flips the CMake config to Debug, which references',
  "        // debug-only RN symbols while matchingFallbacks links the release",
  '        // prefab — undefined symbols at link time. Tooling that needs DB',
  '        // access on this variant uses adb root instead (emulator-only).',
  '        maestro {',
  '            initWith preview',
  '            signingConfig signingConfigs.debug',
  "            matchingFallbacks = ['release', 'debug']",
  '        }',
].join('\n')

// resValues are set AFTER the buildTypes declarations: initWith copies them,
// so setting them inside the blocks makes maestro inherit debug's value via
// preview and replace it (AGP "value is being replaced" warning).
const RESVALUE_BLOCK = [
  '',
  "android.buildTypes.debug.resValue 'string', 'ivy_build_variant', 'debug'",
  "android.buildTypes.maestro.resValue 'string', 'ivy_build_variant', 'maestro'",
  `android.buildTypes.maestro.resValue 'string', 'ivy_whisper_model_url', '${WHISPER_MODEL_URL}'`,
  "android.defaultConfig.manifestPlaceholders.ivyCleartext = 'false'",
  "android.buildTypes.debug.manifestPlaceholders.ivyCleartext = 'true'",
  "android.buildTypes.maestro.manifestPlaceholders.ivyCleartext = 'true'",
].join('\n')

function apply(contents) {
  if (/\n\s*preview\s*\{/.test(contents)) {
    return contents // already applied
  }
  // Anchor on the template's `debug { signingConfig signingConfigs.debug }`
  // block: inject the custom buildTypes after it.
  const debugBuildType = /(buildTypes\s*\{\s*\n\s*debug\s*\{\s*\n\s*signingConfig signingConfigs\.debug\s*\n\s*\})/
  if (!debugBuildType.test(contents)) {
    throw new Error('withIvyBuildTypes: debug buildType anchor not found in app/build.gradle')
  }
  return contents.replace(debugBuildType, `$1\n${CUSTOM_BLOCK}`) + RESVALUE_BLOCK + '\n'
}

module.exports = function withIvyBuildTypes(config) {
  config = withStringsXml(config, (config) => {
    config.modResults = AndroidConfig.Strings.setStringItem(
      [{ $: { name: 'ivy_build_variant', translatable: 'false' }, _: 'production' }],
      config.modResults
    )
    return config
  })

  config = withAndroidManifest(config, (config) => {
    const app = AndroidConfig.Manifest.getMainApplicationOrThrow(config.modResults)
    app.$['android:usesCleartextTraffic'] = '${ivyCleartext}'
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

module.exports.BRIDGE_DEVICE_PORT = BRIDGE_DEVICE_PORT
module.exports.WHISPER_MODEL_URL = WHISPER_MODEL_URL
