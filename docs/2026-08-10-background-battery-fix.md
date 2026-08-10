# Background Battery Fix: Narrow Selectors + Freeze

**Date:** 2026-08-10

## Problem

Android (Galaxy S25, Android 16) flagged Ivy for excessive battery use after ~4h
of screen-off listening. `dumpsys batterystats` showed Ivy as the device's #1
consumer: 314 mAh, ~2h48m user CPU against ~3h32m of playback — roughly 30% of
a core busy the whole time audio played, split evenly between the JS thread
(`mqt_v_js`, 97 min) and the UI thread (62 min). ExoPlayer itself (including
0.9x time-stretch) was ~4%.

## Cause

The render pipeline, not playback:

1. RNTP emits a progress event every 1s → store `set(playback.position)`.
2. Every screen and dialog subscribed with selector-less `useStore()` — a
   whole-store subscription that re-renders on *any* state change.
3. Screen-off does not stop React: the playback service keeps the JS runtime
   alive, reconciliation runs on the JS thread, and Fabric still commits view
   updates on the UI thread. Only the final draw is skipped.

Net: the entire mounted tree (tab navigator, Library list with base64 artwork,
player + Skia timeline, clips list) re-rendered once per second, for hours,
with the screen off.

## Fix

1. **Narrow selectors** — every `useStore()` call site selects specific fields
   (`useStore(s => s.books)`). Position ticks now re-render only position
   consumers. Components that don't show position (Library, tab bar) select
   scalar playback fields (`status`/`uri`/`ownerId`) and skip the 1 Hz tick
   entirely.
2. **`<Freeze>` on background** — root layout wraps the app in react-freeze's
   `<Freeze freeze={backgrounded}>` driven by AppState. While backgrounded,
   state updates apply normally but renders are deferred (React Suspense);
   one catch-up render happens on wake. react-freeze was already installed as
   a react-native-screens dependency; promoted to a direct dependency.

## Rejected alternatives

- **Custom store notification gate** (suppress zustand listener notifications
  while backgrounded, flush on wake): same semantics as `<Freeze>` but
  hand-rolled at the store layer. Library at the React layer is simpler and
  maintained.
- **`enableFreeze(true)`** (react-native-screens, freezes unfocused navigator
  screens): redundant once selectors are narrow; known tab-responsiveness
  issue reports.
- **Throttling the 1 Hz `db.updateBookPosition` write**: measured cost is
  ~1-2ms of native work per second — negligible next to the render churn, and
  keeping it means crash/kill loses 0s of resume position.
- **Reducing RNTP's progress event rate**: the player screen wants 1s
  resolution while visible; the event itself is cheap once handlers are.

## Verification

Thread-level CPU during screen-off playback, before → after:

```bash
adb shell top -b -H -d 2 -n 5 -p $(adb shell pidof com.salezica.ivy)
```

Before (release, S25): `mqt_v_js` ~15%, main thread ~15%. Expected after:
both ~0-2% (only the 1 Hz event handler + fire-and-forget writes remain).
Debug builds inflate absolute numbers; compare like against like.
