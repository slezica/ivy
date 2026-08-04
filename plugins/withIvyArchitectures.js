// Config plugin: default reactNativeArchitectures to arm64-v8a only.
//
// The vendored ffmpeg runtime (modules/ivy jniLibs) ships arm64-v8a binaries
// only — building other ABIs would produce installs whose clip slicing and
// chapter extraction crash. arm64 covers every real-world device; the
// Mac-hosted emulator is arm64 too. `build --arch` (-PreactNativeArchitectures
// on the command line) still overrides this default.
const { withGradleProperties } = require('expo/config-plugins')

module.exports = function withIvyArchitectures(config) {
  return withGradleProperties(config, (config) => {
    const props = config.modResults.filter(
      (item) => !(item.type === 'property' && item.key === 'reactNativeArchitectures')
    )
    props.push({ type: 'property', key: 'reactNativeArchitectures', value: 'arm64-v8a' })
    config.modResults = props
    return config
  })
}
