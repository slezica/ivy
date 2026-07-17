# Maestro E2E Flows

End-to-end flows driving the real app on a device/emulator. Unlike Jest, these
exercise native modules — the exec'd FFmpeg slicer, the document picker, real
playback — so they catch native-packaging regressions JS tests can't see (e.g.
the clip-add linker crash: a missing `NEEDED` soname is invisible to Jest but
fails the slice on device).

## Running

Against any attached device or emulator:

```bash
adb devices                        # find the target's serial
maestro --device <serial> test maestro/<flow>.yaml
```

Flows that import a file (`load-and-play`, and anything chaining off it) need
the test audio present and **media-scanned** so the system picker's search can
find it:

```bash
adb -s <serial> push assets/test/test-audio.mp3 /sdcard/Download/test-audio.mp3
adb -s <serial> shell am broadcast -a android.intent.action.MEDIA_SCANNER_SCAN_FILE \
  -d file:///sdcard/Download/test-audio.mp3
```

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
| `add-clip.yaml` | Clip creation → FFmpeg slice → toast → clip listed (chains off `load-and-play`) |

Picker interaction uses **search by filename** (`option_menu_search` +
`inputText`), which is tolerant of DocumentsUI variants (AOSP vs Google) and
avoids the flaky roots-drawer navigation.
