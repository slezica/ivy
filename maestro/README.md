# Maestro E2E Flows

End-to-end flows driving the real app on a device/emulator. Unlike Jest, these
exercise native modules — the exec'd FFmpeg slicer, the document picker, real
playback — so they catch native-packaging regressions JS tests can't see (e.g.
the clip-add linker crash: a missing `NEEDED` soname is invisible to Jest but
fails the slice on device).

## Running

With one device/emulator attached, run the whole suite like the Jest tests:

```bash
npm run test:e2e                              # full suite
npm run test:e2e -- maestro/add-clip.yaml     # a single flow
npm run test:e2e -- --device <serial>         # target a specific device
```

`scripts/e2e.sh` pushes and **media-scans** the test fixture first (the picker's
search needs it indexed) — the one prerequisite the import flows require. With
multiple devices attached, set `ANDROID_SERIAL=<serial>` (adb honors it) and also
pass `--device <serial>` through to maestro.

To bypass the wrapper (e.g. debugging one flow), the raw command is
`maestro --device <serial> test maestro/<flow>.yaml`, after pushing the fixture.

Flows that use `launchApp.clearState` wipe app data — **only run against test
devices/emulators**, never a device with real library data.

## From the sandbox container

The container reaches the host's adb server, so a host-run emulator (or plugged
phone) is visible here once `adb` points at it. Maestro looks for a local adb
server on `localhost:5037`, so bridge it to the host:

```bash
socat TCP-LISTEN:5037,fork,reuseaddr TCP:host.docker.internal:5037 &
adb devices                        # now lists the host's emulator
```

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
| `timeline-gestures.yaml` | Tap-seek / scrub / flick on the Skia timeline; app stays responsive |

Every flow is **independently runnable** — each pulls in `subflows/import-book.yaml`
via `runFlow` to set up its own book, so `maestro test maestro/` (which runs
flows alphabetically) has no ordering dependency. `config.yaml` scopes the suite
to top-level `*.yaml`, excluding `subflows/`.

### Conventions learned the hard way

- **Picker: search by filename** (`option_menu_search` + `inputText`) — tolerant
  of DocumentsUI variants (AOSP vs Google), avoids flaky roots-drawer navigation.
- **Saving after text input**: the first tap on a button with the keyboard up is
  consumed dismissing the keyboard, not delivered. Tap, then conditionally tap
  again `when: visible` the button. Don't use `hideKeyboard` — on Android it
  sends Back, which dialogs treat as Cancel.
- **Editor Cancel returns to the ClipViewer, not the list** — `Close` the viewer
  to reach the list.

### Known hotspot

The import flows take ~90s each on the emulator, almost entirely the one-time
`FFmpeg.init()` unpack + cold-link on the first ffmpeg call after `clearState`
(chapter extraction during import). It's fixed cost per fresh install; the actual
slice/extraction work is ~40ms. A warm-up step (one throwaway ffmpeg call before
the timed assertions, or not clearing state between flows) is the lever if the
suite's ~8min runtime becomes a problem.
