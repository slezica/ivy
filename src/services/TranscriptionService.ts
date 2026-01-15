import { DatabaseService, Clip } from './DatabaseService'
import { whisperService } from './WhisperService'
import { audioExtractionService } from './AudioExtractionService'

type TranscriptionCallback = (clipId: number, transcription: string) => void

class TranscriptionService {
  private db: DatabaseService
  private queue: number[] = []
  private processing = false
  private onTranscriptionComplete: TranscriptionCallback | null = null

  constructor() {
    this.db = new DatabaseService()
  }

  setCallback(callback: TranscriptionCallback): void {
    this.onTranscriptionComplete = callback
  }

  async start(): Promise<void> {
    console.log('[Transcription] Starting service...')

    // Initialize Whisper (downloads model if needed)
    try {
      await whisperService.initialize()
    } catch (error) {
      console.error('[Transcription] Failed to initialize Whisper:', error)
      return
    }

    // Queue all clips that need transcription
    const pendingClips = this.db.getClipsNeedingTranscription()
    console.log('[Transcription] Found', pendingClips.length, 'clips needing transcription')

    for (const clip of pendingClips) {
      this.queue.push(clip.id)
    }

    // Start processing
    this.processQueue()
  }

  queueClip(clipId: number): void {
    console.log('[Transcription] Queueing clip:', clipId)
    this.queue.push(clipId)
    this.processQueue()
  }

  private async processQueue(): Promise<void> {
    if (this.processing || this.queue.length === 0) {
      return
    }

    if (!whisperService.isReady()) {
      console.log('[Transcription] Whisper not ready, skipping queue processing')
      return
    }

    this.processing = true

    while (this.queue.length > 0) {
      const clipId = this.queue.shift()!
      await this.processClip(clipId)
    }

    this.processing = false
  }

  private async processClip(clipId: number): Promise<void> {
    console.log('[Transcription] Processing clip:', clipId)

    // Get clip from database
    const clips = this.db.getClipsNeedingTranscription()
    const clip = clips.find((c) => c.id === clipId)

    if (!clip) {
      console.log('[Transcription] Clip not found or already transcribed:', clipId)
      return
    }

    let audioPath: string | null = null

    try {
      // Extract audio for transcription
      audioPath = await audioExtractionService.extractForTranscription(
        clip,
        clip.file_uri
      )

      // Transcribe
      const transcription = await whisperService.transcribe(audioPath)

      // Update database
      this.db.updateClipTranscription(clipId, transcription)

      // Notify callback
      if (this.onTranscriptionComplete) {
        this.onTranscriptionComplete(clipId, transcription)
      }

      console.log('[Transcription] Completed clip:', clipId, '| Result:', transcription)
    } catch (error) {
      console.error('[Transcription] Failed to process clip:', clipId, error)
      // Leave transcription as null, will retry on next app start
    } finally {
      // Clean up temporary audio file
      if (audioPath) {
        await audioExtractionService.cleanup(audioPath)
      }
    }
  }
}

export const transcriptionService = new TranscriptionService()
