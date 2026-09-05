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

/**
 * Test-build override for the Whisper model URL: the maestro build carries an
 * `ivy_whisper_model_url` resource pointing at the toolkit bridge, so e2e runs
 * download a small model from the host instead of 465MB from HuggingFace (and
 * can simulate failures). Null in production builds, whatever the native side
 * reports — zero test surface there.
 */
export function getWhisperModelUrlOverride(): string | null {
  if (!isTestBuild()) return null
  const url = NativeModules.BuildInfo?.whisperModelUrl
  return typeof url === 'string' && url.length > 0 ? url : null
}
