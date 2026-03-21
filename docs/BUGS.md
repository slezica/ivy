# Bug Report — 2026-03-19

Systematic audit across four vertical slices: Library, Playback & Sessions, Clips & Transcription, Sync & Backup.

All bugs have been addressed as of 2026-03-21.

### BUG-17: Double DB write on transcription finish (won't fix)

**Location:** `src/store/index.ts`

When transcription finishes:
1. `TranscriptionQueueService.processClip()` writes to DB directly
2. The store's `onTranscriptionFinish` handler calls `updateClip()` action, which writes to DB again and queues a sync operation

**Impact:** Redundant DB write and spurious sync queue entry per transcription.

**Decision:** Accepted. The queue service should be self-contained and persist its own results. The double write is harmless, and the extra sync entry is a no-op remotely.
