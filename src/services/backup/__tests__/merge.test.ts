import { mergeBook, mergeClip, mergeSession } from '../merge'
import { Book, Clip, Session } from '../../storage'
import { BookBackup, ClipBackup, SessionBackup } from '../types'

describe('mergeBook', () => {
  const baseBook: Book = {
    id: 'book-1',
    uri: 'file:///path/to/book.mp3',
    name: 'Test Book',
    duration: 60000,
    position: 0,
    updated_at: 1000,
    title: 'Local Title',
    artist: 'Local Artist',
    artwork: 'local-artwork.jpg',
    file_size: 1000000,
    fingerprint: new Uint8Array([1, 2, 3, 4]),
    hidden: false,
    chapters: null,
    speed: 100,
  }

  const baseBackup: BookBackup = {
    id: 'book-1',
    name: 'Test Book',
    duration: 60000,
    position: 0,
    updated_at: 1000,
    title: 'Remote Title',
    artist: 'Remote Artist',
    artwork: 'remote-artwork.jpg',
    file_size: 1000000,
    fingerprint: 'AQIDBA==', // base64 of [1,2,3,4]
    hidden: false,
    speed: 100,
  }

  describe('position merge (max wins)', () => {
    it('uses local position when local is further', () => {
      const local = { ...baseBook, position: 5000 }
      const remote = { ...baseBackup, position: 3000 }

      const { merged } = mergeBook(local, remote)

      expect(merged.position).toBe(5000)
    })

    it('uses remote position when remote is further', () => {
      const local = { ...baseBook, position: 3000 }
      const remote = { ...baseBackup, position: 5000 }

      const { merged } = mergeBook(local, remote)

      expect(merged.position).toBe(5000)
    })

    it('handles equal positions', () => {
      const local = { ...baseBook, position: 5000 }
      const remote = { ...baseBackup, position: 5000 }

      const { merged } = mergeBook(local, remote)

      expect(merged.position).toBe(5000)
    })

    it('handles zero positions', () => {
      const local = { ...baseBook, position: 0 }
      const remote = { ...baseBackup, position: 0 }

      const { merged } = mergeBook(local, remote)

      expect(merged.position).toBe(0)
    })
  })

  describe('metadata merge (last-write-wins)', () => {
    it('uses local metadata when local is newer', () => {
      const local = { ...baseBook, updated_at: 2000 }
      const remote = { ...baseBackup, updated_at: 1000 }

      const { merged, resolution } = mergeBook(local, remote)

      expect(merged.title).toBe('Local Title')
      expect(merged.artist).toBe('Local Artist')
      expect(merged.artwork).toBe('local-artwork.jpg')
      expect(resolution).toContain('local wins')
    })

    it('uses remote metadata when remote is newer', () => {
      const local = { ...baseBook, updated_at: 1000 }
      const remote = { ...baseBackup, updated_at: 2000 }

      const { merged, resolution } = mergeBook(local, remote)

      expect(merged.title).toBe('Remote Title')
      expect(merged.artist).toBe('Remote Artist')
      expect(merged.artwork).toBe('remote-artwork.jpg')
      expect(resolution).toContain('remote wins')
    })

    it('uses local metadata when timestamps are equal', () => {
      const local = { ...baseBook, updated_at: 1000 }
      const remote = { ...baseBackup, updated_at: 1000 }

      const { merged } = mergeBook(local, remote)

      // >= means local wins on tie
      expect(merged.title).toBe('Local Title')
      expect(merged.artist).toBe('Local Artist')
    })

    it('handles null metadata values', () => {
      const local = { ...baseBook, updated_at: 2000, title: null, artist: null }
      const remote = { ...baseBackup, updated_at: 1000 }

      const { merged } = mergeBook(local, remote)

      // Local wins, so we get local's nulls
      expect(merged.title).toBeNull()
      expect(merged.artist).toBeNull()
    })
  })

  describe('speed merge (last-write-wins with metadata)', () => {
    it('uses local speed when local is newer', () => {
      const local = { ...baseBook, speed: 150, updated_at: 2000 }
      const remote = { ...baseBackup, speed: 125, updated_at: 1000 }

      const { merged } = mergeBook(local, remote)

      expect(merged.speed).toBe(150)
    })

    it('uses remote speed when remote is newer', () => {
      const local = { ...baseBook, speed: 100, updated_at: 1000 }
      const remote = { ...baseBackup, speed: 150, updated_at: 2000 }

      const { merged } = mergeBook(local, remote)

      expect(merged.speed).toBe(150)
    })

    it('falls back to local speed when remote has no speed (backward compat)', () => {
      const local = { ...baseBook, speed: 125, updated_at: 1000 }
      const remote = { ...baseBackup, updated_at: 2000 }
      delete (remote as Partial<typeof remote>).speed

      const { merged } = mergeBook(local, remote)

      expect(merged.speed).toBe(125)
    })
  })

  describe('combined scenarios', () => {
    it('can use remote position with local metadata', () => {
      const local = { ...baseBook, position: 1000, updated_at: 2000 }
      const remote = { ...baseBackup, position: 5000, updated_at: 1000 }

      const { merged, resolution } = mergeBook(local, remote)

      expect(merged.position).toBe(5000) // max
      expect(merged.title).toBe('Local Title') // local wins (newer)
      expect(resolution).toContain('5000ms')
      expect(resolution).toContain('local wins')
    })

    it('can use local position with remote metadata', () => {
      const local = { ...baseBook, position: 5000, updated_at: 1000 }
      const remote = { ...baseBackup, position: 1000, updated_at: 2000 }

      const { merged, resolution } = mergeBook(local, remote)

      expect(merged.position).toBe(5000) // max
      expect(merged.title).toBe('Remote Title') // remote wins (newer)
      expect(resolution).toContain('5000ms')
      expect(resolution).toContain('remote wins')
    })
  })

  describe('immutability', () => {
    it('does not modify the original local book', () => {
      const local = { ...baseBook, position: 1000 }
      const originalPosition = local.position

      mergeBook(local, baseBackup)

      expect(local.position).toBe(originalPosition)
    })
  })

  describe('updated_at handling', () => {
    it('sets updated_at to current time', () => {
      const before = Date.now()
      const { merged } = mergeBook(baseBook, baseBackup)
      const after = Date.now()

      expect(merged.updated_at).toBeGreaterThanOrEqual(before)
      expect(merged.updated_at).toBeLessThanOrEqual(after)
    })
  })

  describe('hidden merge (hidden-wins)', () => {
    it('stays visible when both are visible', () => {
      const local = { ...baseBook, hidden: false }
      const remote = { ...baseBackup, hidden: false }

      const { merged } = mergeBook(local, remote)

      expect(merged.hidden).toBe(false)
    })

    it('becomes hidden when local is hidden', () => {
      const local = { ...baseBook, hidden: true }
      const remote = { ...baseBackup, hidden: false }

      const { merged, resolution } = mergeBook(local, remote)

      expect(merged.hidden).toBe(true)
      expect(resolution).toContain('hidden: true')
    })

    it('becomes hidden when remote is hidden', () => {
      const local = { ...baseBook, hidden: false }
      const remote = { ...baseBackup, hidden: true }

      const { merged, resolution } = mergeBook(local, remote)

      expect(merged.hidden).toBe(true)
      expect(resolution).toContain('hidden: true')
    })

    it('stays hidden when both are hidden', () => {
      const local = { ...baseBook, hidden: true }
      const remote = { ...baseBackup, hidden: true }

      const { merged } = mergeBook(local, remote)

      expect(merged.hidden).toBe(true)
    })

    it('handles missing hidden field in remote (backward compat)', () => {
      const local = { ...baseBook, hidden: false }
      const remote = { ...baseBackup }
      delete (remote as Partial<typeof remote>).hidden

      const { merged } = mergeBook(local, remote)

      expect(merged.hidden).toBe(false)
    })
  })
})

