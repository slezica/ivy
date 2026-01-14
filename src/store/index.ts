import { create } from 'zustand'
import { AudioService } from '../services/AudioService'
import { DatabaseService } from '../services/DatabaseService'
import { FileService, PickedFile } from '../services/FileService'
import { FileStorageService } from '../services/FileStorageService'
import type { Clip, AudioFile } from '../services/DatabaseService'


const SKIP_FORWARD_MS = 25 * 1000
const SKIP_BACKWARD_MS = 30 * 1000
const DEFAULT_CLIP_DURATION_MS = 20 * 1000


type PlayerStatus = 'adding' | 'loading' | 'paused' | 'playing'

interface PlayerState {
  status: PlayerStatus
  position: number
  duration: number
  file: AudioFile | null
}

interface AppState {
  // State
  player: PlayerState
  clips: Record<number, Clip>
  files: Record<string, AudioFile>

  // Actions
  loadFile: (pickedFile: PickedFile) => Promise<void>
  loadFileWithUri: (uri: string, name: string) => Promise<void>
  loadFileWithPicker: () => Promise<void>
  fetchFiles: () => void
  play: () => Promise<void>
  pause: () => Promise<void>
  seek: (position: number) => Promise<void>
  skipForward: () => Promise<void>
  skipBackward: () => Promise<void>
  addClip: (note: string) => Promise<void>
  updateClip: (id: number, note: string) => void
  deleteClip: (id: number) => void
  jumpToClip: (clipId: number) => Promise<void>

  // Dev tools
  __DEV_resetApp: () => Promise<void>
}


export const useStore = create<AppState>((set, get) => {
  // Initialize services
  const dbService = new DatabaseService()

  const fileService = new FileService()

  const fileStorageService = new FileStorageService()

  const audioService = new AudioService({
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
      const { player } = get()
      if (player.file) {
        dbService.updateFilePosition(player.file.uri, status.position)
      }
    },
  })

  return {
    // Initial state
    player: {
      status: 'paused',
      position: 0,
      duration: 0,
      file: null,
    },
    clips: {},
    files: {},

    // Actions (below)
    loadFileWithPicker,
    loadFile,
    loadFileWithUri,
    fetchFiles,
    play,
    pause,
    seek,
    skipForward,
    skipBackward,
    addClip,
    deleteClip,
    updateClip,
    jumpToClip,
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

  async function loadFileWithUri(uri: string, name: string) {
    await get().loadFile({ uri, name })
  }

  async function loadFileWithPicker() {
    const pickedFile = await fileService.pickAudioFile()
    if (pickedFile) {
      await get().loadFile(pickedFile)
    }
  }

  async function loadFile(pickedFile: PickedFile) {
    try {
      // Step 1: Copy file to app storage if needed
      let localUri: string
      let audioFile = dbService.getFile(pickedFile.uri)

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
      }

      // Verify file exists before loading
      const exists = await fileStorageService.fileExists(localUri)
      console.log('Local file exists check:', exists, localUri)
      if (!exists) {
        throw new Error(`Local file does not exist: ${localUri}`)
      }

      // Step 2: Load audio from local URI
      set((state) => ({
        player: { ...state.player, status: 'loading' },
      }))

      console.log('Loading audio from:', localUri)
      const duration = await audioService.load(localUri)
      console.log('Audio loaded successfully, duration:', duration)

      // Step 3: Save/update file record in database
      // Save local URI as 'uri' (what we actually use) and original as 'original_uri'
      if (!audioFile) {
        dbService.upsertFile(localUri, pickedFile.name, duration, 0, pickedFile.uri)
        audioFile = dbService.getFile(localUri)
      } else {
        // Update existing record
        dbService.upsertFile(localUri, pickedFile.name, duration, audioFile.position, pickedFile.uri)
        audioFile = dbService.getFile(localUri)
      }

      if (!audioFile) {
        throw new Error('Failed to create file record')
      }

      // Load clips for this file
      const clips = dbService.getClipsForFile(pickedFile.uri)
      const clipsMap = clips.reduce((acc, clip) => {
        acc[clip.id] = clip
        return acc
      }, {} as Record<number, Clip>)

      // Update state (keep status as 'loading' until play starts)
      set((state) => ({
        player: {
          ...state.player,
          position: audioFile.position,
          duration,
          file: audioFile,
        },
        clips: clipsMap,
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

  async function play() {
    set((state) => ({
      player: { ...state.player, status: 'playing' },
    }))

    try {
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

  async function seek(position: number) {
    set((state) => ({
      player: { ...state.player, position },
    }))

    try {
      await audioService.seek(position)
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

    const clip = dbService.createClip(
      player.file.uri,
      player.position,
      DEFAULT_CLIP_DURATION_MS,
      note
    )

    set((state) => ({
      clips: { ...state.clips, [clip.id]: clip },
    }))
  }

  function updateClip(id: number, note: string) {
    dbService.updateClip(id, note)

    set((state) => ({
      clips: {
        ...state.clips,
        [id]: {
          ...state.clips[id],
          note,
          updated_at: Date.now(),
        },
      },
    }))
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

    await get().seek(clip.start)
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
      },
      clips: {},
      files: {},
    })

    console.log('App reset complete')
  }
})
