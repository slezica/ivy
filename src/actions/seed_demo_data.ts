/**
 * Demo data seeding for Play Store screenshots.
 *
 * At startup, if a seed bundle exists at {ExternalDirectoryPath}/demo/
 * (pushed via adb by scripts/playstore-shots.sh), the database is wiped and
 * repopulated from it: books with artwork and positions, clips with notes and
 * transcriptions, and listening sessions. The bundle is deleted after seeding,
 * so later launches keep the seeded state without re-seeding.
 *
 * Trigger is presence-of-file only: the bundle lives in app-owned storage, so
 * only adb (or the app itself) can create it. See docs/2026-07-21-playstore-screenshots.md.
 */

import RNFS from 'react-native-fs'
import type { DatabaseService, FileStorageService } from '../services'
import type { SetState } from '../store/types'
import { createLogger } from '../utils'
import { CLIPS_DIR } from './constants'

const log = createLogger('SeedDemoData')

export const DEMO_DIR = `${RNFS.ExternalDirectoryPath}/demo`

interface DemoBook {
  id: string
  name: string
  title: string
  artist: string
  duration: number
  position: number
  audio?: string          // Bundle file copied to app storage (absent => archived)
  artwork?: string        // Bundle PNG stored as a base64 data URI
  archived?: boolean
}

interface DemoClip {
  id: string
  book: string
  start: number
  duration: number
  note?: string
  transcription?: string
  audio: string
  daysAgo?: number
}

interface DemoSession {
  book: string
  daysAgo: number
  startHour: number       // Fractional local hour, e.g. 21.25 = 21:15
  minutes: number
}

interface DemoSeed {
  books: DemoBook[]
  clips: DemoClip[]
  sessions: DemoSession[]
}

export interface SeedDemoDataDeps {
  db: DatabaseService
  files: FileStorageService
  set: SetState
}

// Not an Action: returns whether seeding ran
export type SeedDemoData = () => Promise<boolean>

const DAY_MS = 24 * 60 * 60 * 1000

export const createSeedDemoData = (deps: SeedDemoDataDeps): SeedDemoData => (
  async () => {
    const { db, files, set } = deps

    const seedPath = `${DEMO_DIR}/seed.json`
    if (!(await RNFS.exists(seedPath))) return false

    log('Seed bundle found, seeding demo data')
    const seed: DemoSeed = JSON.parse(await RNFS.readFile(seedPath, 'utf8'))

    db.clearAllData()
    await files.ensureAudioDirectory()
    await RNFS.mkdir(CLIPS_DIR)

    const now = Date.now()
    const midnight = new Date(new Date(now).setHours(0, 0, 0, 0)).getTime()

    // Books: explicit descending updated_at keeps data.json order in the
    // library (sorted updated_at DESC) and makes books[0] the auto-load pick
    // (getLastPlayedBook falls back to updated_at when last_played_at is null).
    for (const [index, book] of seed.books.entries()) {
      await db.restoreBookFromBackup(
        book.id, book.name, book.duration, book.position,
        now - index * 60_000, null,
        book.title, book.artist,
        book.artwork ? await readArtwork(`${DEMO_DIR}/${book.artwork}`) : null,
        0, new Uint8Array(0),
      )
      if (book.audio && !book.archived) {
        const path = `${files.audioDirectoryPath}/${book.id}.mp3`
        await RNFS.copyFile(`${DEMO_DIR}/${book.audio}`, path)
        await db.setBookUri(book.id, `file://${path}`)
      }
    }

    // Clips: created_at derives from daysAgo (list sorts created_at DESC)
    for (const clip of seed.clips) {
      const path = `${CLIPS_DIR}/${clip.id}.mp3`
      await RNFS.copyFile(`${DEMO_DIR}/${clip.audio}`, path)
      const book = seed.books.find((b) => b.id === clip.book)
      const createdAt = now - (clip.daysAgo ?? 0) * DAY_MS
      await db.restoreClipFromBackup(
        clip.id, clip.book, `file://${path}`, clip.start, clip.duration,
        clip.note ?? '', clip.transcription ?? null,
        createdAt, createdAt, null,
        book?.title ?? null, book?.artist ?? null,
      )
    }

    for (const [index, session] of seed.sessions.entries()) {
      const startedAt = midnight - session.daysAgo * DAY_MS + session.startHour * 60 * 60_000
      const endedAt = startedAt + session.minutes * 60_000
      await db.restoreSessionFromBackup(`demo-session-${index}`, session.book, startedAt, endedAt, endedAt)
    }

    // Quiet queues during screenshots: no sync, no Whisper model download
    const settings = { sync_enabled: false, transcription_enabled: false }
    await db.setSettings(settings)
    set((state) => { state.settings = settings })

    // Consume the bundle: relaunches keep the seeded state without re-seeding
    await RNFS.unlink(DEMO_DIR)

    log(`Seeded ${seed.books.length} books, ${seed.clips.length} clips, ${seed.sessions.length} sessions`)
    return true
  }
)

async function readArtwork(path: string): Promise<string> {
  return `data:image/png;base64,${await RNFS.readFile(path, 'base64')}`
}