describe('mergeClip', () => {
  const baseClip: Clip = {
    id: 'clip-1',
    source_id: 'book-1',
    uri: 'file:///path/to/clip.mp3',
    start: 1000,
    duration: 5000,
    note: 'Local note',
    transcription: null,
    created_at: 500,
    updated_at: 1000,
  }

  const baseBackup: ClipBackup = {
    id: 'clip-1',
    source_id: 'book-1',
    start: 2000,
    duration: 6000,
    note: 'Remote note',
    transcription: null,
    created_at: 500,
    updated_at: 1000,
  }

  describe('note merge', () => {
    it('keeps local note when notes are identical', () => {
      const local = { ...baseClip, note: 'Same note' }
      const remote = { ...baseBackup, note: 'Same note' }

      const { merged, resolution } = mergeClip(local, remote)

      expect(merged.note).toBe('Same note')
      expect(resolution).not.toContain('concatenated')
    })

    it('concatenates notes when different and both non-empty', () => {
      const local = { ...baseClip, note: 'Local note' }
      const remote = { ...baseBackup, note: 'Remote note' }

      const { merged, resolution } = mergeClip(local, remote)

      expect(merged.note).toContain('Local note')
      expect(merged.note).toContain('Remote note')
      expect(merged.note).toContain('Conflict')
      expect(resolution).toContain('concatenated')
    })

    it('uses remote note when local is empty', () => {
      const local = { ...baseClip, note: '' }
      const remote = { ...baseBackup, note: 'Remote note' }

      const { merged } = mergeClip(local, remote)

      expect(merged.note).toBe('Remote note')
    })

    it('uses local note when remote is empty', () => {
      const local = { ...baseClip, note: 'Local note' }
      const remote = { ...baseBackup, note: '' }

      const { merged } = mergeClip(local, remote)

      expect(merged.note).toBe('Local note')
    })

    it('returns empty when both notes are empty', () => {
      const local = { ...baseClip, note: '' }
      const remote = { ...baseBackup, note: '' }

      const { merged } = mergeClip(local, remote)

      expect(merged.note).toBe('')
    })
  })

  describe('bounds merge (last-write-wins)', () => {
    it('uses local bounds when local is newer', () => {
      const local = { ...baseClip, start: 1000, duration: 5000, updated_at: 2000 }
      const remote = { ...baseBackup, start: 2000, duration: 6000, updated_at: 1000 }

      const { merged } = mergeClip(local, remote)

      expect(merged.start).toBe(1000)
      expect(merged.duration).toBe(5000)
    })

    it('uses remote bounds when remote is newer', () => {
      const local = { ...baseClip, start: 1000, duration: 5000, updated_at: 1000 }
      const remote = { ...baseBackup, start: 2000, duration: 6000, updated_at: 2000 }

      const { merged } = mergeClip(local, remote)

      expect(merged.start).toBe(2000)
      expect(merged.duration).toBe(6000)
    })

    it('uses local bounds when timestamps are equal', () => {
      const local = { ...baseClip, start: 1000, duration: 5000, updated_at: 1000 }
      const remote = { ...baseBackup, start: 2000, duration: 6000, updated_at: 1000 }

      const { merged } = mergeClip(local, remote)

      // >= means local wins on tie
      expect(merged.start).toBe(1000)
      expect(merged.duration).toBe(5000)
    })
  })

  describe('transcription merge (prefer non-null)', () => {
    it('uses local transcription when remote is null', () => {
      const local = { ...baseClip, transcription: 'Local transcription' }
      const remote = { ...baseBackup, transcription: null }

      const { merged } = mergeClip(local, remote)

      expect(merged.transcription).toBe('Local transcription')
    })

    it('uses remote transcription when local is null', () => {
      const local = { ...baseClip, transcription: null }
      const remote = { ...baseBackup, transcription: 'Remote transcription' }

      const { merged } = mergeClip(local, remote)

      expect(merged.transcription).toBe('Remote transcription')
    })

    it('uses local transcription when both have values', () => {
      const local = { ...baseClip, transcription: 'Local transcription' }
      const remote = { ...baseBackup, transcription: 'Remote transcription' }

      const { merged } = mergeClip(local, remote)

      // ?? operator: local wins if non-null
      expect(merged.transcription).toBe('Local transcription')
    })

    it('returns null when both are null', () => {
      const local = { ...baseClip, transcription: null }
      const remote = { ...baseBackup, transcription: null }

      const { merged } = mergeClip(local, remote)

      expect(merged.transcription).toBeNull()
    })
  })

  describe('resolution message', () => {
    it('reports notes concatenated when notes differ', () => {
      const local = { ...baseClip, note: 'A' }
      const remote = { ...baseBackup, note: 'B' }

      const { resolution } = mergeClip(local, remote)

      expect(resolution).toBe('Notes concatenated with conflict marker')
    })

    it('reports bounds winner when notes are same', () => {
      const local = { ...baseClip, note: 'Same', updated_at: 2000 }
      const remote = { ...baseBackup, note: 'Same', updated_at: 1000 }

      const { resolution } = mergeClip(local, remote)

      expect(resolution).toBe('Bounds: local wins')
    })
  })

  describe('immutability', () => {
    it('does not modify the original local clip', () => {
      const local = { ...baseClip }
      const originalNote = local.note

      mergeClip(local, baseBackup)

      expect(local.note).toBe(originalNote)
    })
  })
})

