# Sleep Timer

Feature #1 from IDEAS.md. Count down N minutes, fade out, pause.

## Rationale

The point is not timing sleep. It's knowing the book won't advance more than N
minutes after you fall asleep, so finding last night's position is a bounded
search. This kills the "end of chapter" mode from the original idea: nobody
times falling asleep with chapter boundaries.

## UI

Presets used in examples: 10m / 30m / 60m. **Provisional** — values can change
at any time.

### Player screen

- Chapter list moves out of its button into a floating three-dot menu, top-left
  (player stays headerless — minimalism). Menu action: "Show chapters".
- Freed button slot becomes the sleep timer button.
- Icon: Ionicons `moon-outline`. Provisional — Ionicons has no clock-with-z;
  breaking the one-lib rule for MaterialIcons `snooze` remains an option if
  moon reads poorly in context.
- **Active state:** button swaps icon for live remaining time, speed-button
  style ("12m"). Round minutes **up**, stop at "1m" — no seconds.

### Dialog

- Title "Sleep timer".
- Label below: "Off", or remaining time ticking live ("12:43").
- Row of side-by-side buttons: "Off", "10m", "30m", "60m".
- Selecting dismisses the dialog. Re-selecting the running preset resets the
  clock.
- All buttons always enabled. The current state gets *visual indication only*
  (border, no fill), never disabled: the goal is "mark what you just did", not
  forbid the tap — and re-tapping the same option must work (reset / changed my
  mind about changing my mind). Comfort over correctness; evaluate in practice.

## Countdown semantics — DECIDED

**Pure wall-clock, starts on set.** `endsAt = now + duration`, exactly like
setting a timer in a clock app. Decided after user interviews (2026-07-24):
opinions differed, but the clock-app mental model won.

Discarded alternatives, kept for the record:

1. **Arm on set, start on play.** Framing: armed timer = "next listening
   session capped at N minutes". Set while playing → starts immediately; set
   while paused → waits, armed. Motivated by the anxiety problem (classic in
   Audible): timer starts while you're still walking to bed — TIME RUNNING
   OUT. Stupid but real. Interviews outweighed it.
2. **SET-button dialog.** Vertical full-text options ("Off", "10 minutes", …),
   tick on selected, single "SET" button. Deliberate confirmation UX. Does
   not solve the anxiety problem — moves the start by seconds. Orthogonal to
   variant 1; could have combined.

Playback-linked countdown (freezes while paused) was considered and rejected:
requires a pause/resume state machine, and a timer still ticking next morning
is stranger than an armed one.

## Behavior

- **Fade-out:** last 10 seconds of the interval (included in duration) ramp
  volume down, then pause. Gentle — a hard cut startles the half-asleep.
- **Expiry:** timer clears to "Off" after firing.
- **Global scope:** timer pauses whatever is playing, regardless of playback
  owner. "Stop audio in N minutes" is the intent.

## Implementation notes

- **Store:** `playback.sleepTimer` state, set via action. Screen only renders.
  Timer logic hooks playback status events in the store, never the screen —
  remote controls (notification, lock screen) bypass the UI entirely.
- **Fade:** needs `TrackPlayer.setVolume`, so the ramp helper lives in
  `AudioPlayerService`. Scheduling lives in the action layer.
- **Ticking displays** (dialog "12:43", button "12m") compute locally from
  `endsAt` with their own intervals — zero store churn.
- **Volume restore:** after fade+pause, reset volume to 1.0, or the next
  manual play is silent. Same on manual pause mid-fade. Re-arming during a
  fade cancels the fade and restores volume first.
- **Book ends before timer:** playback stops naturally; timer later fires as a
  no-op and clears. No special handling.
- **Sessions:** timer pause goes through normal `pause()`, so session
  finalization is automatic.
- **Persistence:** none. Timer is ephemeral, does not survive app restart.
