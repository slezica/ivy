// Config plugin: derive versionName from package.json at build time.
//
// package.json is the version of record (bumped on release); app.json's
// `version` is not maintained. The generated build.gradle hardcodes the
// app.json value, so replace it with a build-time read of package.json —
// this keeps versionName correct even when gradle runs without a fresh
// prebuild (e.g. `npm run build:preview`).
const { withAppBuildGradle } = require('expo/config-plugins')

function apply(contents) {
  if (contents.includes('appVersionName')) {
    return contents // already applied
  }
  const projectRootDef = /(\ndef projectRoot = [^\n]+\n)/
  if (!projectRootDef.test(contents)) {
    throw new Error('withIvyVersionName: projectRoot anchor not found in app/build.gradle')
  }
  contents = contents.replace(
    projectRootDef,
    '$1\ndef appVersionName = new groovy.json.JsonSlurper().parseText(file("$projectRoot/package.json").text).version\n'
  )
  const versionName = /versionName ("[^"]*"|'[^']*')/
  if (!versionName.test(contents)) {
    throw new Error('withIvyVersionName: versionName anchor not found in app/build.gradle')
  }
  return contents.replace(versionName, 'versionName appVersionName')
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
