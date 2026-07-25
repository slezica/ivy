# Clip Creation Through the Draft Editor

**Date:** 2026-07-25

## Idea

The player's clip button used to create a clip immediately (10s from the current position) with a toast. Now it opens the ClipEditor on a **draft**: selection seeded at `[position, position + 10s]`, empty note. Save creates the clip; Cancel creates nothing.

## Rationale

- Bounds and note are set at capture time, in one gesture, instead of create-then-edit round trips.
- One slice, one transcription. The old flow sliced on tap; adjusting bounds afterwards re-sliced and re-transcribed.
- Clean cancel semantics — no clip row, no sync tombstone churn.
- "Unified players": the editor and the main player behave as one continuous playback. Opening and closing the editor transfers ownership with the same file, position, and playing/paused state. The hand-back position is the editor's playhead, so scrubbing in the editor moves the book position — intentional.
- The editor plays at 1x (existing clip-owner rule) even if the book has a speed set. Deliberate: clips are often shared, and at 1x you hear what the recipient will hear. The book's speed is restored on return.

## Implementation

- `addClip(bookId, start, { duration?, note? })` — explicit bounds/note from the editor; defaults preserved (10s, capped to remaining audio).
- ClipEditor became **mode-free**: normalized props (`fileUri`, `fileDuration`, `title`, `ownerId`, `initialStart/End/Note`). Callers map their semantics — ClipsListScreen maps an existing clip, PlayerScreen maps a draft. The editor has no draft/edit branch.
- `ownerId` is a prop, so PlayerScreen claims playback ownership *for* the editor (`clip-editor-draft`) before mounting it, and reclaims for `MAIN_PLAYER_OWNER_ID` before unmounting — the editor's pause-on-unmount then no-ops and audio never stops. `loadBook` was exposed as a store action for the paused-state claims.
- Sessions need no changes: the ownership transfer finalizes the main player's session, and the 5-minute resume window merges it on return.

## Rejected Alternatives

- **Create-then-edit** (tap → addClip → open editor on the new clip): minimal change, but slices and queues transcription immediately, re-slices on bounds edit, and cancel would either leave a clip behind or require delete + tombstone churn.
- **Separate ClipDraftEditor component**: would force extracting a shared base plus two wrappers that hold only initialization — speculative structure. The mode-free normalized-props component gives callers ownership of semantics without the extra layer; if the flows diverge structurally later, it already is the "base".
- **Editor-side handoff** (editor claims ownership on mount via an `initialPlayback` prop): pushes playback-transition knowledge into the editor. Caller-side claiming keeps the editor unchanged and the handoff logic in one place (PlayerScreen).
