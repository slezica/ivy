# Bug Report - Ivy

Comprehensive bug analysis conducted on 2026-01-21.

## Summary

| Severity | Count |
|----------|-------|
| Critical | 0 |
| High | 0 |
| Medium | 18 |
| Low | 8 |

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

### Short Term
1. Fix navigation/async race conditions (bugs #25)
2. Add network retry with exponential backoff (bug #26)
3. Fix queue retry count reset (bug #27)

### Medium Term
4. Review all useEffect dependencies (bugs #21, #24, #32)
5. Add proper file validation before upload (bug #41)
6. Fix native muxer resource leak (bug #35)
