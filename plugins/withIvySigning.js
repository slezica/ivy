// Config plugin: wire Ivy's signing configs into the generated android/app/build.gradle.
//
// Keystores live in credentials/ at the repo root (never committed), so they
// survive `expo prebuild --clean`:
//   - debug:   credentials/debug.keystore (standard android/android debug key)
//   - release: credentials/release.keystore, alias 'ivy', password from $KEYSTORE_PASSWORD
//
// The template ships a debug-only signingConfigs block and signs the release
// buildType with the debug key; this plugin repoints the debug store, adds the
// release signing config, and makes the release buildType use it.
const { withAppBuildGradle } = require('expo/config-plugins')

const RELEASE_SIGNING = [
  '        release {',
  "            storeFile file('../../credentials/release.keystore')",
  "            keyAlias 'ivy'",
  "            storePassword System.getenv('KEYSTORE_PASSWORD')",
  "            keyPassword System.getenv('KEYSTORE_PASSWORD')",
  '        }',
].join('\n')

function apply(contents) {
  if (contents.includes('credentials/release.keystore')) {
    return contents // already applied
  }

  // 1. Repoint the debug keystore at credentials/.
  const debugStore = "storeFile file('debug.keystore')"
  if (!contents.includes(debugStore)) {
    throw new Error('withIvySigning: debug storeFile anchor not found in app/build.gradle')
  }
  contents = contents.replace(debugStore, "storeFile file('../../credentials/debug.keystore')")

  // 2. Add the release signing config after the debug one.
  const debugBlockEnd = /(signingConfigs\s*\{[\s\S]*?keyPassword 'android'\n(\s*)\})/
  if (!debugBlockEnd.test(contents)) {
    throw new Error('withIvySigning: signingConfigs.debug block anchor not found in app/build.gradle')
  }
  contents = contents.replace(debugBlockEnd, `$1\n${RELEASE_SIGNING}`)

  // 3. Sign the release buildType with the release config (the template uses
  //    the debug key; leading comment lines are the template's "Caution!" note).
  const releaseBuildType = /(release\s*\{\s*\n(?:\s*\/\/[^\n]*\n)*\s*)signingConfig signingConfigs\.debug/
  if (!releaseBuildType.test(contents)) {
    throw new Error('withIvySigning: release buildType signingConfig anchor not found in app/build.gradle')
  }
  contents = contents.replace(releaseBuildType, '$1signingConfig signingConfigs.release')

  return contents
}

module.exports = function withIvySigning(config) {
  return withAppBuildGradle(config, (config) => {
    if (config.modResults.language !== 'groovy') {
      throw new Error('withIvySigning: cannot modify a non-groovy app/build.gradle')
    }
    config.modResults.contents = apply(config.modResults.contents)
    return config
  })
}
