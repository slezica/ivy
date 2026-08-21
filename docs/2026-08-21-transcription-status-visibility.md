# Transcription Status Visibility and Network Awareness

**Status: implemented** (branch `transcription-states`).

## The Problem

A user requested a transcription feature Ivy already has. His actual problem: the
Whisper model download (465MB, HuggingFace) had failed silently, and he never
realized a manual retry (buried in Settings) was needed. Diagnosis of the old
behavior:

- One anonymous throw for every start failure — "Failed to start", no cause.
- Failure visible only in Settings; clips simply never transcribed.
- 3 automatic attempts within ~50s of launch, then nothing until next app start.
- No download progress anywhere ("Starting..." for a multi-minute download).
- The 465MB download auto-fired on first launch, enabled by default, possibly
  on cellular.

## The Design

Principle: **show a message for every transcription state that is not what the
user already expects** ('on' when enabled, 'off' when disabled), on the clips
screen — where the absence of transcriptions is felt.

1. **Cause tracking.** WhisperService throws phase-typed errors
   (`ModelDownloadError` / `ModelInitError`); the store records
   `{ cause, message }`. Raw message shown as small print in Settings
   (e.g. `Unable to resolve host "huggingface.co"`).
2. **Download progress.** RNFS progress callback (1% granularity) →
   `downloadProgress` → "Downloading transcription model... (x%)".
3. **Visible backoff.** The queue emits `retry` events between start attempts;
   the store keeps `retryAt`; UI counts down "Retrying in Xs..." client-side
   (no store ticking). Tap-to-retry appears only after retries give up.
4. **The banner.** `TranscriptionBanner` on ClipsListScreen: one discrete muted
   line, 1s appearance debounce (transient states never flash), tappable when
   an action exists. Pure content fn (`transcription_banner_content.ts`),
   unit-tested; Settings shares the same copy helpers so surfaces don't drift.
5. **Metered gate.** Model missing + metered connection (NetInfo
   `isConnectionExpensive`) → `'waiting-wifi'`, no download. "Tap to download
   now" forces it (`{ ignoreMetered: true }`, one-shot). A model already on
   disk starts on any network.
6. **Auto-retry on reconnect.** Store listens to NetworkService: Wi-Fi appears
   while waiting → start; connectivity returns after a download failure →
   retry. This closes the original complaint — the user should never *need*
   to know a retry button exists.

## Rejected Alternatives

- **Red error banner** — deliberately discrete instead; not an app failure.
- **Tap-to-retry as the primary recovery** — automatic backoff + reconnect
  retry make manual retry the last resort, not the first.
- **Settings-only status** — the user's report proved nobody looks there.
- **Gating the whole service on network** — only the download is gated; a
  downloaded model starts offline.

## Verification

Unit: gate/classification/countdown logic (start_transcription, queue retry
events, banner content). Device (emulator, network toggled via `svc`): metered
boot → waiting-wifi; Wi-Fi appears → auto-download with live percent; network
loss mid-download → typed failures, countdown, error state; reconnect →
auto-retry. Full maestro suite green alongside. Captures in `captures/`.
