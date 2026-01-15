import { create } from 'zustand'

import {
  AudioPlayerService,
  DatabaseService,
  FilePickerService,
  FileStorageService,
  AudioMetadataService,
  AudioSlicerService,
  SharingService,
  transcriptionService,
  databaseService,
  audioSlicerService,
} from '../services'

import type { PickedFile, Clip, ClipWithFile, AudioFile } from '../services'


const SKIP_FORWARD_MS = 25 * 1000
const SKIP_BACKWARD_MS = 30 * 1000
const DEFAULT_CLIP_DURATION_MS = 20 * 1000


type PlayerStatus = 'adding' | 'loading' | 'paused' | 'playing'

interface PlayerState {
  status: PlayerStatus
  position: number
  duration: number
  file: AudioFile | null
  ownerId: string | null  // ID of component that last took control
}

/**
 * Context for playback actions. Components must specify which file
 * and position they want to play/seek. This prevents "accidents" where
 * a component unknowingly affects another component's playback.
 */
interface PlaybackContext {
  fileUri: string
  position: number
  ownerId?: string  // ID of component taking control (optional)
}

interface AppState {
  // State
  player: PlayerState
  clips: Record<number, ClipWithFile>
  files: Record<string, AudioFile>

  // Actions
  loadFile: (pickedFile: PickedFile) => Promise<void>
  loadFileWithUri: (uri: string, name: string) => Promise<void>
  loadFileWithPicker: () => Promise<void>
  fetchFiles: () => void
  fetchAllClips: () => void
  play: (context?: PlaybackContext) => Promise<void>
  pause: () => Promise<void>
  seek: (context: PlaybackContext) => Promise<void>
  skipForward: () => Promise<void>
  skipBackward: () => Promise<void>
  addClip: (note: string) => Promise<void>
  updateClip: (id: number, updates: { note?: string; start?: number; duration?: number }) => void
  updateClipTranscription: (id: number, transcription: string) => void
  deleteClip: (id: number) => void
  jumpToClip: (clipId: number) => Promise<void>
  shareClip: (clipId: number) => Promise<void>

  // Dev tools
  __DEV_resetApp: () => Promise<void>
}


