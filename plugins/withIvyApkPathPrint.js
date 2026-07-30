// Config plugin: print the absolute path of every produced APK/AAB at the end
// of each assemble/bundle task, so build commands end with the artifact
// location instead of requiring a manual `fd -I apk$` afterwards.
const { withAppBuildGradle } = require('expo/config-plugins')

const GRADLE_BLOCK = [
  '',
  '// Injected by withIvyApkPathPrint — print APK/AAB output paths after assembly.',
  'android.applicationVariants.all { variant ->',
  '    variant.assembleProvider.configure {',
  '        it.doLast {',
  '            variant.outputs.each { output ->',
  '                println "APK: ${output.outputFile.absolutePath}"',
  '            }',
  '        }',
  '    }',
  '    tasks.matching { it.name == "bundle${variant.name.capitalize()}" }.configureEach { task ->',
  '        task.doLast {',
  '            def aab = new File(layout.buildDirectory.get().asFile, "outputs/bundle/${variant.name}/app-${variant.name}.aab")',
  '            println "AAB: ${aab.absolutePath}"',
  '        }',
  '    }',
  '}',
].join('\n')

function apply(contents) {
  if (contents.includes('withIvyApkPathPrint')) {
    return contents // already applied
  }
  return contents + '\n' + GRADLE_BLOCK + '\n'
}

module.exports = function withIvyApkPathPrint(config) {
  return withAppBuildGradle(config, (config) => {
    if (config.modResults.language !== 'groovy') {
      throw new Error('withIvyApkPathPrint: cannot modify a non-groovy app/build.gradle')
    }
    config.modResults.contents = apply(config.modResults.contents)
    return config
  })
}
