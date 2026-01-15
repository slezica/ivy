import { initWhisper, WhisperContext } from 'whisper.rn'
import RNFS from 'react-native-fs'

const MODEL_URL = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny.bin'
const MODEL_FILENAME = 'ggml-tiny.bin'

class WhisperService {
  private context: WhisperContext | null = null
  private initializing: Promise<void> | null = null

  private getModelDir(): string {
    return `${RNFS.DocumentDirectoryPath}/whisper`
  }

  private getModelPath(): string {
    return `${this.getModelDir()}/${MODEL_FILENAME}`
  }

  private async downloadModel(): Promise<string> {
    const modelDir = this.getModelDir()
    const modelPath = this.getModelPath()

    // Check if model already exists
    const exists = await RNFS.exists(modelPath)
    if (exists) {
      console.log('[Whisper] Model already downloaded')
      return modelPath
    }

    console.log('[Whisper] Downloading model...')

    // Create directory if needed
    const dirExists = await RNFS.exists(modelDir)
    if (!dirExists) {
      await RNFS.mkdir(modelDir)
    }

    // Download the model
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

  async initialize(): Promise<void> {
    // If already initialized, return
    if (this.context) {
      return
    }

    // If initialization is in progress, wait for it
    if (this.initializing) {
      return this.initializing
    }

    this.initializing = this._doInitialize()

    try {
      await this.initializing
    } finally {
      this.initializing = null
    }
  }

  private async _doInitialize(): Promise<void> {
    try {
      const modelPath = await this.downloadModel()

      console.log('[Whisper] Initializing context...')
      this.context = await initWhisper({ filePath: modelPath })
      console.log('[Whisper] Context initialized')
    } catch (error) {
      console.error('[Whisper] Failed to initialize:', error)
      throw error
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
}

export const whisperService = new WhisperService()
