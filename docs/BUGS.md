# Bug Report — 2026-03-19

Systematic audit across four vertical slices: Library, Playback & Sessions, Clips & Transcription, Sync & Backup.

## Critical / High

### BUG-2: Clip re-slice overwrites then deletes the same file

**Location:** `src/actions/update_clip.ts:47-60`

When clip bounds change, the code slices new audio to `{CLIPS_DIR}/{id}.m4a` (lines 49-55), which is the **same path** as the existing clip file. Then line 60 runs:

```typescript
await slicer.cleanup(clip.uri)
```

This deletes the file that was just written, since `clip.uri` points to the same `{CLIPS_DIR}/{id}.m4a` path. Every bounds edit destroys the clip's audio file.

**Impact:** Any clip edit that changes start/duration permanently deletes the clip audio. The database points to a nonexistent file.


## Medium

### BUG-7: No mutex on `play()` — rapid book switching corrupts state

**Location:** `src/actions/play.ts`

There is no cancellation token or lock. If the user taps play on Book A, then quickly on Book B while A is still loading (`audio.load()` in-flight), the second call enters the `!isSameFile` branch and calls `audio.load()` for B, which starts with `TrackPlayer.reset()`. This disrupts A's load, whose error handler then sets status based on stale state, potentially clobbering B's loading state.

**Impact:** Rapid book switching can leave playback in a broken state (UI shows paused but player is playing, or vice versa).


### BUG-8: Argument-blind throttle drops sessions after book switch

**Location:** `src/store/index.ts:59-61`, `src/utils/index.ts`

```typescript
const throttledTrackSession = throttle((bookId: string) => {
  trackSession(bookId)
}, 5_000)
```

The `throttle` utility is a simple time gate — it doesn't consider arguments. If `trackSession(bookA)` fires, then the user switches books within 5 seconds, `trackSession(bookB)` is silently dropped. If the user pauses within that window, `finalizeSession` is called for Book B's ID but no session was ever created — it's lost.

**Impact:** Short listening sessions after switching books are silently lost.


### BUG-9: `fetchBooks()` clobbers library state mid-load

**Location:** `src/actions/fetch_books.ts:22`

```typescript
set({ books, library: { status: 'idle' } })
```

This replaces the entire `library` object with `{ status: 'idle' }`. If called while a file load is in progress (via `useFocusEffect` on tab return, or via `onSyncData`), the loading modal disappears and the load's `setLibrary` guard prevents further UI updates.

**Impact:** Loading modal disappears prematurely during import. The book is still added to the DB, but the user gets no completion feedback.


### BUG-10: `hasSourceFile` is true when clip is null

**Location:** `src/screens/ClipsListScreen.tsx:170-171`

```typescript
const clip = menuClipId ? clips[menuClipId] : null
const hasSourceFile = clip?.file_uri !== null
```

When `clip` is `null`, `clip?.file_uri` evaluates to `undefined`, and `undefined !== null` is `true`. The menu shows "Edit" and "Go to source" for a nonexistent clip.

**Impact:** Tapping those menu items for a deleted/missing clip will fail downstream.


### BUG-11: Missing `await` on `transcription.start()`

**Location:** `src/actions/start_transcription.ts:13`

```typescript
async () => {
    deps.transcription.start()
}
```

`start()` returns `Promise<void>` but isn't awaited. Errors from model download become unhandled promise rejections.

**Impact:** Caller (Settings screen) thinks transcription started successfully even if initialization failed. No error feedback to the user.


### BUG-12: Failed Whisper init permanently breaks transcription queue

**Location:** `src/services/transcription/whisper.ts:51-66`, `src/services/transcription/queue.ts:74-87`

If `doInitialize()` throws, the `finally` block clears `this.initializing` but `this.context` stays `null`. In `queue.ts`, `start()` catches the error and returns (line 84-86), but `this.started` is already `true` (line 80). Any subsequent `queueClip` call enters `processQueue`, sees `!this.whisper.isReady()`, and silently bails. The queue is permanently dead until the app is restarted.

**Impact:** A transient model download failure silently disables all future transcription for the session.


## Low

### BUG-15: Status set to `'playing'` before `audio.play()` completes

**Location:** `src/actions/play.ts:58-63`

```typescript
set(state => {
  state.playback.status = 'playing'
})
await audio.play()
```

Between setting `'playing'` and `audio.play()` actually completing, TrackPlayer may still be in a paused/ready state. The `onAudioStatus` handler receives that intermediate event and overwrites status back to `'paused'`, causing a UI flicker.

**Impact:** Play button can briefly flicker on slower devices.


### BUG-16: Division by zero in progress display

**Location:** `src/screens/LibraryScreen.tsx:267-270`

```tsx
{!isArchived && item.position > 0 && (
  <Text>{Math.round((item.position / item.duration) * 100)}% played</Text>
)}
```

No guard for `item.duration > 0`. If metadata extraction failed, `duration` is 0, rendering `Infinity%` or `NaN%`.

**Impact:** Cosmetic — broken text in rare edge case.


### BUG-17: Double DB write on transcription finish

**Location:** `src/store/index.ts:236-244`

When transcription finishes:
1. `TranscriptionQueueService.processClip()` writes to DB directly
2. The store's `onTranscriptionFinish` handler calls `updateClip()` action, which writes to DB again and queues an unnecessary sync operation

**Impact:** Redundant DB write and spurious sync queue entry per transcription.
