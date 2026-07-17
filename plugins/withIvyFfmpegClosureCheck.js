// Config plugin: make the build FAIL if the bundled FFmpeg's native dependency
// closure won't link on device. Runs scripts/check-ffmpeg-closure.js against the
// built APK as a finalizer of assembleRelease (the shipping gate) and
// assemblePreview (continuously verified — that's the variant we build here).
//
// Why a build gate and not a manual step: the original clip-add crash was a
// human-process gap (a smoke test run on the wrong install state). A guard that
// only runs when someone remembers reintroduces exactly that gap. See
// docs/CLIPS.md "Vendored shared libs" and docs/2026-07-17-ffmpeg-native-unpacking.md.
//
// Requires `node`, `unzip`, and the NDK's llvm-readelf on the build machine —
// all present in any environment that can build the native app.
const { withAppBuildGradle } = require('expo/config-plugins')

const GRADLE_BLOCK = [
  '',
  '// Injected by withIvyFfmpegClosureCheck — fail the build if libffmpeg.so',
  "// won't dynamically link on device (scripts/check-ffmpeg-closure.js).",
  'tasks.register("checkFfmpegClosure") {',
  '    doLast {',
  '        def apkDirs = ["release", "preview"]',
  '            .collect { layout.buildDirectory.dir("outputs/apk/$it").get().asFile }',
  '            .findAll { it.exists() }',
  '        def apks = apkDirs.collectMany { it.listFiles().findAll { f -> f.name.endsWith(".apk") } }',
  '        if (apks.isEmpty()) throw new GradleException("checkFfmpegClosure: no APK found in " + apkDirs)',
  '        apks.each { apk ->',
  '            exec {',
  '                environment "ANDROID_HOME", android.sdkDirectory.absolutePath',
  '                commandLine "node", "${rootDir}/../scripts/check-ffmpeg-closure.js", apk.absolutePath',
  '            }',
  '        }',
  '    }',
  '}',
  'tasks.matching { it.name == "assembleRelease" || it.name == "assemblePreview" }',
  '    .configureEach { finalizedBy("checkFfmpegClosure") }',
].join('\n')

function apply(contents) {
  if (contents.includes('checkFfmpegClosure')) {
    return contents // already applied
  }
  return contents + '\n' + GRADLE_BLOCK + '\n'
}

module.exports = function withIvyFfmpegClosureCheck(config) {
  return withAppBuildGradle(config, (config) => {
    if (config.modResults.language !== 'groovy') {
      throw new Error('withIvyFfmpegClosureCheck: cannot modify a non-groovy app/build.gradle')
    }
    config.modResults.contents = apply(config.modResults.contents)
    return config
  })
}
