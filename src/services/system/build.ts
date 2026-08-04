import { NativeModules } from 'react-native'

/**
 * Build-variant signal from the native side (see plugins/withIvyBuildTypes.js
 * and modules/ivy BuildInfoModule). Test affordances gate on it so preview and
 * release builds carry zero test surface.
 */

export type BuildVariant = 'debug' | 'maestro' | 'production'

export function getBuildVariant(): BuildVariant {
  // Missing module (Jest, stale native build) safely reads as production
  return NativeModules.BuildInfo?.variant ?? 'production'
}

export function isTestBuild(): boolean {
  return getBuildVariant() !== 'production'
}

/** versionName from the installed package (semver, e.g. "1.5.0"). */
export function getVersionName(): string {
  return NativeModules.BuildInfo?.versionName ?? ''
}

/** Build date stamped at gradle time (yyyy-MM-dd). */
export function getBuildDate(): string {
  return NativeModules.BuildInfo?.buildDate ?? ''
}
