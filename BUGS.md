# Bug Report - Ivy

Comprehensive bug analysis conducted on 2026-01-21.

## Summary

| Severity | Count |
|----------|-------|
| Critical | 7 |
| High | 12 |
| Medium | 18 |
| Low | 8 |

---

## Critical Bugs

### 1. Race Condition: Null Reference in `updateClip`

**File:** `src/store/clips.ts:143-150`

The `set` callback accesses `state.clips[id]` without checking if the clip still exists. Between the initial check at line 102 and the callback execution, another action could delete the clip.

```typescript
set((state) => {
  const clip = state.clips[id]  // Could be undefined
  if (updates.note !== undefined) clip.note = updates.note  // CRASH
  // ...
})
```

**Impact:** Runtime crash when updating a clip that was concurrently deleted.

**Fix:** Add guard inside `set` callback: `if (!clip) return`

---

### 2. Race Condition: Concurrent Sync Operations

**File:** `src/services/backup/sync.ts:81-83`

The `isSyncing` flag check and set are not atomic. Multiple rapid `syncNow()` calls can pass the guard before the flag is set.

```typescript
if (this.isSyncing) return  // Line 81
// Race window here
this.setStatus(true, null)   // Line 83
```

**Impact:** Multiple sync operations can run concurrently, causing data corruption, duplicate uploads, or conflicts.

---

### 3. State Inconsistency: Session Created Before Book Validation

**File:** `src/store/session.ts:37-40`

Database is modified before validating the book exists:

```typescript
const session = db.createSession(bookId)  // DB modified
const book = get().books[bookId]
if (!book) { return }  // Too late - session already created
```

**Impact:** Orphaned session records in database for non-existent books.

---

### 4. Missing Error Boundary Components

**File:** `app/` (entire directory)

No error boundaries exist in the app. Any unhandled exception in a screen or component will crash the entire app with no graceful fallback.

**Impact:** App crashes without recovery mechanism. Users lose unsaved state.

---

### 5. Race Condition: TranscriptionQueueService Processing Flag

**File:** `src/services/transcription/queue.ts:82-100`

The `processing` flag is not properly guarded. If `processClip()` throws an unhandled error, the flag remains `true` forever, permanently stalling the queue.

```typescript
if (this.processing) return  // Guard
this.processing = true
while (this.queue.length > 0) {
  await processClip(...)  // If this throws, processing stays true
}
this.processing = false
```

**Impact:** Transcription queue becomes permanently stuck after an error.

---

### 6. Timer Leak in AudioPlayerService.load()

**File:** `src/services/audio/player.ts:65-85`

The `checkDuration` recursive function continues scheduling `setTimeout` calls even after the promise has been rejected by the 10-second timeout. The timeouts at lines 78 and 81 are not cancelled.

**Impact:** Memory leak, potential state corruption from callbacks executing after promise settled.

---

### 7. Partial Upload Failure: Orphaned Files on Drive

**File:** `src/services/backup/sync.ts:466-527`

If JSON uploads successfully but MP3 upload fails:
1. Rollback attempts to delete JSON (line 521) but may fail silently
2. Manifest is never updated (line 506 skipped)
3. Next sync sees orphaned JSON without MP3

**Impact:** Data loss - clips become unrecoverable (JSON metadata without audio file).

---

## High Severity Bugs

### 8. Missing `ref` Prop on Tab Bar Button

**File:** `app/(tabs)/_layout.tsx:45-52`

The custom `tabBarButton` destructures `ref` but never forwards it to the Pressable:

```typescript
tabBarButton: ({ ref, ...props }) => (
  <Pressable {...props} />  // ref not passed
)
```

**Impact:** Tab bar navigation may have focus management and accessibility issues.

---

### 9. Stale Closure in PlayerScreen `handleSeek`

**File:** `src/screens/PlayerScreen.tsx:85-93`

The `handleSeek` callback references `ownBook` but it's missing from the dependency array, causing stale closure bugs.

