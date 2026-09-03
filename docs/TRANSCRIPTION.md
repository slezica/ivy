# The Transcription System

A guide for Ivy's on-device clip transcription.

## The Big Picture

When a user creates a clip (a bookmarked audio segment), Ivy automatically transcribes it using on-device speech recognition. No server, no internet, no data leaving the phone. The transcription appears in the clip viewer as plain text under a "Transcription" label.

This is powered by [Whisper](https://github.com/openai/whisper), OpenAI's open-source speech recognition model, running natively via `whisper.rn`. The model (~465MB) downloads once on first use and is cached locally.

**What gets transcribed:**
- The first **3 minutes** of each clip's audio (longer clips get a `...` suffix marking the cut)

**What triggers transcription:**
- Creating a new clip
- Editing a clip's bounds (start/duration) — clears the old transcription and re-queues

**What doesn't trigger transcription (immediately):**
- Editing a clip's note (that's user-written, separate from transcription)
- Clips created while the feature is disabled (they're picked up when re-enabled)
- Clips arriving via sync with `transcription = null` — nothing queues them on arrival; they wait for the next service start, which queries the database for untranscribed clips

---

## Core Concepts

### 1. Two separate services, one pipeline

The system is split into two services that each do one thing:

- **WhisperService** — knows how to prepare audio and run the model. No queue awareness — and no internal lock: sequencing is entirely the queue's guarantee.
- **TranscriptionQueueService** — knows which clips need transcribing and in what order. Feeds clips to Whisper one by one.

The queue owns the lifecycle. Whisper is a tool it uses.

### 2. Sequential by design

Transcription is CPU-intensive. Running multiple clips simultaneously would degrade the user experience. The queue processes clips one at a time, in FIFO order. This is a deliberate constraint, not a limitation.

### 3. Privacy-first

Everything happens on-device. The Whisper model runs locally via native bindings. The only network request is downloading the model file itself (from HuggingFace), and that happens once.

---

## Architecture Overview

Three files, clear responsibilities:

- **`queue.ts`** (TranscriptionQueueService) — job queue (`queue: string[]` of clip ids, `processing`, `started`), clip lifecycle, sequential processing. Events the store subscribes to:
  - `queued → { clipId }`
  - `started → { clipId }`
  - `retry → { attempt, maxAttempts, delayMs, error }` (between failed start attempts)
  - `finish → { clipId, transcription?, error?, start, duration }`
- **`whisper.ts`** (WhisperService) — model download, audio conversion, native inference. The store also subscribes to its `status` events directly — that's what drives the `'downloading'` state.
- **`audio/slicer.ts`** — extracts the first 3 minutes of clip audio (native, shared with the clips system).

The store calls `start`/`stop`/`queueClip` on the queue; the queue calls `whisper.transcribe()` and `slicer.slice()`.

---

## The Whisper Service

The Whisper service wraps the native `whisper.rn` library. It handles three concerns: getting the model, preparing the audio, and running inference.

### Model download

On first use, the service downloads `ggml-small.bin` (~465MB) from HuggingFace:

1. Check if model exists at `{DocumentDirectory}/whisper/ggml-small.bin`
2. If not, download to a `.download` temp file
3. Only rename to the final path after the download completes successfully

This atomic-rename pattern means a partial download (from a crash or lost connection) is simply overwritten on the next attempt. The app never tries to load a corrupt model file.

Concurrent `initialize()` calls share the same initialization promise (see below), so the download never runs twice in practice. A `downloading` flag inside `ensureModelDownloaded` remains as a defensive guard: a hypothetical concurrent entry would throw rather than start a duplicate download.

### Audio preparation

The service converts input audio to the format Whisper expects (16kHz mono PCM WAV) using `react-native-audio-api` for decoding, then writes a temp WAV file. The temp file is cleaned up after transcription regardless of outcome.

### Running transcription

With the model loaded and audio prepared, it calls `context.transcribe(wavPath, { language: 'en' })` — the language is hard-wired to English; non-English audio is decoded as English. The result is trimmed and **stripped of enclosing quotes** (straight and curly, `stripEnclosingQuotes` in utils) — Whisper commonly wraps output in quotation marks. Existing rows were backfilled by migration 12.

### Initialization deduplication

Multiple parts of the app might trigger initialization concurrently (e.g., the queue starts while a clip is being created). The service stores the initialization promise and returns it to all concurrent callers; once initialized, `initialize()` returns immediately.

### The model is never released

Nothing calls `WhisperService.release()`: disabling transcription clears the queue and status but leaves the Whisper context (and its ~465MB of memory) resident. The flip side: re-enabling is instant. Current behavior, not a contract.

---

## The Queue

The TranscriptionQueueService manages which clips need transcription and processes them one at a time.

### Data structure

The queue is a simple in-memory array of clip IDs (`string[]`). It's not persisted — but this is fine, because on startup the service queries the database for all clips with `transcription = null` and re-populates the queue.

### Processing loop

`processQueue()` bails unless started, not already processing, queue non-empty, and Whisper ready; then it shifts clip ids FIFO while the queue is non-empty and the service stays started. The `processing` flag is the key concurrency guard — only one clip is transcribed at any time — and is reset in a `finally` block so a failed clip can't stall the queue.

Per clip, `processClip` re-queries `getClipsNeedingTranscription()` (a full untranscribed-clips query, not a by-id lookup) and skips clips that are gone or already transcribed — emitting a bare `finish` with no result so listeners clear their pending state.

### The 3-minute limit

Only the first 3 minutes of each clip are transcribed. This is defined by `MAX_TRANSCRIPTION_DURATION_MS = 180000`. The audio slicer extracts `min(clip.duration, 180000)` milliseconds.

This is a practical tradeoff: transcription is CPU-intensive, and the cap only exists to bound pathological cases — real clips are almost always shorter. When a clip exceeds the cap, `...` is appended to the (non-empty) transcription to mark the cut.

---

## Integration with the Store

### State

```typescript
transcription: {
  status: 'off' | 'starting' | 'downloading' | 'waiting-wifi' | 'on' | 'error'
  downloadProgress: number | null  // 0-100, only while downloading
  error: { cause: 'download-failed' | 'init-failed' | 'unknown', message: string } | null
  retryAt: number | null           // Wall-clock time of the next automatic start attempt
  pending: Record<string, true>   // clip IDs currently queued
}
```

- `status` reflects the service lifecycle: `'off'` (disabled or uninitialized), `'starting'` (initializing), `'downloading'` (model download in progress, with `downloadProgress` percent), `'on'` (ready and processing clips), `'error'` (failed to start). The user's desired state lives in `settings.transcription_enabled`, not here.
- `'downloading'` is driven by the WhisperService's `status` events (the store subscribes directly): entered only from `'starting'`, and returned to `'starting'` when the download ends — `startTranscription` alone decides the final `'on'`/`'error'`.
- `error` records why the last start (or the latest failed attempt) failed. WhisperService throws phase-typed errors (`ModelDownloadError` / `ModelInitError`, in `transcription/errors.ts` — a leaf module free of native imports, which also houses the `classifyTranscriptionError` helper); the store classifies them into `cause` and keeps the raw `message` for diagnostics. Cleared on every start and on stop.
- `retryAt` is set from the queue's `retry` events (emitted between failed start attempts) and cleared when a retry attempt starts downloading, when the start resolves, and on stop. `error` is populated alongside it, so UI can show "failed, retrying in Xs" during the backoff window while `status` is still `'starting'`.
- `'waiting-wifi'` comes from the metered gate (below).
- `pending` tracks individual clips (used by UI to show loading indicators)

### Network awareness (metered gate + auto-retry)

`startTranscription` never auto-downloads the 465MB model on a **metered** connection: when the model is missing (`whisper.isModelDownloaded()`) and `NetworkService` reports metered (NetInfo's `isConnectionExpensive`), it sets `status = 'waiting-wifi'` and stops. A model already on disk starts regardless of network. `startTranscription({ ignoreMetered: true })` — the banner's "Tap to download now" and the Settings "Download now" link — forces the download; the choice is one-shot, not persisted.

The store listens to `NetworkService` `change` events (listener started in `initializeApplication`) and, when transcription is enabled:

- `'waiting-wifi'` + unmetered connection appears → auto-start (the gate re-checks)
- `'error'` with cause `'download-failed'` + connectivity returns → auto-retry (a metered connection lands back on `'waiting-wifi'` via the gate)

Re-entrancy is safe: `startTranscription` sets `'starting'` synchronously, so repeated network events no-op through the status checks. A second guard (`startsInFlight` counter) keeps a concurrent gate check from regressing state to `'waiting-wifi'` while a manual `ignoreMetered` download is in flight.

### The clips-screen banner

`TranscriptionBanner` (rendered by ClipsListScreen) shows a discrete one-line message for every transcription state the user wouldn't expect — downloading (with percent), waiting for Wi-Fi (tap to download now), retrying after a failure (with countdown), or given up (tap to retry, which just runs `startTranscription`). Content selection is a pure function in `transcription_banner_content.ts` (unit-tested); the component adds a 1s appearance debounce (transient states never flash) and a local 1 Hz tick for the countdown — the store itself never ticks. SettingsScreen shares the same copy helpers (`failureLabel`, `downloadingMessage`, `retryingMessage`), so the two surfaces never drift.

### Automatic queueing

Two store actions integrate with transcription as a side effect:

- **`addClip()`** — after creating a clip, calls `transcription.queueClip(clip.id)`. If the service isn't started (feature disabled), this is a no-op.
- **`updateClip()`** — if the clip's bounds changed (start or duration), clears the transcription, re-extracts audio from the source, and re-queues the clip.

### Persistence: the store is the single writer

The queue **never writes the database**. Its `finish` event carries the result *plus the clip bounds the job was started with*; the store's handler compares those bounds against the current clip and **discards stale results** (the clip's bounds were edited mid-transcription — the re-queued job for the new audio supersedes it). The general rule for the pending indicator: on every `finish`, `pending` is cleared unless the queue still holds a job for that clip (`hasQueuedJob(clipId)`) — which is what keeps the spinner alive through a stale result. For current results the handler runs the `updateClip` action, which persists the text and queues the clip for sync. An **empty string is a valid result** (silence, music) and is persisted like any other text; only errored jobs skip persistence, leaving `transcription = null` so a later service start re-queues the clip.

---

## Edge Cases and Robustness

### Processing flag stuck after error

The `processing` flag is reset in a `finally` block inside `processQueue()`. Even if `processClip()` throws, the flag is properly cleared and the queue can process the next clip. This was a real bug (documented in test comments) that caused the queue to permanently stall.

### Queue while stopped

Calling `queueClip()` when the service isn't started is a silent no-op. The clip won't be transcribed until the service starts and queries the database for pending clips.

### Start failure drains the queue

If all start attempts fail (Whisper never becomes ready), `doStart()` sets `started = false`, empties the queue, and emits a `finish` event **with an error** for every abandoned clip — so listeners (the store) clear their pending indicators instead of spinning forever. It then **rethrows the last error**: that rejection is what makes `startTranscription` land on `'error'`. The clips still have `transcription = null` in the database, so a later successful `start()` picks them up again.

### Start/stop lifecycle

`start()` is idempotent — concurrent calls share the same initialization promise. Each call re-asserts `started = true`, so a `stop()` followed by `start()` during initialization cancels the stop intent. Retry logic (3 attempts with backoff, no delay after the last) lives inside the service; the two delays are injected via deps — 5/15s in production, 1/3s on test builds (`isTestBuild()`, wired in `services/index.ts`) so the `transcription-states.yaml` e2e flow can traverse the whole state machine (metered gate → auto-download → backoff countdown → give-up → recovery) via the toolkit bridge's network control. After initialization, `doStart()` checks `started` before processing the queue — if `stop()` was called and not re-asserted, it bails.

### Stop while processing

`stop()` clears the queue and resets `started` to false, but does **not** reset `processing`. The currently processing clip isn't interrupted — it runs to completion. The processing loop then exits on its next iteration because the `started` check in the while condition fails, and the `finally` block resets `processing` naturally. This avoids a race where re-starting the service while a clip is still in flight could bypass the concurrency guard.

---

## File Map

```
src/services/transcription/
  queue.ts          → TranscriptionQueueService (job queue, sequential processing)
  whisper.ts        → WhisperService (model management, audio conversion, inference)
  errors.ts         → Phase-typed init errors (ModelDownloadError, ModelInitError)
  __tests__/
    queue.test.ts   → Error recovery, concurrency, and start/stop lifecycle tests

src/services/audio/
  slicer.ts         → AudioSlicerService (native module wrapper, extracts audio segments)

src/services/system/
  network.ts        → NetworkService (NetInfo wrapper: connectivity + metered events)

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
  ClipItem.tsx             → "Transcribing..." row indicator (from transcription.pending)
  TranscriptionBanner.tsx  → Clips-screen status banner (unexpected states only)
  transcription_banner_content.ts → Pure banner content logic (unit-tested)

src/screens/
  ClipsListScreen.tsx      → Search matches transcription text
```

**Testing:** `src/services/transcription/__tests__/queue.test.ts`, `src/components/__tests__/transcription_banner_content.test.ts`, `src/actions/__tests__/start_transcription.test.ts`; maestro flow `transcription-states.yaml` (needs the maestro build variant).