describe('mergeSession', () => {
  const baseSession: Session = {
    id: 'session-1',
    book_id: 'book-1',
    started_at: 1000,
    ended_at: 5000,
    updated_at: 5000,
  }

  const baseBackup: SessionBackup = {
    id: 'session-1',
    book_id: 'book-1',
    started_at: 1000,
    ended_at: 5000,
    updated_at: 5000,
  }

  describe('started_at merge (min wins)', () => {
    it('uses local started_at when local is earlier', () => {
      const local = { ...baseSession, started_at: 1000 }
      const remote = { ...baseBackup, started_at: 2000 }

      const { merged } = mergeSession(local, remote)

      expect(merged.started_at).toBe(1000)
    })

    it('uses remote started_at when remote is earlier', () => {
      const local = { ...baseSession, started_at: 2000 }
      const remote = { ...baseBackup, started_at: 1000 }

      const { merged } = mergeSession(local, remote)

      expect(merged.started_at).toBe(1000)
    })

    it('handles equal started_at', () => {
      const local = { ...baseSession, started_at: 1000 }
      const remote = { ...baseBackup, started_at: 1000 }

      const { merged } = mergeSession(local, remote)

      expect(merged.started_at).toBe(1000)
    })
  })

  describe('ended_at merge (max wins)', () => {
    it('uses local ended_at when local is later', () => {
      const local = { ...baseSession, ended_at: 8000 }
      const remote = { ...baseBackup, ended_at: 5000 }

      const { merged } = mergeSession(local, remote)

      expect(merged.ended_at).toBe(8000)
    })

    it('uses remote ended_at when remote is later', () => {
      const local = { ...baseSession, ended_at: 5000 }
      const remote = { ...baseBackup, ended_at: 8000 }

      const { merged } = mergeSession(local, remote)

      expect(merged.ended_at).toBe(8000)
    })

    it('handles equal ended_at', () => {
      const local = { ...baseSession, ended_at: 5000 }
      const remote = { ...baseBackup, ended_at: 5000 }

      const { merged } = mergeSession(local, remote)

      expect(merged.ended_at).toBe(5000)
    })
  })

  describe('combined scenarios', () => {
    it('widens the time range from both sides', () => {
      const local = { ...baseSession, started_at: 2000, ended_at: 8000 }
      const remote = { ...baseBackup, started_at: 1000, ended_at: 10000 }

      const { merged } = mergeSession(local, remote)

      expect(merged.started_at).toBe(1000)
      expect(merged.ended_at).toBe(10000)
    })

    it('takes earlier start from remote, later end from local', () => {
      const local = { ...baseSession, started_at: 2000, ended_at: 10000 }
      const remote = { ...baseBackup, started_at: 1000, ended_at: 8000 }

      const { merged } = mergeSession(local, remote)

      expect(merged.started_at).toBe(1000)
      expect(merged.ended_at).toBe(10000)
    })
  })

  describe('preserves identity', () => {
    it('keeps book_id from local', () => {
      const { merged } = mergeSession(baseSession, baseBackup)

      expect(merged.book_id).toBe('book-1')
    })

    it('keeps id from local', () => {
      const { merged } = mergeSession(baseSession, baseBackup)

      expect(merged.id).toBe('session-1')
    })
  })

  describe('updated_at handling', () => {
    it('sets updated_at to current time', () => {
      const before = Date.now()
      const { merged } = mergeSession(baseSession, baseBackup)
      const after = Date.now()

      expect(merged.updated_at).toBeGreaterThanOrEqual(before)
      expect(merged.updated_at).toBeLessThanOrEqual(after)
    })
  })

  describe('resolution message', () => {
    it('includes the merged time range', () => {
      const local = { ...baseSession, started_at: 2000, ended_at: 8000 }
      const remote = { ...baseBackup, started_at: 1000, ended_at: 10000 }

      const { resolution } = mergeSession(local, remote)

      expect(resolution).toContain('1000')
      expect(resolution).toContain('10000')
    })
  })

  describe('immutability', () => {
    it('does not modify the original local session', () => {
      const local = { ...baseSession }
      const originalEndedAt = local.ended_at

      mergeSession(local, { ...baseBackup, ended_at: 99999 })

      expect(local.ended_at).toBe(originalEndedAt)
    })
  })
})
