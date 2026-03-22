# The Transcription System

A guide for Ivy's on-device clip transcription.

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
│              │ └──────────────────────┘
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

The service converts input audio to the format Whisper expects (16kHz mono PCM WAV) using `react-native-audio-api` for decoding, then writes a temp WAV file. The temp file is cleaned up after transcription regardless of outcome.

### Running transcription

With the model loaded and audio prepared, it calls `context.transcribe(wavPath, { language: 'en' })`. The result is trimmed and returned.

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

  while queue is not empty AND started:
    clipId = queue.shift()    // FIFO
    processClip(clipId)

  processing = false
```

The `processing` flag is the key concurrency guard. It ensures only one clip is being transcribed at any time. The flag is reset in a `finally` block to prevent it from getting stuck if a clip fails.

### The 10-second limit

Only the first 10 seconds of each clip are transcribed. This is defined by `MAX_TRANSCRIPTION_DURATION_MS = 10000`. The audio slicer extracts `min(clip.duration, 10000)` milliseconds.

This is a practical tradeoff: transcription is CPU-intensive, and most clips are short bookmarks where the first few seconds capture the key content.

---

## Integration with the Store

### State

```typescript
transcription: {
  status: 'off' | 'starting' | 'on' | 'error'
  pending: Record<string, true>   // clip IDs currently queued
}
```

- `status` reflects the service lifecycle: `'off'` (disabled or uninitialized), `'starting'` (initializing, possibly downloading model), `'on'` (ready and processing clips), `'error'` (failed to start). The user's desired state lives in `settings.transcription_enabled`, not here.
- `pending` tracks individual clips (used by UI to show loading indicators)

### Automatic queueing

Two store actions integrate with transcription as a side effect:

- **`addClip()`** — after creating a clip, calls `transcription.queueClip(clip.id)`. If the service isn't started (feature disabled), this is a no-op.
- **`updateClip()`** — if the clip's bounds changed (start or duration), clears the transcription, re-extracts audio from the source, and re-queues the clip.

---

## Edge Cases and Robustness

### Processing flag stuck after error

The `processing` flag is reset in a `finally` block inside `processQueue()`. Even if `processClip()` throws, the flag is properly cleared and the queue can process the next clip. This was a real bug (documented in test comments) that caused the queue to permanently stall.

### Queue while stopped

Calling `queueClip()` when the service isn't started is a silent no-op. The clip won't be transcribed until the service starts and queries the database for pending clips.

### Start/stop lifecycle

`start()` is idempotent — concurrent calls share the same initialization promise. Each call re-asserts `started = true`, so a `stop()` followed by `start()` during initialization cancels the stop intent. Retry logic (3 attempts with backoff) lives inside the service. After initialization, `doStart()` checks `started` before processing the queue — if `stop()` was called and not re-asserted, it bails.

### Stop while processing

`stop()` clears the queue and resets `started` to false, but does **not** reset `processing`. The currently processing clip isn't interrupted — it runs to completion. The processing loop then exits on its next iteration because the `started` check in the while condition fails, and the `finally` block resets `processing` naturally. This avoids a race where re-starting the service while a clip is still in flight could bypass the concurrency guard.

---

## File Map

```
src/services/transcription/
  queue.ts          → TranscriptionQueueService (job queue, sequential processing)
  whisper.ts        → WhisperService (model management, audio conversion, inference)
  __tests__/
    queue.test.ts   → Error recovery, concurrency, and start/stop lifecycle tests

src/services/audio/
  slicer.ts         → AudioSlicerService (native module wrapper, extracts audio segments)

src/actions/
  start_transcription.ts  → Starts the service, transitions status (starting → on/error)
  stop_transcription.ts   → Stops the service, sets status to 'off'
  add_clip.ts             → Queues new clips for transcription
  update_clip.ts          → Re-queues clips when bounds change

src/store/index.ts        → Wires transcription events to store state

src/screens/
  SettingsScreen.tsx       → Toggle + status display

src/components/
  ClipViewer.tsx           → Displays transcription text
```
