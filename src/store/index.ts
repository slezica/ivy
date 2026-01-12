import { create } from 'zustand'
import { AudioService } from '../services/AudioService'
import { DatabaseService } from '../services/DatabaseService'
import { FileService, PickedFile } from '../services/FileService'
import type { Clip, AudioFile } from '../services/DatabaseService'


const SKIP_FORWARD_MS = 25 * 1000
const SKIP_BACKWARD_MS = 30 * 1000
const DEFAULT_CLIP_DURATION_MS = 20 * 1000


interface PlaybackState {
  isPlaying: boolean
  position: number
  duration: number
}

interface AppState {
  // State
  playback: PlaybackState
  file: AudioFile | null
  clips: Record<number, Clip>

  // Actions
  loadFile: (pickedFile: PickedFile) => Promise<void>
  pickAndLoadFile: () => Promise<void>
  play: () => Promise<void>
  pause: () => Promise<void>
  seek: (position: number) => Promise<void>
  skipForward: () => Promise<void>
  skipBackward: () => Promise<void>
  addClip: (note: string) => Promise<void>
  updateClip: (id: number, note: string) => void
  deleteClip: (id: number) => void
  jumpToClip: (clipId: number) => Promise<void>
}


export const useStore = create<AppState>((set, get) => {
  // Initialize services
  const dbService = new DatabaseService()

  const fileService = new FileService()

  const audioService = new AudioService({
    onPlaybackStatusChange: (status) => {
      set({ playback: status })

      // Update file position in database
      const { file } = get()
      if (file) {
        dbService.updateFilePosition(file.uri, status.position)
      }
    },
  })

  return {
    // Initial state
    playback: {
      isPlaying: false,
      position: 0,
      duration: 0,
    },
    file: null,
    clips: {},

    // Actions (below)
    pickAndLoadFile,
    loadFile,
    play,
    pause,
    seek,
    skipForward,
    skipBackward,
    addClip,
    deleteClip,
    updateClip,
    jumpToClip
  }

  async function pickAndLoadFile() {
    const pickedFile = await fileService.pickAudioFile()
    if (pickedFile) {
      await get().loadFile(pickedFile)
    }
  }

  async function loadFile(pickedFile: PickedFile) {
    try {
      // Load audio and get duration
      const duration = await audioService.load(pickedFile.uri)

      // Get or create file record from database
      let audioFile = dbService.getFile(pickedFile.uri)
      if (!audioFile) {
        dbService.upsertFile(pickedFile.uri, pickedFile.name, duration, 0)
        audioFile = dbService.getFile(pickedFile.uri)
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

      // Update state
      set({
        file: audioFile,
        clips: clipsMap,
        playback: {
          isPlaying: false,
          position: audioFile.position,
          duration,
        },
      })

      // Seek to saved position
      if (audioFile.position > 0) {
        await audioService.seek(audioFile.position)
      }
    } catch (error) {
      console.error(error)
      throw error
    }
  }

  async function play() {
    set((state) => ({
      playback: { ...state.playback, isPlaying: true },
    }))

    try {
      await audioService.play()
    } catch (error) {
      console.error('Error playing audio:', error)
      set((state) => ({
        playback: { ...state.playback, isPlaying: false },
      }))
      throw error
    }
  }

  async function pause() {
    set((state) => ({
      playback: { ...state.playback, isPlaying: false },
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
      playback: { ...state.playback, position },
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
    const { file, playback } = get()
    if (!file) {
      throw new Error('No file loaded')
    }

    const clip = dbService.createClip(
      file.uri,
      playback.position,
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
})
