/**
 * Whisper Service
 *
 * On-device speech-to-text using whisper.rn.
 * Downloads and caches the Whisper model on first use.
 *
 * Accepts any audio format supported by react-native-audio-api (mp3, m4a, wav, etc.)
 * and converts internally to 16kHz mono WAV as required by whisper.cpp.
 */

import { initWhisper, WhisperContext } from 'whisper.rn'
import { decodeAudioData } from 'react-native-audio-api'
import RNFS from 'react-native-fs'

// =============================================================================
// Constants
// =============================================================================

const MODEL_URL = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin'
const MODEL_FILENAME = 'ggml-small.bin'

// Whisper requires 16kHz mono 16-bit PCM WAV
const WHISPER_SAMPLE_RATE = 16000
const WHISPER_CHANNELS = 1
const WHISPER_BITS_PER_SAMPLE = 16

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

    // Convert to Whisper-compatible format (16kHz mono WAV)
    const wavPath = await this.convertToWav(audioPath)

    try {
      const { promise } = this.context.transcribe(wavPath, {
        language: 'en',
      })

      const result = await promise
      const text = result.result.trim()

      console.log('[Whisper] Transcription result:', text)

      return text
    } finally {
      // Clean up temp WAV file
      await RNFS.unlink(wavPath).catch(() => {})
    }
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

  private async convertToWav(audioPath: string): Promise<string> {
    console.log('[Whisper] Converting to WAV:', audioPath)

    // Decode audio to 16kHz PCM
    const audioBuffer = await decodeAudioData(audioPath, WHISPER_SAMPLE_RATE)

    // Get mono channel (mix down if stereo)
    const pcmFloat = audioBuffer.numberOfChannels > 1
      ? this.mixToMono(audioBuffer)
      : audioBuffer.getChannelData(0)

    // Convert Float32 [-1, 1] to Int16 [-32768, 32767]
    const pcmInt16 = new Int16Array(pcmFloat.length)
    for (let i = 0; i < pcmFloat.length; i++) {
      const clamped = Math.max(-1, Math.min(1, pcmFloat[i]))
      pcmInt16[i] = clamped < 0 ? clamped * 32768 : clamped * 32767
    }

    // Build WAV file
    const wavData = this.createWavFile(pcmInt16)

    // Write to temp file
    const wavPath = `${RNFS.CachesDirectoryPath}/whisper_${Date.now()}.wav`
    await RNFS.writeFile(wavPath, this.arrayBufferToBase64(wavData), 'base64')

    console.log('[Whisper] Converted to WAV:', wavPath)
    return wavPath
  }

  private mixToMono(audioBuffer: { numberOfChannels: number; getChannelData: (channel: number) => Float32Array }): Float32Array {
    const length = audioBuffer.getChannelData(0).length
    const mono = new Float32Array(length)

    for (let ch = 0; ch < audioBuffer.numberOfChannels; ch++) {
      const channelData = audioBuffer.getChannelData(ch)
      for (let i = 0; i < length; i++) {
        mono[i] += channelData[i]
      }
    }

    // Average the channels
    const scale = 1 / audioBuffer.numberOfChannels
    for (let i = 0; i < length; i++) {
      mono[i] *= scale
    }

    return mono
  }

  private createWavFile(pcmData: Int16Array): ArrayBuffer {
    const dataSize = pcmData.length * 2 // 2 bytes per Int16 sample
    const buffer = new ArrayBuffer(44 + dataSize)
    const view = new DataView(buffer)

    // RIFF header
    this.writeString(view, 0, 'RIFF')
    view.setUint32(4, 36 + dataSize, true) // file size - 8
    this.writeString(view, 8, 'WAVE')

    // fmt chunk
    this.writeString(view, 12, 'fmt ')
    view.setUint32(16, 16, true) // chunk size
    view.setUint16(20, 1, true) // PCM format
    view.setUint16(22, WHISPER_CHANNELS, true)
    view.setUint32(24, WHISPER_SAMPLE_RATE, true)
    view.setUint32(28, WHISPER_SAMPLE_RATE * WHISPER_CHANNELS * (WHISPER_BITS_PER_SAMPLE / 8), true) // byte rate
    view.setUint16(32, WHISPER_CHANNELS * (WHISPER_BITS_PER_SAMPLE / 8), true) // block align
    view.setUint16(34, WHISPER_BITS_PER_SAMPLE, true)

    // data chunk
    this.writeString(view, 36, 'data')
    view.setUint32(40, dataSize, true)

    // PCM samples
    const pcmOffset = 44
    for (let i = 0; i < pcmData.length; i++) {
      view.setInt16(pcmOffset + i * 2, pcmData[i], true)
    }

    return buffer
  }

  private writeString(view: DataView, offset: number, str: string): void {
    for (let i = 0; i < str.length; i++) {
      view.setUint8(offset + i, str.charCodeAt(i))
    }
  }

  private arrayBufferToBase64(buffer: ArrayBuffer): string {
    const bytes = new Uint8Array(buffer)
    let binary = ''
    for (let i = 0; i < bytes.length; i++) {
      binary += String.fromCharCode(bytes[i])
    }
    return btoa(binary)
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

