# Maestro E2E Flows

End-to-end flows driving the real app on a device/emulator. Unlike Jest, these
exercise native modules — the exec'd FFmpeg slicer, the document picker, real
playback — so they catch native-packaging regressions JS tests can't see (e.g.
the clip-add linker crash: a missing `NEEDED` soname is invisible to Jest but
fails the slice on device).

## Which build to install

Run the suite against the **maestro** build variant — a preview clone whose
`ivy_build_variant` resource unlocks test affordances (currently: the 5s sleep
timer preset, the short 1/3s transcription-start retry backoff, and timeline
interaction tracing — `src/components/timeline/trace.ts`).
Preview and release deliberately carry zero test surface, so
`sleep-timer.yaml` fails against them; debug works but adds Metro dependency
and dev-mode overhead. Maestro >= 2.8 (the toolkit is tested against it).

```bash
bin/ivy.ts build maestro --install    # env-aware; add --arch arm64-v8a for the emulator
```

The maestro variant is **not debuggable**, so flows that check the DB through
the bridge (`artwork-cap.yaml`) need a **rootable emulator image** (adb root)
plus `sqlite3` on the host — a Play-image AVD fails that flow. The same build
feeds `bin/ivy.ts test --upgrade` (migration smoke test, emulator-only,
destructive — see docs/MIGRATIONS.md).

## Running

With one device/emulator attached:

```bash
bin/ivy.ts test --e2e                        # full suite
bin/ivy.ts drive --file maestro/add-clip.yaml # a single flow
bin/ivy.ts test --e2e --device <serial>      # target a specific device
```

The toolkit pushes and **media-scans** the test fixtures first (the picker's
search needs them indexed) — the one prerequisite the import flows require: the
main fixture (`test-audio.m4a`, standard tags: narrator/summary/date + chapters),
a fully-tagged one (`test-audio-2.m4a`, adds series/part/subtitle/language via
Libation-style freeform atoms — details-view coverage and manual testing), an
oversized-cover one (`test-audio-cover.m4a`, for `artwork-cap.yaml`), plus
a disposable copy (`delete-me.m4a`) that
`delete-original.yaml` imports with "delete original after import" enabled. After
the run, the toolkit asserts the disposable copy is actually gone — the deletion
is filesystem state the flow itself can't see. With multiple devices attached,
pass `--device <serial>` (the toolkit forwards it to adb and maestro).

A single flow also runs by name through the wrapper: `bin/ivy.ts test --e2e
transcription-states`.

To bypass the wrapper (e.g. debugging one flow), the raw command is
`maestro --device <serial> test maestro/<flow>.yaml`, after pushing the fixture.
Flows that call the bridge (below) additionally need `bin/ivy.ts test
--server-only` running and `-e BRIDGE_URL=http://127.0.0.1:7799` passed to
maestro.

## The toolkit bridge

Maestro's JS sandbox can't run adb, so device control during a flow goes
through a small HTTP server the toolkit starts automatically for every e2e
run (`test --e2e`, `drive --file/--inline`), injecting its address as the
`BRIDGE_URL` env var. Flows call it with the shared helper:

```yaml
- runScript: { file: scripts/bridge.js, env: { CMD: "net/wifi/off" } }
```

Endpoints are a curated semantic vocabulary (`net/wifi/on|off`,
`net/data/on|off`, `check/artwork-cap`, plus a `health` probe — see
`BRIDGE_ENDPOINTS` in `bin/ivy.ts`); adb knowledge stays in the toolkit,
never in yaml. Network endpoints refuse non-emulator devices, server errors
fail the calling flow, and the toolkit restores wifi+data after every bridged
run (emulator only). The port defaults to 7799, overridable via
`test --server-only --port <n>` / `$IVY_BRIDGE_PORT`.

Flows that use `launchApp.clearState` wipe app data — **only run against test
devices/emulators**, never a device with real library data.

## From the sandbox container

The container reaches a host-run emulator over TCP adb:

```bash
bin/ivy.ts device connect          # adb connect host.docker.internal:5555
adb devices                        # now lists the host's emulator
```

