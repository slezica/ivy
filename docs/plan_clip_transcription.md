# Automatic Clip Transcription

## Overview

Add on-device speech-to-text transcription to clips. When a clip is created, the first 5 seconds of audio is automatically transcribed in the background. Transcriptions are displayed in the UI alongside (not replacing) user notes.

**Context:**
- Clips are stored in SQLite with reference to parent audio file (`file_uri`, `start`, `duration`)
- `AudioSlicerModule` already exists for extracting audio segments
- Privacy matters — all transcription happens on-device

**Decisions:**
- Use Whisper.cpp via `whisper.rn` React Native binding
- Model: `tiny` (~75MB) for speed/size balance
- New `transcription TEXT` column in clips table (nullable)
- `transcription === null` means "not yet processed"
- `transcription === ''` means "processed, no speech detected"
- Background service manages transcription queue, processes sequentially
- Transcription and note are independent fields in UI

**Library:** `whisper.rn` — React Native bindings for Whisper.cpp
- GitHub: https://github.com/mybigday/whisper.rn
- Handles model loading and inference on-device

---

## Phase 1: Database Migration

**End state:** Clips table has `transcription` column. Existing clips have `transcription = null`.

**Requirements:**
- Add migration in `DatabaseService.ts` to add column
- Update `Clip` and `ClipWithFile` interfaces to include `transcription: string | null`
- Update `getClipsForFile` and `getAllClips` queries to select new column

---

## Phase 2: Whisper Native Module

**End state:** App can transcribe a WAV audio file and return text. Model downloads on first use.

**Requirements:**
- Install `whisper.rn` package
- Create `WhisperService.ts` that wraps the library:
  - `initialize()` — downloads tiny model if needed, loads into memory
  - `transcribe(audioPath: string): Promise<string>` — runs inference
  - `isReady(): boolean` — check if model is loaded
- Model storage in app's document directory
- Handle initialization errors gracefully (no crash if model fails to load)

**Note:** Whisper expects 16kHz mono WAV. The service should handle conversion or document this requirement for callers.

---

## Phase 3: Audio Extraction for Transcription

**End state:** Can extract first 5 seconds of a clip as a file suitable for Whisper.

**Requirements:**
- Create utility function `extractClipAudio(clip: Clip, maxDurationMs: number): Promise<string>`
  - Uses existing `AudioSlicerModule.sliceAudio()`
  - Extracts from `clip.start` to `clip.start + min(clip.duration, maxDurationMs)`
  - Returns path to temporary audio file
- Output format must be Whisper-compatible (WAV 16kHz mono)
  - May need audio conversion step — check if `AudioSlicerModule` output works directly
  - If not, add conversion in native code or use ffmpeg-kit

**Integration contract:**
```typescript
// Returns path to temporary WAV file, caller responsible for cleanup
function extractClipAudio(
  fileUri: string,
  startMs: number,
  durationMs: number
): Promise<string>
```

---

## Phase 4: Transcription Queue Service

**End state:** Background service automatically transcribes clips. New clips queued on creation. Pending clips queued on app start.

**Requirements:**
- Create `TranscriptionService` (singleton) with:
  - `start()` — initialize Whisper, scan DB for clips with `transcription === null`, queue them
  - `queueClip(clipId: number)` — add clip to queue
  - Internal queue processed sequentially (one at a time)
  - On completion: update clip's `transcription` field in DB and store
- Integrate with store:
  - Call `transcriptionService.queueClip(id)` after `addClip` succeeds
  - Add `updateClipTranscription(clipId: number, transcription: string)` action
- Start service on app launch (in root layout or store initialization)

**Error handling:**
- If transcription fails, leave `transcription = null` (will retry on next app start)
- If Whisper not ready, skip processing (don't crash)

**Integration contract:**
```typescript
interface TranscriptionService {
  start(): Promise<void>
  queueClip(clipId: number): void
}

// Store action
updateClipTranscription(clipId: number, transcription: string): void
```

---

## Phase 5: UI Updates

**End state:** Clip cards show transcription text when available, separate from notes.

**Requirements:**
- Update `ClipList` in `ClipsListScreen.tsx`:
  - Show transcription below timestamp (before note)
  - Style differently from note (e.g., italic, lighter color)
  - Only show if `transcription` is non-null and non-empty
- Consider truncating long transcriptions with ellipsis

---

## Final Notes

- Delete this file when feature is complete
- Future enhancements (not in scope):
  - Settings screen to enable/disable transcription
  - Model size selection (tiny/base/small)
  - Re-transcribe option in clip menu
  - Transcription language selection
