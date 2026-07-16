// Config plugin: derive versionName AND versionCode from package.json at build time.
//
// package.json is the SINGLE version of record — bump it on release and both
// android values follow. app.json's `version` is not maintained. The generated
// build.gradle hardcodes template values, so replace them with a build-time
// read of package.json — this keeps versions correct even when gradle runs
// without a fresh prebuild (e.g. `npm run build:preview`).
//
// versionCode = major*10000 + minor*100 + patch (monotonic while minor/patch
// stay < 100); Play requires it to strictly increase across uploads.
const { withAppBuildGradle } = require('expo/config-plugins')

// Each step guards on its own output (not a blanket "already applied" check),
// so a prebuild without --clean repairs a build.gradle where an earlier plugin
// version applied only some of the replacements.
function apply(contents) {
  if (!contents.includes('def appVersionCode')) {
    const projectRootDef = /(\ndef projectRoot = [^\n]+\n)/
    if (!projectRootDef.test(contents)) {
      throw new Error('withIvyVersionName: projectRoot anchor not found in app/build.gradle')
    }
    contents = contents.replace(
      projectRootDef,
      '$1\ndef appVersionName = new groovy.json.JsonSlurper().parseText(file("$projectRoot/package.json").text).version\n' +
      'def appSemver = appVersionName.split(\'\\\\.\').collect { it.toInteger() }\n' +
      'def appVersionCode = appSemver[0] * 10000 + appSemver[1] * 100 + appSemver[2]\n'
    )
  }
  if (!contents.includes('versionName appVersionName')) {
    const versionName = /versionName ("[^"]*"|'[^']*')/
    if (!versionName.test(contents)) {
      throw new Error('withIvyVersionName: versionName anchor not found in app/build.gradle')
    }
    contents = contents.replace(versionName, 'versionName appVersionName')
  }
  if (!contents.includes('versionCode appVersionCode')) {
    const versionCode = /versionCode \d+/
    if (!versionCode.test(contents)) {
      throw new Error('withIvyVersionName: versionCode anchor not found in app/build.gradle')
    }
    contents = contents.replace(versionCode, 'versionCode appVersionCode')
  }
  return contents
}

module.exports = function withIvyVersionName(config) {
  return withAppBuildGradle(config, (config) => {
    if (config.modResults.language !== 'groovy') {
      throw new Error('withIvyVersionName: cannot modify a non-groovy app/build.gradle')
    }
    config.modResults.contents = apply(config.modResults.contents)
    return config
  })
}