**Impact:** Seeking may fail or use wrong file URI if book changes.

---

### 10. Race Condition: Navigation Before Async Completion

**File:** `src/screens/ClipsListScreen.tsx:66-74`

```typescript
const handleJumpToClip = async (clipId: string) => {
  router.replace('/player')  // Navigates immediately
  try {
    await seekClip(clipId)   // Might fail after navigation
  } catch (error) { ... }
}
```

**Impact:** User lands on player screen with no audio loaded if `seekClip` fails.

**Fix:** Await `seekClip` first, navigate only on success.

---

### 11. Resource Leak: Large File Memory Issues in Clip Upload

**File:** `src/services/backup/sync.ts:500-502`

MP3 files are read entirely into memory as base64:

```typescript
const mp3Base64 = await RNFS.readFile(clipPath, 'base64')
const mp3Bytes = base64ToUint8Array(mp3Base64)
```

**Impact:** Out-of-memory crash on low-memory devices with large clip files.

---

### 12. Missing Book Deletion Handler in Offline Queue

**File:** `src/services/backup/sync.ts:600-621`

The queue handler processes clip operations but silently ignores book deletions:

```typescript
if (item.entity_type === 'book') {
  // Only upsert handled - delete not implemented
}
```

**Impact:** Books deleted locally while offline will not be deleted remotely.

---

### 13. updateClip State/DB Inconsistency on Slice Failure

**File:** `src/store/clips.ts:96-152`

If `slicer.slice()` fails at line 122-128:
- Database is already updated (line 137)
- Queue is updated (line 140)
- Store update is skipped

**Impact:** Database and sync queue become out of sync with store state.

---

### 14. Silent Token Expiration in Auth

**File:** `src/services/backup/auth.ts:44-72`

`isAuthenticated()` only checks cached sign-in state, not token validity. If token is expired/revoked, sync attempts will fail without proper auth prompt.

**Impact:** Confusing "Sync failed" errors instead of re-authentication flow.

---

### 15. Event Listener Accumulation

**File:** `src/services/audio/player.ts:166-180`

Event listeners registered in `ensureSetup()` are never unregistered. If called multiple times (e.g., on app restart), listeners accumulate.

**Impact:** Memory leak, duplicate callback invocations.

---

### 16. Duplicate Folder Creation Race

**File:** `src/services/backup/drive.ts:208-253`

`ensureFolder()` has caching, but concurrent requests before cache is populated can both create folders. No atomic check-and-create.

**Impact:** Multiple "books" or "clips" folders on Drive; sync may fail or behave unpredictably.

---

### 17. Manifest Cleanup Uses Stale State

**File:** `src/services/backup/sync.ts:170, 320-321`

State is gathered once at sync start (line 170), but `cleanupManifests()` runs at the end (line 321). Entities modified during sync are cleaned up based on stale snapshot.

**Impact:** Valid manifest entries may be incorrectly deleted.

---

### 18. Deep Link Parameters Lost

**File:** `app/+not-found.tsx:1-9`

The catch-all route discards any deep link parameters:

```typescript
export default function NotFound() {
  return <Redirect href="/(tabs)/player" />  // Parameters lost
}
```

**Impact:** Cannot deep link to specific clips or books.

---

### 19. Unhandled Promise in Transcription Queue Start

**File:** `src/services/transcription/queue.ts:69`

`processQueue()` is called without `await` and no error handler:

```typescript
processQueue()  // No await, no .catch()
```

**Impact:** Errors in queue processing are silently swallowed.

---

## Medium Severity Bugs

### 20. Throttle Function Drops Calls

**File:** `src/utils/index.ts:37-46`

The throttle implementation silently drops calls within the throttle interval. For session tracking, rapid updates during the interval are lost entirely.

**Impact:** Session tracking may miss updates; position sync may be delayed.

---

### 21. AppState Listener Recreation

