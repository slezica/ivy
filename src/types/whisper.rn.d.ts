declare module 'whisper.rn' {
  export interface TranscribeOptions {
    language?: string
    translate?: boolean
    maxThreads?: number
    maxContext?: number
    maxLen?: number
    tokenTimestamps?: boolean
    wordThold?: number
    offset?: number
    duration?: number
    temperature?: number
    temperatureInc?: number
    beamSize?: number
    bestOf?: number
    prompt?: string
  }

  export interface TranscribeResult {
    result: string
    segments: Array<{
      text: string
      t0: number
      t1: number
    }>
    isAborted: boolean
  }

  export interface TranscribeFileOptions extends TranscribeOptions {
    onProgress?: (progress: number) => void
    onNewSegments?: (result: { nNew: number; totalNNew: number; result: string; segments: TranscribeResult['segments'] }) => void
  }

  export declare class WhisperContext {
    transcribe(filePathOrBase64: string | number, options?: TranscribeFileOptions): {
      stop: () => Promise<void>
      promise: Promise<TranscribeResult>
    }
    release(): Promise<void>
  }

  export interface ContextOptions {
    filePath: string | number
    isBundleAsset?: boolean
    useCoreMLIos?: boolean
    useGpu?: boolean
    useFlashAttn?: boolean
  }

  export function initWhisper(options: ContextOptions): Promise<WhisperContext>
}
