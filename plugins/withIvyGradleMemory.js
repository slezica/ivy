// Raises Gradle JVM memory. The default (-Xmx2048m, 512m metaspace) is not
// enough to sign the release bundle: the pre-sign AAB is ~600MB (ffmpeg for
// four ABIs), and FinalizeBundleTask runs bundletool in-daemon.
const { withGradleProperties } = require('expo/config-plugins')

const JVM_ARGS = '-Xmx4096m -XX:MaxMetaspaceSize=1024m'

module.exports = function withIvyGradleMemory(config) {
  return withGradleProperties(config, (config) => {
    const props = config.modResults
    const existing = props.find(
      (item) => item.type === 'property' && item.key === 'org.gradle.jvmargs'
    )
    if (existing) {
      existing.value = JVM_ARGS
    } else {
      props.push({ type: 'property', key: 'org.gradle.jvmargs', value: JVM_ARGS })
    }
    return config
  })
}