**File:** `src/screens/LibraryScreen.tsx:40-60`

The `useEffect` depends on `sync.pendingCount` and `sync.lastSyncTime`, which change frequently. This recreates the AppState listener repeatedly.

**Impact:** Performance degradation, potential listener leaks.

---

### 22. Missing Null Check in Alert Messages

**File:** `src/screens/LibraryScreen.tsx:96, 119`

Book accessed without existence check before displaying in Alert:

```typescript
const book = books[bookId]  // Could be undefined
Alert.alert('Archive Book', `Archive "${book?.title || book?.name}"?`...)
```

**Impact:** Broken alert message if book was concurrently deleted.

---

### 23. Unhandled Promise in Delete Clip

**File:** `src/screens/ClipsListScreen.tsx:85`

```typescript
onPress: () => deleteClip(clipId)  // No error handling
```

**Impact:** Silent failures without user notification.

---

### 24. Stale `ownBook` Reference in PlayerScreen Effects

**File:** `src/screens/PlayerScreen.tsx:29-38`

Dependency on `ownBook?.uri` creates potential render loop when `playback.uri` changes while `ownBook?.uri` is mismatched.

**Impact:** Potential infinite re-renders or stale book reference.

---

### 25. Race Condition in Async Handlers

**File:** `src/screens/PlayerScreen.tsx:54-83`

`handleAddClip` and `handlePlayPause` reference `ownBook` without checking validity when async operation completes.

**Impact:** Clips may be added to wrong book if user navigates quickly.

---

### 26. Missing Network Retry Logic

**File:** `src/services/backup/drive.ts` (entire file)

All network requests lack retry logic. Transient network errors cause immediate failure with no exponential backoff.

**Impact:** Single network hiccup fails entire sync operation.

---

### 27. Queue Retry Count Reset

**File:** `src/services/backup/queue.ts:137-146`

`retryFailed()` calls `queueChange()` which resets attempts to 0, allowing infinite retry cycles.

**Impact:** Failed items can cycle indefinitely instead of being abandoned after max attempts.

---

### 28. Clip Deletion: Partial Remote Cleanup

**File:** `src/services/backup/sync.ts:575-593`

If JSON file deletes successfully but MP3 deletion fails, manifest is still deleted. Orphaned MP3 remains on Drive forever.

**Impact:** Storage waste, potential confusion in Drive folder.

---

### 29. Date.now() Not Collision-Proof

**File:** Multiple files (`player.ts:66`, `slicer.ts:41`, `whisper.ts:130`, `files.ts:141`)

Using `Date.now()` for filename uniqueness can cause collisions on fast devices or in rapid operations.

**Impact:** File overwrites in edge cases.

---

### 30. Path Normalization Inconsistency

**File:** `src/services/audio/metadata.ts:80-82`, `src/services/storage/files.ts:129`, `src/services/audio/slicer.ts:118`

Different approaches to `file://` prefix handling across services.

**Impact:** Potential path handling bugs if directory names contain "file://".

---

### 31. Base64 Encoding Validation Missing

**File:** `src/services/storage/files.ts:101-102`

No validation of base64 format from `RNFS.read()`. Malformed base64 produces corrupted data silently.

**Impact:** Corrupted fingerprints stored in database.

---

### 32. Missing Dependency in useTimelinePhysics

**File:** `src/components/timeline/useTimelinePhysics.ts:176-182`

External position sync effect has incomplete dependencies, causing position updates to potentially not sync when component is idle.

**Impact:** Timeline may lag behind actual playback position.

---

### 33. Incomplete Sync Notifications

**File:** `src/services/backup/sync.ts:160-163, 430, 571`

`notification.booksChanged` and `notification.clipsChanged` only track downloaded entities. Merged and uploaded entities are not tracked.

**Impact:** UI may show stale data after sync completes.

---

### 34. WAV File Accumulation

**File:** `src/services/transcription/whisper.ts:131-134`