export const useStore = create<AppState>((set, get) => {
  // ---------------------------------------------------------------------------
  // Initialize services
  // ---------------------------------------------------------------------------

  // Use shared singletons for services that need to be accessed from multiple places
  const dbService = databaseService
  const slicerService = audioSlicerService

  // Create local instances for services only used by the store
  const filePickerService = new FilePickerService()
  const fileStorageService = new FileStorageService()
  const metadataService = new AudioMetadataService()

  const sharingService = new SharingService({
    slicer: slicerService,
  })

  const audioService = new AudioPlayerService({
    onPlaybackStatusChange: (status) => {
      set((state) => ({
        player: {
          ...state.player,
          // Only update status if not currently in a transitional state
          status: (state.player.status === 'loading' || state.player.status === 'adding')
            ? state.player.status
            : status.status,
          position: status.position,
          duration: status.duration,
        },
      }))

      // Update file position in database
      // Only if we have a file and valid position
      const { player } = get()
      if (player.file && status.position >= 0 && status.duration > 0) {
        dbService.updateFilePosition(player.file.uri, status.position)
      }
    },
  })

  // Set up transcription callback to update store when transcription completes
  transcriptionService.setCallback((clipId, transcription) => {
    const { clips } = get()
    if (clips[clipId]) {
      set((state) => ({
        clips: {
          ...state.clips,
          [clipId]: {
            ...state.clips[clipId],
            transcription,
            updated_at: Date.now(),
          },
        },
      }))
    }
  })

  return {
    // Initial state
    player: {
      status: 'paused',
      position: 0,
      duration: 0,
      file: null,
      ownerId: null,
    },
    clips: {},
    files: {},

    // Actions (below)
    loadFileWithPicker,
    loadFile,
    loadFileWithUri,
    fetchFiles,
    fetchAllClips,
    play,
    pause,
    seek,
    skipForward,
    skipBackward,
    addClip,
    deleteClip,
    updateClip,
    updateClipTranscription,
    jumpToClip,
    shareClip,
    __DEV_resetApp
  }

  function fetchFiles(): void {
    const allFiles = dbService.getAllFiles()

    // Update files mapping in store
    const filesMap = allFiles.reduce((acc, file) => {
      acc[file.uri] = file
      return acc
    }, {} as Record<string, AudioFile>)

    set({ files: filesMap })
  }

  function fetchAllClips(): void {
    const allClips = dbService.getAllClips()

    // Update clips mapping in store
    const clipsMap = allClips.reduce((acc, clip) => {
      acc[clip.id] = clip
      return acc
    }, {} as Record<number, ClipWithFile>)

    set({ clips: clipsMap })
  }

  async function loadFileWithUri(uri: string, name: string) {
    await get().loadFile({ uri, name })
  }

  async function loadFileWithPicker() {
    const pickedFile = await filePickerService.pickAudioFile()
    if (pickedFile) {
      await get().loadFile(pickedFile)
    }
  }

  async function loadFile(pickedFile: PickedFile) {
    try {
      // Step 1: Copy file to app storage if needed
      let localUri: string
      let audioFile = dbService.getFile(pickedFile.uri)
      let isNewFile = false

      if (audioFile && await fileStorageService.fileExists(audioFile.uri)) {
        // Already have a local copy - use it
        localUri = audioFile.uri
        console.log('Using existing local file:', localUri)
      } else {
        // Need to copy file to app storage
        console.log('Copying file to app storage from:', pickedFile.uri)
        set((state) => ({
          player: { ...state.player, status: 'adding' },
        }))

        localUri = await fileStorageService.copyToAppStorage(pickedFile.uri, pickedFile.name)
        console.log('File copied to:', localUri)
        isNewFile = true
      }

      // Step 2: Read metadata (only for new files, during 'adding' phase)
      let metadata: { title: string | null; artist: string | null; artwork: string | null } = {
        title: null,
        artist: null,
        artwork: null,
      }
      if (isNewFile) {
        console.log('Reading metadata from:', localUri)
        metadata = await metadataService.readMetadata(localUri)
        console.log('Metadata read:', metadata)
      }

      // Verify file exists before loading
      const exists = await fileStorageService.fileExists(localUri)
      console.log('Local file exists check:', exists, localUri)
      if (!exists) {
        throw new Error(`Local file does not exist: ${localUri}`)
      }

      // Step 3: Load audio from local URI
      set((state) => ({
        player: { ...state.player, status: 'loading' },
      }))

      console.log('Loading audio from:', localUri)
      const duration = await audioService.load(localUri)
      console.log('Audio loaded successfully, duration:', duration)

      // Step 4: Save/update file record in database
      // Save local URI as 'uri' (what we actually use) and original as 'original_uri'
      if (!audioFile) {
        dbService.upsertFile(
          localUri,
          pickedFile.name,
          duration,
          0,
          pickedFile.uri,
          metadata.title,
          metadata.artist,
          metadata.artwork
        )
        audioFile = dbService.getFile(localUri)
      } else {
        // Update existing record (preserve existing metadata if not reading new)
        dbService.upsertFile(
          localUri,
          pickedFile.name,
          duration,
          audioFile.position,
          pickedFile.uri,
          isNewFile ? metadata.title : audioFile.title,
          isNewFile ? metadata.artist : audioFile.artist,
          isNewFile ? metadata.artwork : audioFile.artwork
        )
        audioFile = dbService.getFile(localUri)
      }

      if (!audioFile) {
        throw new Error('Failed to create file record')
      }

      // Load all clips from all files
      fetchAllClips()

      // Update state (keep status as 'loading' until play starts)
      set((state) => ({
        player: {
          ...state.player,
          position: audioFile.position,
          duration,
          file: audioFile,
        },
      }))

      // Seek to saved position
      if (audioFile.position > 0) {
        await audioService.seek(audioFile.position)
      }

      // Auto-play after loading (this will set status to 'playing')
      await get().play()
    } catch (error) {
      console.error(error)
      // Reset loading state on error
      set((state) => ({
        player: { ...state.player, status: 'paused' },
      }))
      throw error
    }
  }

  async function play(context?: PlaybackContext) {
    try {
      // If context provided, may need to load file and seek first
      if (context) {
        const { player } = get()
        const isFileSame = player.file?.uri === context.fileUri

        if (!isFileSame) {
          // Need to load a different file
          const fileRecord = dbService.getFile(context.fileUri)
          if (!fileRecord) {
            throw new Error(`File not found in library: ${context.fileUri}`)
          }

          set((state) => ({
            player: {
              ...state.player,
              status: 'loading',
              ...(context.ownerId !== undefined && { ownerId: context.ownerId }),
            },
          }))

          const duration = await audioService.load(context.fileUri)

          set((state) => ({
            player: {
              ...state.player,
              file: fileRecord,
              duration,
              position: context.position,
            },
          }))

          await audioService.seek(context.position)
        } else if (player.position !== context.position) {
          // Same file, different position - just seek
          await audioService.seek(context.position)
          set((state) => ({
            player: { ...state.player, position: context.position },
          }))
        }

        // Set status to playing, and owner if provided
        set((state) => ({
          player: {
            ...state.player,
            status: 'playing',
            ...(context.ownerId !== undefined && { ownerId: context.ownerId }),
          },
        }))
      } else {
        // No context - just resume, keep existing owner
        set((state) => ({
          player: { ...state.player, status: 'playing' },
        }))
      }

      await audioService.play()
    } catch (error) {
      console.error('Error playing audio:', error)
      set((state) => ({
        player: { ...state.player, status: 'paused' },
      }))
      throw error
    }
  }

  async function pause() {
    set((state) => ({
      player: { ...state.player, status: 'paused' },
    }))

    try {
      await audioService.pause()
    } catch (error) {
      console.error('Error pausing audio:', error)
      throw error
    }
  }

  async function seek(context: PlaybackContext) {
    const { player } = get()

    // Only seek if the requested file is currently loaded
    if (player.file?.uri !== context.fileUri) {
      console.log('Seek ignored: file not loaded', context.fileUri)
      return
    }

    set((state) => ({
      player: { ...state.player, position: context.position },
    }))

    try {
      await audioService.seek(context.position)
    } catch (error) {
      console.error('Error seeking:', error)
      throw error
    }
  }

  async function skipForward() {
    try {
      await audioService.skip(SKIP_FORWARD_MS)
    } catch (error) {
      console.error('Error skipping forward:', error)
      throw error
    }
  }

  async function skipBackward() {
    try {
      await audioService.skip(-SKIP_BACKWARD_MS)
    } catch (error) {
      console.error('Error skipping backward:', error)
      throw error
    }
  }

  async function addClip(note: string) {
    const { player } = get()
    if (!player.file) {
      throw new Error('No file loaded')
    }

    // Cap clip duration to not exceed remaining audio length
    const remainingDuration = player.duration - player.position
    const clipDuration = Math.min(DEFAULT_CLIP_DURATION_MS, remainingDuration)

    const clip = dbService.createClip(
      player.file.uri,
      player.position,
      clipDuration,
      note
    )

    // Reload all clips to include file information
    fetchAllClips()

    // Queue for transcription
    transcriptionService.queueClip(clip.id)
  }

  function updateClip(id: number, updates: { note?: string; start?: number; duration?: number }) {
    dbService.updateClip(id, updates)

    set((state) => ({
      clips: {
        ...state.clips,
        [id]: {
          ...state.clips[id],
          ...updates,
          updated_at: Date.now(),
        },
      },
    }))
  }

  function updateClipTranscription(id: number, transcription: string) {
    set((state) => {
      const clip = state.clips[id]
      if (!clip) return state

      return {
        clips: {
          ...state.clips,
          [id]: {
            ...clip,
            transcription,
            updated_at: Date.now(),
          },
        },
      }
    })
  }

  function deleteClip(id: number) {
    dbService.deleteClip(id)

    set((state) => {
      const { [id]: removed, ...rest } = state.clips
      return { clips: rest }
    })
  }

  async function jumpToClip(clipId: number) {
    const clip = get().clips[clipId]
    if (!clip) {
      throw new Error('Clip not found')
    }

    // Jump to clip includes loading the file if different
    await get().play({ fileUri: clip.file_uri, position: clip.start })
  }

  async function shareClip(clipId: number) {
    const { clips, player } = get()
    const clip = clips[clipId]

    if (!clip) {
      throw new Error('Clip not found')
    }

    if (!player.file) {
      throw new Error('No file loaded')
    }

    // Extract and share the clip
    await sharingService.shareClip(clip, player.file.uri, player.file.name)
  }

  async function __DEV_resetApp() {
    // Unload current player
    await audioService.unload()

    // Clear database
    dbService.clearAllData()

    // Reset store state
    set({
      player: {
        status: 'paused',
        position: 0,
        duration: 0,
        file: null,
        ownerId: null,
      },
      clips: {},
      files: {},
    })

    console.log('App reset complete')
  }
})
