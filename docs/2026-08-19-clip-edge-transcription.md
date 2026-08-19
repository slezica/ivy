# Clip Edge Transcription (Exploration — Postponed)

**Status: postponed.** Design discussion recorded for later pickup. No implementation.

## Problems

1. **Edge errors while editing.** Easy to end up with extra/missing words at clip
   bounds — erring ~0.5s on either edge clips or leaks words.
2. **Slow transcription after save.** Bounds edits clear and re-queue transcription;
   the result takes a while to appear.

## Idea

Background transcription during editing. Two halves:

- **Invisible:** pre-compute during editing so the transcript is (seemingly) instant
  on save.
- **Visible:** show the words at the clip's start/end in real time while adjusting
  bounds, as an aid against edge errors.

## Key findings

- `whisper.rn` supports `tokenTimestamps: true` + `maxLen: 1` → per-word segments
  with `t0`/`t1` timestamps. Word-level timing is available.
- **Whisper physics:** the encoder always processes 30s mel windows. Transcribing a
  2s segment costs nearly the same as 30s. "Tiny segments are fast" is mostly false —
  this kills any per-tweak re-transcription scheme.
- Device reality (from personal use): inference is slower than real time for 30s
  audio. Whisper cannot keep up with live bounds dragging.

## Approaches considered

- **A — Windowed pre-transcription (preferred).** At editor open, transcribe a
  window covering the clip ± margin once, with word timestamps. Then:
  - Edge words while dragging = timestamp lookup. Instant, zero inference.
  - Transcript on save = slice of words inside bounds. Instant.
  - Bounds exit window → debounced background re-window.
  - Bonus: enables snap-to-word-boundary (attacks problem 1 directly).
- **B — Debounced edge re-transcription. Rejected.** Seconds of latency per
  adjustment, pays the 30s-encoder cost every time.
- **C — A + canonical re-queue.** Window-sliced text shown/saved as provisional;
  full standalone transcription re-queued after save and replaces it. Only needed if
  slice-vs-standalone text divergence matters. "Perhaps after A, we see."

## Service abstraction (agreed shape, if resumed)

A range-transcription service: caller asks for a transcription of
`(sourceUri, start, duration)`; result may come from memory or be computed —
caller doesn't know or care. Note this differs from today's queue, which
transcribes the clip's *own* audio file, not a source range.

- API sketch: `transcribeRange(sourceUri, start, duration) → Promise<string>`,
  `hint(sourceUri, range)` (interest signal), `forget(sourceUri)` (cancel/discard).
- Internals: window cache keyed by source+window holding word-timestamped results;
  single-flight whisper access with priority over the background queue; debounce;
  re-window when bounds move outside.
- **Windowing is the core policy, not an optimization.** Exact-range speculation
  restarts on every tweak and almost never finishes before save (last tweak → save
  is typically seconds). One window inference started at editor open turns the whole
  editing session (tens of seconds) into the compute budget — that's what makes
  "instant on save" reachable at all.
- Rollout instinct: implement under the hood first, no UI — sole objective is
  instant-on-save. Lets us evaluate without risking bad UI.

## Concerns (why postponed)

1. Hard work for dubious gain; risk of building it and discarding it.
2. **Text divergence:** window-sliced text ≠ standalone clip transcription (context
   differs, word timestamps fuzzy ±100–200ms, shakier on the `small` model). The
   persisted transcript changes character. C would fix, at extra cost.
3. **Long clips:** >30s needs multiple windows and stitching; seams are the weak
   point. Would likely cap service to ≤ N min, falling back to today's queue path.
4. **Cancellation:** unverified whether whisper.rn can abort mid-inference. If not,
   a stale job blocks the pipeline for its full runtime.
5. Two whisper consumers (existing queue + new service) need a shared
   access/priority layer around `WhisperService`.

## Testing plan (if resumed)

Service is pure orchestration → FakeWhisper in jest with controlled timing,
cancellation, and races — same pattern as sync's FakeDrive harness. Toolkit access
to transcription internals deferred until real-device tuning shows what's needed.