Note the container image does not ship `maestro` itself — driving flows from
here needs it installed first; toolkit commands that only use adb (`capture`,
`tree`, `logs`, `query`, `drive --tap/--nav`) work as-is.

Run the emulator on the host (accelerated via Hypervisor.framework — no nested
virtualization needed):

```bash
$ANDROID_HOME/emulator/emulator -avd <name> -no-audio -no-boot-anim &
```

## Flows

| Flow | What it covers |
|------|----------------|
| `smoke-test.yaml` | App launches, empty state, tab bar |
| `load-and-play.yaml` | Import via document picker → metadata/chapters → playback |
| `add-clip.yaml` | Clip creation → FFmpeg slice → toast → clip listed |
| `chapter-extraction.yaml` | Chapter extraction (the other native FFmpeg consumer) → chapter shown, not empty-state |
| `clip-crud.yaml` | Clip create → edit note → verify persistence → delete |
| `clip-dismiss-release.yaml` | Dismissing a clip dialog returns playback to the main player: paused, same book, same position (cross-book) |
| `book-details.yaml` | Extras extracted on import → details viewer → edit narrator → verify persistence |
| `delete-original.yaml` | Import with "delete original after import" enabled (own import steps, disposable fixture); the toolkit asserts the file is gone post-run |
| `timeline-gestures.yaml` | Tap-seek / scrub / flick on the Skia timeline; app stays responsive |
| `artwork-cap.yaml` | Oversized-cover import → native extraction cap → bridge DB check (`check/artwork-cap`) |
| `sleep-timer.yaml` | Arm 5s preset → countdown on button → expiry pauses playback, clears timer (maestro/debug builds only) |
| `transcription-states.yaml` | Model-download lifecycle via bridge network control: metered gate (waiting-wifi) → auto-download on Wi-Fi → failure backoff countdown → give-up (tap-to-retry, Settings match) → auto-retry on reconnect (maestro/debug builds only: fast backoff) |

Every flow is **independently runnable** — each starts from `clearState` and does
its own setup, so `maestro test maestro/` (which runs flows alphabetically) has
no ordering dependency. Most import via `subflows/import-book.yaml` (`runFlow`);
`artwork-cap.yaml` and `delete-original.yaml` carry their own import steps
(different fixtures), and `smoke-test.yaml` / `transcription-states.yaml` don't
import at all. `config.yaml` scopes the suite to top-level `*.yaml`, excluding
`subflows/`. Outside the suite, `playstore/screenshots.yaml` drives the Play
Store screenshot set (run via `bin/ivy.ts generate --screenshots`).

### Conventions learned the hard way

- **Picker: search by filename** (`option_menu_search` + `inputText`) — tolerant
  of DocumentsUI variants (AOSP vs Google), avoids flaky roots-drawer navigation.
- **Saving after text input**: the first tap on a button with the keyboard up is
  consumed dismissing the keyboard, not delivered. Tap, then conditionally tap
  again `when: visible` the button. Don't use `hideKeyboard` **inside dialogs** —
  on Android it sends Back, which dialogs treat as Cancel. (Outside dialogs it's
  fine and several flows use it, e.g. after the picker's search field.)
- **Launch offline, then restore**: import flows launch with wifi+data off
  (bridge `net/*` calls), toggle transcription off in Settings, and only then
  restore connectivity — otherwise the ~465MB whisper model download starts on
  first launch and saturates the emulator. `subflows/import-book.yaml` carries
  the full rationale.
- **Editor Cancel returns to the ClipViewer, not the list** — `Close` the viewer
  to reach the list.

### Known hotspot

The import flows take ~90s each on the emulator, almost entirely the one-time
`FFmpeg.init()` unpack + cold-link on the first ffmpeg call after `clearState`
(chapter extraction during import). It's fixed cost per fresh install; the actual
slice/extraction work is ~40ms. A warm-up step (one throwaway ffmpeg call before
the timed assertions, or not clearing state between flows) is the lever if the
suite's ~8min runtime becomes a problem.