Temporary WAV files may accumulate if transcription process is interrupted (e.g., app force-closed mid-process).

**Impact:** Gradual storage waste.

---

### 35. Native Module Muxer Leak

**File:** `android/.../AudioSlicerModule.kt:199-201`

In `sliceWithMuxer`, if an exception occurs after muxer is created but before `muxer.release()`, the muxer is leaked:

```kotlin
} catch (e: Exception) {
  extractor.release()  // Released
  // muxer NOT released
  promise.reject(...)
}
```

**Impact:** Native resource leak on slice failures.

---

### 36. Unsafe Type in ClipList Component

**File:** `src/screens/ClipsListScreen.tsx:240`

```typescript
function ClipList({ clips, onViewClip, onOpenMenu }: any) {
```

**Impact:** TypeScript protection removed, potential type errors at runtime.

---

### 37. ESLint Suppression in Timeline

**File:** `src/components/timeline/Timeline.tsx:348-349`

`eslint-disable-next-line` suppresses exhaustive-deps warning. May be masking a real dependency issue.

**Impact:** Potential stale closure if code changes.

---

## Low Severity Bugs

### 38. Comment/Code Mismatch

**File:** `src/services/transcription/queue.ts:30-31`

```typescript
const MAX_TRANSCRIPTION_DURATION_MS = 10000  // Comment says "First 5 seconds"
```

**Impact:** Documentation inaccuracy.

---

### 39. Missing Image Error Handling

**File:** `src/screens/SessionsScreen.tsx:57-62`

Image component loads from URI without error handling for broken images.

**Impact:** Blank space shown for broken image URLs.

---

### 40. fetchClips Full Reload

**File:** `src/store/clips.ts:90`

`addClip` calls `fetchClips()` which reloads all clips from database instead of optimistically updating.

**Impact:** UI flickering on clip creation.

---

### 41. Missing Validation in Drive Upload

**File:** `src/services/backup/drive.ts:68-125`

No validation that uploaded audio data is actually valid MP3.

**Impact:** Corrupted files may be uploaded silently.

---

### 42. mapState Silent Default

**File:** `src/services/audio/player.ts:200-211`

Default case returns 'paused' without warning. New `State` enum values would be silently mishandled.

**Impact:** Silent incorrect behavior if TrackPlayer adds new states.

---

### 43. Missing Loading State During Navigation

**File:** `src/screens/ClipsListScreen.tsx`, `src/screens/LibraryScreen.tsx`

No loading indicator shown during async operations before navigation.

**Impact:** User may not understand what's happening during transitions.

---

### 44. Empty Dependency Array Pattern

**File:** `src/components/timeline/useTimelinePhysics.ts:82-88`

The `updateDisplayPosition` callback has empty dependency array. While technically correct (uses only refs), the pattern is fragile for future maintenance.

**Impact:** Potential future bugs if state is added to the callback.

---

### 45. Transcription No Retry

**File:** `src/services/transcription/queue.ts:128`

Failed transcriptions are abandoned forever with no retry mechanism (unlike backup queue).

**Impact:** Clips with failed transcription never get another chance.

---

## Recommendations

### Immediate Priority
1. Add null guards in store `set` callbacks (bugs #1, #5)
2. Add error boundaries to app layout (bug #4)
3. Fix ref forwarding in tab bar (bug #8)
4. Add mutex/lock for sync operations (bug #2)

### Short Term
5. Fix navigation/async race conditions (bugs #10, #25)
6. Add network retry with exponential backoff (bug #26)
7. Implement missing book deletion in offline queue (bug #12)
8. Add proper timer cleanup in AudioPlayerService (bug #6)

### Medium Term
9. Refactor partial upload handling with rollback (bug #7)
10. Add deep link parameter handling (bug #18)
11. Review all useEffect dependencies (bugs #9, #21, #24, #32)
12. Add proper file validation before upload (bug #11, #41)
