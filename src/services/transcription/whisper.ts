/**
 * Whisper Service
 *
 * On-device speech-to-text using whisper.rn.
 * Downloads and caches the Whisper model on first use.
 */

import { initWhisper, WhisperContext } from 'whisper.rn'
import RNFS from 'react-native-fs'

// =============================================================================
// Constants
// =============================================================================

const MODEL_URL = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny.bin'
const MODEL_FILENAME = 'ggml-tiny.bin'

// =============================================================================
// Service
// =============================================================================

export class WhisperService {
  private context: WhisperContext | null = null
  private initializing: Promise<void> | null = null

  async initialize(): Promise<void> {
    if (this.context) {
      return
    }

    if (this.initializing) {
      return this.initializing
    }

    this.initializing = this.doInitialize()

    try {
      await this.initializing
    } finally {
      this.initializing = null
    }
  }

  isReady(): boolean {
    return this.context !== null
  }

  async transcribe(audioPath: string): Promise<string> {
    if (!this.context) {
      throw new Error('Whisper not initialized')
    }

    console.log('[Whisper] Transcribing:', audioPath)

    const { promise } = this.context.transcribe(audioPath, {
      language: 'en',
    })

    const result = await promise
    const text = result.result.trim()

    console.log('[Whisper] Transcription result:', text)

    return text
  }

  async release(): Promise<void> {
    if (this.context) {
      await this.context.release()
      this.context = null
    }
  }

  // ---------------------------------------------------------------------------
  // Private
  // ---------------------------------------------------------------------------

  private async doInitialize(): Promise<void> {
    try {
      const modelPath = await this.ensureModelDownloaded()

      console.log('[Whisper] Initializing context...')
      this.context = await initWhisper({ filePath: modelPath })
      console.log('[Whisper] Context initialized')
    } catch (error) {
      console.error('[Whisper] Failed to initialize:', error)
      throw error
    }
  }

  private async ensureModelDownloaded(): Promise<string> {
    const modelDir = `${RNFS.DocumentDirectoryPath}/whisper`
    const modelPath = `${modelDir}/${MODEL_FILENAME}`

    const exists = await RNFS.exists(modelPath)
    if (exists) {
      console.log('[Whisper] Model already downloaded')
      return modelPath
    }

    console.log('[Whisper] Downloading model...')

    const dirExists = await RNFS.exists(modelDir)
    if (!dirExists) {
      await RNFS.mkdir(modelDir)
    }

    const result = await RNFS.downloadFile({
      fromUrl: MODEL_URL,
      toFile: modelPath,
      background: false,
      discretionary: false,
    }).promise

    if (result.statusCode !== 200) {
      throw new Error(`Failed to download model: ${result.statusCode}`)
    }

    console.log('[Whisper] Model downloaded successfully')
    return modelPath
  }
}

// =============================================================================
// Singleton
// =============================================================================

export const whisperService = new WhisperService()
