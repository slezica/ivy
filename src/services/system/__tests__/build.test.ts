import { NativeModules } from 'react-native'
import { getBuildVariant, isTestBuild, getWhisperModelUrlOverride } from '../build'

describe('build info', () => {
  const setBuildInfo = (info: Record<string, string> | undefined) => {
    (NativeModules as any).BuildInfo = info
  }
  afterEach(() => setBuildInfo(undefined))

  it('reads a missing native module as production', () => {
    expect(getBuildVariant()).toBe('production')
    expect(isTestBuild()).toBe(false)
  })

  it('exposes the whisper model override on test builds only', () => {
    setBuildInfo({ variant: 'maestro', whisperModelUrl: 'http://127.0.0.1:7799/model' })
    expect(getWhisperModelUrlOverride()).toBe('http://127.0.0.1:7799/model')

    setBuildInfo({ variant: 'production', whisperModelUrl: 'http://127.0.0.1:7799/model' })
    expect(getWhisperModelUrlOverride()).toBeNull()

    setBuildInfo({ variant: 'maestro', whisperModelUrl: '' })
    expect(getWhisperModelUrlOverride()).toBeNull()
  })
})
