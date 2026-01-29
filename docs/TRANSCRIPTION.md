# The Transcription System

A teaching guide for Ivy's on-device clip transcription. Start here — no code reading required.

## Table of Contents

1. [The Big Picture](#the-big-picture)
2. [Core Concepts](#core-concepts)
3. [Architecture Overview](#architecture-overview)
4. [The Whisper Service](#the-whisper-service)
5. [The Queue](#the-queue)
6. [Integration with the Store](#integration-with-the-store)
7. [Lifecycle: Start, Stop, and Re-queue](#lifecycle-start-stop-and-re-queue)
8. [Edge Cases and Robustness](#edge-cases-and-robustness)
9. [File Map](#file-map)

---

## The Big Picture

When a user creates a clip (a bookmarked audio segment), Ivy automatically transcribes it using on-device speech recognition. No server, no internet, no data leaving the phone. The transcription appears in the clip viewer as quoted text.

This is powered by [Whisper](https://github.com/openai/whisper), OpenAI's open-source speech recognition model, running natively via `whisper.rn`. The model (~150MB) downloads once on first use and is cached locally.

**What gets transcribed:**
- The first **10 seconds** of each clip's audio

**What triggers transcription:**
- Creating a new clip
- Editing a clip's bounds (start/duration) — clears the old transcription and re-queues

**What doesn't trigger transcription:**
- Editing a clip's note (that's user-written, separate from transcription)
- Clips created while the feature is disabled (they're picked up when re-enabled)

---

## Core Concepts

### 1. Two separate services, one pipeline

The system is split into two services that each do one thing:

- **WhisperService** — knows how to prepare audio and run the model. One transcription at a time, no queue awareness.
- **TranscriptionQueueService** — knows which clips need transcribing and in what order. Feeds clips to Whisper one by one.

The queue owns the lifecycle. Whisper is a tool it uses.

### 2. Sequential by design

Transcription is CPU-intensive. Running multiple clips simultaneously would degrade the user experience. The queue processes clips one at a time, in FIFO order. This is a deliberate constraint, not a limitation.

### 3. Privacy-first

Everything happens on-device. The Whisper model runs locally via native bindings. The only network request is downloading the model file itself (from HuggingFace), and that happens once.

---

## Architecture Overview

```
┌──────────────────────────────────────────────────────────┐
│                       Zustand Store                       │
│                                                           │
│  transcription: { status, pending }                       │
│  actions: startTranscription, stopTranscription           │
└───────┬────────────────────────────────────────┬──────────┘
        │ calls start/stop/queueClip             │ subscribes to events
        ▼                                        │
┌─────────────────────────────────────┐          │
│     TranscriptionQueueService       │          │
│                                     │          │
│  queue: string[]  (clip IDs)        │          │
│  processing: boolean                │          │
│  started: boolean                   │          │
│                                     │          │
│  Events:                            │          │
│    queued → { clipId }              │──────────┘
│    started → { clipId }             │
│    finish → { clipId, transcription?, error? }
│    status → { status }              │
└───────┬──────────────┬──────────────┘
        │              │
        │ calls        │ calls slice()
        │ transcribe() │
        ▼              ▼
┌──────────────┐ ┌──────────────────────┐
│ WhisperService│ │  AudioSlicerService  │
│              │ │  (native Kotlin)     │
│ initialize() │ │                      │
│ transcribe() │ │  Extracts first 10s  │
│              │ │  of clip audio       │
│ Events:      │ └──────────────────────┘
│  status      │
└──────────────┘
```

**Three files, clear responsibilities:**

| File | Role | Has side effects? |
|------|------|:-:|
| `whisper.ts` | Model download, audio conversion, native transcription | Yes |
| `queue.ts` | Job queue, clip lifecycle, sequential processing | Yes |
| `(audio/slicer.ts)` | Extracts audio segments from source files | Yes |

---

## The Whisper Service

The Whisper service wraps the native `whisper.rn` library. It handles three concerns: getting the model, preparing the audio, and running inference.

### Model download

On first use, the service downloads `ggml-small.bin` (~150MB) from HuggingFace:

1. Check if model exists at `{DocumentDirectory}/whisper/ggml-small.bin`
2. If not, download to a `.download` temp file
3. Only rename to the final path after the download completes successfully

This atomic-rename pattern means a partial download (from a crash or lost connection) is simply overwritten on the next attempt. The app never tries to load a corrupt model file.

A `downloading` flag prevents concurrent download attempts — if two calls race to initialize, the second one gets an error rather than starting a duplicate download.

### Audio preparation

Whisper requires a very specific input format: **16kHz mono 16-bit PCM WAV**. Most audio files aren't in this format, so the service converts them:

1. **Decode** — `react-native-audio-api` decodes the input file at 16kHz sample rate
2. **Mix to mono** — if the audio has multiple channels, they're averaged into one
3. **Convert samples** — float32 samples (range -1.0 to 1.0) are scaled to int16 (range -32768 to 32767), with clamping to prevent overflow
4. **Build WAV** — a 44-byte WAV header is prepended to the PCM data
5. **Write** — the result is base64-encoded and written to a temp file

The temp WAV is cleaned up after transcription, regardless of success or failure.

### Running transcription

With the model loaded and audio prepared:

```
context.transcribe(wavPath, { language: 'en' }) → text
```

The result is trimmed and returned. The service emits `status: 'processing'` before and `status: 'idle'` after.

### Initialization deduplication

Multiple parts of the app might trigger initialization concurrently (e.g., the queue starts while a clip is being created). The service stores the initialization promise and returns it to all concurrent callers:

```
If already initialized → return immediately
If currently initializing → return the existing promise
Otherwise → start initializing, store the promise
```

---

## The Queue

The TranscriptionQueueService manages which clips need transcription and processes them one at a time.

### Data structure

The queue is a simple in-memory array of clip IDs (`string[]`). It's not persisted — but this is fine, because on startup the service queries the database for all clips with `transcription = null` and re-populates the queue.

### Processing loop

```
processQueue():
  if not started → return
  if already processing → return
  if queue empty → return
  if whisper not ready → return

  processing = true
  emit status: 'processing'

  while queue is not empty AND started:
    clipId = queue.shift()    // FIFO
    processClip(clipId)

  processing = false
  emit status: 'idle'
```

The `processing` flag is the key concurrency guard. It ensures only one clip is being transcribed at any time. The flag is reset in a `finally` block to prevent it from getting stuck if a clip fails.

### Processing a single clip

For each clip:

1. Look up the clip in the database
2. Skip if not found or already has a transcription
3. Extract the first 10 seconds of the clip's audio (via AudioSlicerService)
4. Call `whisper.transcribe()` on the extracted audio
5. Save the transcription to the database
6. Emit a `finish` event (with the transcription text, or with an error)
7. Clean up the temp audio file

If any step fails, the error is caught and emitted — but processing continues with the next clip in the queue. One bad clip doesn't stall the whole pipeline.

### The 10-second limit

Only the first 10 seconds of each clip are transcribed. This is defined by `MAX_TRANSCRIPTION_DURATION_MS = 10000`. The audio slicer extracts `min(clip.duration, 10000)` milliseconds.

This is a practical tradeoff: transcription is CPU-intensive, and most clips are short bookmarks where the first few seconds capture the key content.

---

## Integration with the Store

### State

```typescript
transcription: {
  status: 'idle' | 'downloading' | 'processing'
  pending: Record<string, true>   // clip IDs currently queued
}
```

- `status` reflects the overall pipeline state (shown in Settings)
- `pending` tracks individual clips (used by UI to show loading indicators)

### Events → State

The store subscribes to three events from the queue service:

| Event | Store update |
|-------|-------------|
| `queued` | Sets `pending[clipId] = true` |
| `finish` | Deletes `pending[clipId]`, calls `updateClip()` if transcription succeeded |
| `status` | Updates `transcription.status` |

The `status` event has three values:
- `'idle'` — nothing happening
- `'downloading'` — Whisper model is being fetched (first use only)
- `'processing'` — at least one clip is being transcribed

### Actions

Two actions control the transcription lifecycle:

- **`startTranscription()`** — calls `transcription.start()`. This initializes Whisper, queries the database for untranscribed clips, and begins processing.
- **`stopTranscription()`** — calls `transcription.stop()` and clears `pending` from the store. The queue is emptied immediately, but any clip currently being transcribed will finish (the in-progress transcription isn't interrupted).

### Automatic queueing

Two other actions integrate with transcription without being "transcription actions":

- **`addClip()`** — after creating a clip, calls `transcription.queueClip(clip.id)`. If the service isn't started (feature disabled), this is a no-op.
- **`updateClip()`** — if the clip's bounds changed (start or duration), clears the transcription, re-extracts audio from the source, and re-queues the clip.

---

## Lifecycle: Start, Stop, and Re-queue

### App startup

On app launch, the store reads `settings.transcription_enabled`. If true, it calls `transcription.start()`, which:

1. Initializes Whisper (downloading the model if needed)
2. Queries the database for all clips where `transcription IS NULL`
3. Queues each one

This means clips created while the feature was disabled are picked up automatically when it's re-enabled.

### User toggles the setting

In Settings, there's a toggle for transcription:

- **Enable** → calls `updateSettings()` then `startTranscription()`. The start process finds any untranscribed clips.
- **Disable** → calls `updateSettings()` then `stopTranscription()`. The queue is cleared. Any clip mid-transcription finishes, but its result is still saved.

### Settings screen status display

The Settings screen shows contextual status text:
- `'downloading'` → "Downloading model..."
- `'processing'` → "Processing..."
- `'idle'` → nothing shown

---

## Edge Cases and Robustness

### Concurrent initialization

If `initialize()` is called while already in progress, the second call gets the same promise as the first. No duplicate work.

### Concurrent model download

A `downloading` boolean prevents two downloads from running simultaneously. The second call throws an error rather than racing.

### Processing flag stuck after error

The `processing` flag is reset in a `finally` block inside `processQueue()`. Even if `processClip()` throws, the flag is properly cleared and the queue can process the next clip. This was a real bug (documented in test comments) that caused the queue to permanently stall.

### Queue while stopped

Calling `queueClip()` when the service isn't started is a silent no-op. The clip won't be transcribed until the service starts and queries the database for pending clips.

### Stop while processing

`stop()` clears the queue and resets `started` to false, but does **not** reset `processing`. The currently processing clip isn't interrupted — it runs to completion. The processing loop then exits on its next iteration because the `started` check in the while condition fails, and the `finally` block resets `processing` naturally. This avoids a race where re-starting the service while a clip is still in flight could bypass the concurrency guard.

### Clip not found or already transcribed

`processClip()` re-checks the database before transcribing. If the clip was deleted between queueing and processing, or if it somehow already has a transcription, it's silently skipped.

### Source book archived

Clips have their own audio files separate from the source book. Transcription uses the clip's own file (`clip.uri`), so it works even when the source book has been archived and its file deleted.

### Stereo audio

The WAV conversion mixes multi-channel audio to mono by averaging all channels per sample. This matches Whisper's requirement for single-channel input.

### Sample value overflow

Float-to-int16 conversion clamps values to [-1.0, 1.0] before scaling, preventing integer overflow that could produce audio artifacts or crashes.

---

## File Map

```
src/services/transcription/
  queue.ts          → TranscriptionQueueService (job queue, sequential processing)
  whisper.ts        → WhisperService (model management, audio conversion, inference)
  __tests__/
    queue.test.ts   → Error recovery and concurrency tests

src/services/audio/
  slicer.ts         → AudioSlicerService (native module wrapper, extracts audio segments)

src/actions/
  start_transcription.ts  → Starts the transcription service
  stop_transcription.ts   → Stops the service, clears pending state
  add_clip.ts             → Queues new clips for transcription
  update_clip.ts          → Re-queues clips when bounds change

src/store/index.ts        → Wires transcription events to store state

src/screens/
  SettingsScreen.tsx       → Toggle + status display

src/components/
  ClipViewer.tsx           → Displays transcription text
```
