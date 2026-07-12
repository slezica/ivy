// Config plugin: arch-aware hermesc path in the generated android/app/build.gradle.
//
// On arm64 Linux (the build container) the React Native gradle plugin cannot
// resolve the %OS-BIN% placeholder to a hermesc binary; the x86_64 linux binary
// runs fine under emulation, so point hermesCommand at it explicitly there.
// No effect on macOS builds.
const { withAppBuildGradle } = require('expo/config-plugins')

const HERMES_FIX = [
  '    // On arm64 Linux (build container) the RN plugin can\'t resolve %OS-BIN%; the',
  '    // x86_64 linux binary runs fine under emulation. No effect on macOS builds.',
  "    def hermesOsBin = (System.getProperty('os.name').toLowerCase().contains('linux') && System.getProperty('os.arch') == 'aarch64') ? 'linux64-bin' : '%OS-BIN%'",
  '    hermesCommand = new File(["node", "--print", "require.resolve(\'react-native/package.json\')"].execute(null, rootDir).text.trim()).getParentFile().getAbsolutePath() + "/sdks/hermesc/${hermesOsBin}/hermesc"',
].join('\n')

function apply(contents) {
  if (contents.includes('hermesOsBin')) {
    return contents // already applied
  }
  // Replace the template's hermesCommand assignment (hardcoded %OS-BIN%).
  const hermesCommandLine = /^\s*hermesCommand = .*%OS-BIN%\/hermesc"$/m
  if (!hermesCommandLine.test(contents)) {
    throw new Error('withIvyHermesFix: hermesCommand anchor not found in app/build.gradle')
  }
  return contents.replace(hermesCommandLine, HERMES_FIX)
}

module.exports = function withIvyHermesFix(config) {
  return withAppBuildGradle(config, (config) => {
    if (config.modResults.language !== 'groovy') {
      throw new Error('withIvyHermesFix: cannot modify a non-groovy app/build.gradle')
    }
    config.modResults.contents = apply(config.modResults.contents)
    return config
  })
}
