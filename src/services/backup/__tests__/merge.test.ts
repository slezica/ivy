import { mergeBook, mergeClip } from '../merge'
import { Book, Clip } from '../../storage'
import { BookBackup, ClipBackup } from '../types'

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
