// Config plugin: app-level packaging options. libffmpeg.zip.so is a zip
// masquerading as a shared library (youtubedl-android packaging trick, see
// docs/CLIPS.md) — llvm-strip prints a scary-but-harmless "error: not a valid
// object file" for it on every build. Skip stripping it.
const { withAppBuildGradle } = require('expo/config-plugins')

const GRADLE_BLOCK = [
  '',
  '// Injected by withIvyPackaging — libffmpeg.zip.so is a zip, not an ELF; do not strip.',
  "android.packaging.jniLibs.keepDebugSymbols.add('**/libffmpeg.zip.so')",
].join('\n')

function apply(contents) {
  if (contents.includes('withIvyPackaging')) {
    return contents // already applied
  }
  return contents + '\n' + GRADLE_BLOCK + '\n'
}

module.exports = function withIvyPackaging(config) {
  return withAppBuildGradle(config, (config) => {
    if (config.modResults.language !== 'groovy') {
      throw new Error('withIvyPackaging: cannot modify a non-groovy app/build.gradle')
    }
    config.modResults.contents = apply(config.modResults.contents)
    return config
  })
}
