import { planSync, SyncState, RemoteBook, RemoteClip } from '../planner'
import { Book, Clip, SyncManifestEntry } from '../../storage'
import { BookBackup, ClipBackup } from '../types'

describe('planSync', () => {
  // Helper to create empty state
  function emptyState(): SyncState {
    return {
      local: { books: [], clips: [] },
      remote: { books: new Map(), clips: new Map() },
      manifests: new Map(),
    }
  }

  // Helper to create a book
  function createBook(id: string, updated_at: number): Book {
    return {
      id,
      uri: `file:///path/to/${id}.mp3`,
      name: `Book ${id}`,
      duration: 60000,
      position: 0,
      updated_at,
      title: null,
      artist: null,
      artwork: null,
      file_size: 1000000,
      fingerprint: new Uint8Array([1, 2, 3, 4]),
      hidden: false,
    }
  }

  // Helper to create a remote book
  function createRemoteBook(id: string, updated_at: number, modifiedAt: number): RemoteBook {
    return {
      backup: {
        id,
        name: `Book ${id}`,
        duration: 60000,
        position: 0,
        updated_at,
        title: null,
        artist: null,
        artwork: null,
        file_size: 1000000,
        fingerprint: 'AQIDBA==',
        hidden: false,
      },
      fileId: `file-${id}`,
      modifiedAt,
    }
  }

  // Helper to create a clip
  function createClip(id: string, updated_at: number): Clip {
    return {
      id,
      source_id: 'book-1',
      uri: `file:///path/to/${id}.mp3`,
      start: 0,
      duration: 5000,
      note: '',
      transcription: null,
      created_at: 500,
      updated_at,
    }
  }

  // Helper to create a remote clip
  function createRemoteClip(id: string, updated_at: number, modifiedAt: number): RemoteClip {
    return {
      backup: {
        id,
        source_id: 'book-1',
        start: 0,
        duration: 5000,
        note: '',
        transcription: null,
        created_at: 500,
        updated_at,
      },
      jsonFileId: `json-${id}`,
      audioFileId: `audio-${id}`,
      audioFilename: `clip_${id}.m4a`,
      modifiedAt,
    }
  }

  // Helper to create a manifest entry
  function createManifest(
    type: 'book' | 'clip',
    id: string,
    local_updated_at: number,
    remote_updated_at: number
  ): SyncManifestEntry {
    return {
      entity_type: type,
      entity_id: id,
      local_updated_at,
      remote_updated_at,
      remote_file_id: `file-${id}`,
      remote_audio_file_id: type === 'clip' ? `audio-${id}` : null,
      synced_at: Math.max(local_updated_at, remote_updated_at),
    }
  }

  describe('book sync planning', () => {
    describe('uploads', () => {
      it('uploads new local books (no manifest)', () => {
        const state = emptyState()
        state.local.books = [createBook('book-1', 1000)]

        const plan = planSync(state)

        expect(plan.books.uploads).toHaveLength(1)
        expect(plan.books.uploads[0].book.id).toBe('book-1')
        expect(plan.books.downloads).toHaveLength(0)
        expect(plan.books.merges).toHaveLength(0)
      })

      it('uploads locally changed books (local updated_at > manifest)', () => {
        const state = emptyState()
        state.local.books = [createBook('book-1', 2000)]
        state.manifests.set('book:book-1', createManifest('book', 'book-1', 1000, 1000))

        const plan = planSync(state)

        expect(plan.books.uploads).toHaveLength(1)
        expect(plan.books.uploads[0].book.id).toBe('book-1')
      })

      it('does not upload unchanged local books', () => {
        const state = emptyState()
        state.local.books = [createBook('book-1', 1000)]
        state.manifests.set('book:book-1', createManifest('book', 'book-1', 1000, 1000))

        const plan = planSync(state)

        expect(plan.books.uploads).toHaveLength(0)
      })
    })

    describe('downloads', () => {
      it('downloads new remote books (no manifest)', () => {
        const state = emptyState()
        state.remote.books.set('book-1', createRemoteBook('book-1', 1000, 1000))

        const plan = planSync(state)

        expect(plan.books.downloads).toHaveLength(1)
        expect(plan.books.downloads[0].remote.backup.id).toBe('book-1')
      })

      it('downloads remotely changed books (remote modifiedAt > manifest)', () => {
        const state = emptyState()
        state.remote.books.set('book-1', createRemoteBook('book-1', 2000, 2000))
        state.manifests.set('book:book-1', createManifest('book', 'book-1', 1000, 1000))

        const plan = planSync(state)

        expect(plan.books.downloads).toHaveLength(1)
      })

      it('does not download when local also changed (conflict case)', () => {
        const state = emptyState()
        state.local.books = [createBook('book-1', 2000)]
        state.remote.books.set('book-1', createRemoteBook('book-1', 2000, 2000))
        state.manifests.set('book:book-1', createManifest('book', 'book-1', 1000, 1000))

        const plan = planSync(state)

        // Should be a merge, not a download
        expect(plan.books.downloads).toHaveLength(0)
        expect(plan.books.merges).toHaveLength(1)
      })

      it('does not download unchanged remote books', () => {
        const state = emptyState()
        state.remote.books.set('book-1', createRemoteBook('book-1', 1000, 1000))
        state.manifests.set('book:book-1', createManifest('book', 'book-1', 1000, 1000))

        const plan = planSync(state)

        expect(plan.books.downloads).toHaveLength(0)
      })
    })

    describe('merges', () => {
      it('merges when both local and remote changed', () => {
        const state = emptyState()
        state.local.books = [createBook('book-1', 2000)]
        state.remote.books.set('book-1', createRemoteBook('book-1', 1500, 1800))
        state.manifests.set('book:book-1', createManifest('book', 'book-1', 1000, 1000))

        const plan = planSync(state)

        expect(plan.books.merges).toHaveLength(1)
        expect(plan.books.merges[0].local.id).toBe('book-1')
        expect(plan.books.merges[0].remote.backup.id).toBe('book-1')
      })

      it('does not merge when only local changed', () => {
        const state = emptyState()
        state.local.books = [createBook('book-1', 2000)]
        state.remote.books.set('book-1', createRemoteBook('book-1', 1000, 1000))
        state.manifests.set('book:book-1', createManifest('book', 'book-1', 1000, 1000))

        const plan = planSync(state)

        expect(plan.books.merges).toHaveLength(0)
        expect(plan.books.uploads).toHaveLength(1)
      })

      it('does not merge when only remote changed', () => {
        const state = emptyState()
        state.local.books = [createBook('book-1', 1000)]
        state.remote.books.set('book-1', createRemoteBook('book-1', 2000, 2000))
        state.manifests.set('book:book-1', createManifest('book', 'book-1', 1000, 1000))

        const plan = planSync(state)

        expect(plan.books.merges).toHaveLength(0)
        expect(plan.books.downloads).toHaveLength(1)
      })
    })
  })

  describe('clip sync planning', () => {
    describe('uploads', () => {
      it('uploads new local clips', () => {
        const state = emptyState()
        state.local.clips = [createClip('clip-1', 1000)]

        const plan = planSync(state)

        expect(plan.clips.uploads).toHaveLength(1)
        expect(plan.clips.uploads[0].clip.id).toBe('clip-1')
      })

      it('uploads locally changed clips', () => {
        const state = emptyState()
        state.local.clips = [createClip('clip-1', 2000)]
        state.manifests.set('clip:clip-1', createManifest('clip', 'clip-1', 1000, 1000))

        const plan = planSync(state)

        expect(plan.clips.uploads).toHaveLength(1)
      })
    })

    describe('downloads', () => {
      it('downloads new remote clips', () => {
        const state = emptyState()
        state.remote.clips.set('clip-1', createRemoteClip('clip-1', 1000, 1000))

        const plan = planSync(state)

        expect(plan.clips.downloads).toHaveLength(1)
      })

      it('downloads remotely changed clips', () => {
        const state = emptyState()
        state.remote.clips.set('clip-1', createRemoteClip('clip-1', 2000, 2000))
        state.manifests.set('clip:clip-1', createManifest('clip', 'clip-1', 1000, 1000))

        const plan = planSync(state)

        expect(plan.clips.downloads).toHaveLength(1)
      })
    })

    describe('merges', () => {
      it('merges when both local and remote changed', () => {
        const state = emptyState()
        state.local.clips = [createClip('clip-1', 2000)]
        state.remote.clips.set('clip-1', createRemoteClip('clip-1', 1500, 1800))
        state.manifests.set('clip:clip-1', createManifest('clip', 'clip-1', 1000, 1000))

        const plan = planSync(state)

        expect(plan.clips.merges).toHaveLength(1)
      })
    })

    describe('deletes', () => {
      it('deletes remote clips that were deleted locally', () => {
        const state = emptyState()
        // No local clip, but remote exists and we have a manifest
        state.remote.clips.set('clip-1', createRemoteClip('clip-1', 1000, 1000))
        state.manifests.set('clip:clip-1', createManifest('clip', 'clip-1', 1000, 1000))

        const plan = planSync(state)

        expect(plan.clips.deletes).toHaveLength(1)
        expect(plan.clips.deletes[0].clipId).toBe('clip-1')
      })

      it('does not delete new remote clips (no manifest)', () => {
        const state = emptyState()
        // No local clip, remote exists, but no manifest (so it's new from remote)
        state.remote.clips.set('clip-1', createRemoteClip('clip-1', 1000, 1000))

        const plan = planSync(state)

        expect(plan.clips.deletes).toHaveLength(0)
        expect(plan.clips.downloads).toHaveLength(1)
      })

      it('includes file IDs in delete operation', () => {
        const state = emptyState()
        state.remote.clips.set('clip-1', createRemoteClip('clip-1', 1000, 1000))
        state.manifests.set('clip:clip-1', createManifest('clip', 'clip-1', 1000, 1000))

        const plan = planSync(state)

        expect(plan.clips.deletes[0].jsonFileId).toBe('json-clip-1')
        expect(plan.clips.deletes[0].audioFileId).toBe('audio-clip-1')
      })
    })
  })

  describe('complex scenarios', () => {
    it('handles multiple books with different states', () => {
      const state = emptyState()

      // Book 1: new locally
      state.local.books.push(createBook('book-1', 1000))

      // Book 2: new remotely
      state.remote.books.set('book-2', createRemoteBook('book-2', 1000, 1000))

      // Book 3: conflict (both changed)
      state.local.books.push(createBook('book-3', 2000))
      state.remote.books.set('book-3', createRemoteBook('book-3', 1500, 1500))
      state.manifests.set('book:book-3', createManifest('book', 'book-3', 1000, 1000))

      // Book 4: unchanged
      state.local.books.push(createBook('book-4', 1000))
      state.remote.books.set('book-4', createRemoteBook('book-4', 1000, 1000))
      state.manifests.set('book:book-4', createManifest('book', 'book-4', 1000, 1000))

      const plan = planSync(state)

      expect(plan.books.uploads).toHaveLength(1)
      expect(plan.books.uploads[0].book.id).toBe('book-1')

      expect(plan.books.downloads).toHaveLength(1)
      expect(plan.books.downloads[0].remote.backup.id).toBe('book-2')

      expect(plan.books.merges).toHaveLength(1)
      expect(plan.books.merges[0].local.id).toBe('book-3')
    })

    it('handles empty state', () => {
      const state = emptyState()

      const plan = planSync(state)

      expect(plan.books.uploads).toHaveLength(0)
      expect(plan.books.downloads).toHaveLength(0)
      expect(plan.books.merges).toHaveLength(0)
      expect(plan.clips.uploads).toHaveLength(0)
      expect(plan.clips.downloads).toHaveLength(0)
      expect(plan.clips.merges).toHaveLength(0)
      expect(plan.clips.deletes).toHaveLength(0)
    })
  })

  describe('edge cases', () => {
    it('handles manifest with null timestamps', () => {
      const state = emptyState()
      state.local.books = [createBook('book-1', 1000)]

      const manifest: SyncManifestEntry = {
        entity_type: 'book',
        entity_id: 'book-1',
        local_updated_at: null as any, // Simulate potential DB null
        remote_updated_at: null as any,
        remote_file_id: 'file-1',
        remote_audio_file_id: null,
        synced_at: 0,
      }
      state.manifests.set('book:book-1', manifest)

      // Should treat null as 0, so local (1000) > manifest (0) → upload
      const plan = planSync(state)

      expect(plan.books.uploads).toHaveLength(1)
    })

    it('does not double-process books that exist both locally and remotely', () => {
      const state = emptyState()
      state.local.books = [createBook('book-1', 2000)]
      state.remote.books.set('book-1', createRemoteBook('book-1', 1000, 1000))
      state.manifests.set('book:book-1', createManifest('book', 'book-1', 1000, 1000))

      const plan = planSync(state)

      // Should only upload (local changed, remote didn't)
      expect(plan.books.uploads).toHaveLength(1)
      expect(plan.books.downloads).toHaveLength(0)
      expect(plan.books.merges).toHaveLength(0)
    })
  })
})
