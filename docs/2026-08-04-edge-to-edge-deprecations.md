# Play Console Edge-to-Edge Deprecation Warning

**Date:** 2026-08-04

## Warning

Play Console flags the uploaded AAB for use of APIs deprecated in Android 15.

<details>
<summary>Full warning text (verbatim)</summary>

> Your app uses deprecated APIs or parameters for edge-to-edge. One or more of
> the APIs you use or parameters that you set for edge-to-edge and window
> display have been deprecated in Android 15. Your app uses the following
> deprecated APIs or parameters:
> android.view.Window.getStatusBarColor / setStatusBarColor /
> setNavigationBarColor / getNavigationBarColor,
> LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES, LAYOUT_IN_DISPLAY_CUTOUT_MODE_DEFAULT
> Traced to: com.facebook.react.modules.statusbar.StatusBarModule (setColor,
> getTypedExportedConstants), com.facebook.react.views.view.WindowUtilKt
> (enableEdgeToEdge, statusBarHide, statusBarShow), com.google.android.material
> bottomsheet/sidesheet EdgeToEdgeUtils, com.swmansion.rnscreens.ScreenWindowTraits
> (setColor, setNavigationBarColor), expo.modules.devlauncher
> DevLauncherExpoActivityConfigurator.setColor

</details>

## Analysis

Ivy itself is clean and already properly edge-to-edge:

- No StatusBar API usage anywhere in `src/` or `app/`. Only hit:
  `statusBarTranslucent` Modal prop in `LibraryLoadingDialog.tsx` — a JS-side
  RN prop, not in the trace.
- `app.json` has `"edgeToEdgeEnabled": true`; the shipped AAB targets SDK 36
  (verified in `playstore/ivy-1.4.2.aab` manifest). Edge-to-edge is enforced
  and the window color APIs are runtime no-ops on Android 15+.

Every traced frame is library code. All five are present in the shipped
release AAB (verified in the `ivy-1.4.2.aab` DEX) — the scan is **static**;
runtime gating doesn't help. Release builds don't minify (R8 off, see "Native
Packaging Changes" in CLAUDE.md), so even dead classes ship.

Per frame — does Ivy ever execute it, and what fixes it upstream:

| Frame | Runtime status in Ivy | Upstream fix |
|---|---|---|
| RN `StatusBarModule` (setColor, constants) | Dead — Ivy never renders `<StatusBar>`; module registered but unused | References present through RN 0.85; removed on `main` only (≥ 0.86, unreleased). No shipping RN fixes it today. |
| RN `WindowUtilKt` (enableEdgeToEdge, statusBarHide/Show) | Executed — this is RN *implementing* edge-to-edge (sets colors to `Color.TRANSPARENT`, cutout-mode fallbacks for pre-API-30/35 devices), all SDK-gated | Still present on RN `main`. Will keep being flagged indefinitely; needed for older devices. |
| `com.google.android.material` `EdgeToEdgeUtils` (bottom/side sheets) | Dead — Ivy uses RN Modal, no material sheets; pulled in by react-native-screens' material dep | Still calls `setStatusBarColor` on material `master` (1.14.x); [issue #4626](https://github.com/material-components/material-components-android/issues/4626) closed as runtime-gated. Will keep being flagged. |
| `ScreenWindowTraits` (setColor, setNavigationBarColor) | Dead — only runs when a screen sets statusBar/navigationBar props; Ivy sets none | **Removed in react-native-screens 4.17.0** ([PR #3264](https://github.com/software-mansion/react-native-screens/pull/3264), released 2025-10-15; verified absent at that tag). SDK 54 pins ~4.16.0; SDK 55 ships 4.23.0. |
| `DevLauncherExpoActivityConfigurator.setColor` | Dead — class lives in expo-dev-launcher `src/main` so it ships in release, but the release-variant controller is a stub that never invokes it | Gone in the SDK 55+ dev-launcher rewrite (verified absent in expo-dev-launcher 57.0.10 tarball). |

Bottom line: for Ivy's users every flagged path is either a no-op (Android
15+ ignores the color setters) or never executes. Two frames (RN core,
material) are not fixed by any released version of anything — fully-updated
Flutter and MAUI apps get the identical warning ([flutter#183372](https://github.com/flutter/flutter/issues/183372),
[maui#28926](https://github.com/dotnet/maui/issues/28926)).

## Risk

- **Informational only.** The warning does not block release, has no
  announced enforcement date, and appears on virtually every RN/Flutter/MAUI
  upload. Play's targetSdk policy is satisfied (36).
- **No user impact.** Behavior on Android 15/16 is already correct
  edge-to-edge; on older devices the deprecated calls still work as intended.
- **Escalation scenario:** Google could someday tie the warning to policy,
  but the flagged residue lives in RN core and material — the entire
  ecosystem moves before that becomes an Ivy problem.

## Plan

Ordered by leverage:

1. **Now: nothing.** No code change fixes anything users see. This doc is the
   deliverable. Effort: zero.
2. **Next Expo SDK upgrade (55/56/57), whenever it happens for its own
   reasons:** removes the `ScreenWindowTraits` and `DevLauncherExpoActivityConfigurator`
   frames (screens ≥ 4.17.0, rewritten dev-launcher). Warning shrinks to RN
   core + material — the irreducible ecosystem floor. Effort: the SDK upgrade
   itself (RN 0.81 → 0.83+, re-check the `react-native-fs` patch, prebuild
   plugins, full e2e run). Verify: build release, upload to internal testing,
   re-read the warning on the release page.
3. **Rejected: out-of-band screens bump to 4.17+ on SDK 54.** Off Expo's
   pinned version (`expo doctor` mismatch, untested combo) to shrink a
   cosmetic warning by one line. Not worth it.
4. **Rejected: enable R8 to strip dead classes.** Minification is
   deliberately off (see CLAUDE.md); it wouldn't remove the RN-core frames
   anyway (StatusBarModule stays reachable via module registration), and it
   adds a whole risk class for zero user-visible gain.
5. **Rejected: patch-package the deprecated calls out of node_modules.**
   Permanent maintenance burden on native code for a warning Google itself
   ships in its own material library.

Full clearance is impossible today: RN keeps deprecated references even on
`main` (`WindowUtilKt` sets transparent colors and cutout-mode fallbacks for
pre-Android-15 devices), and material's `EdgeToEdgeUtils` is unfixed on
`master`. Expect the warning, in shrinking form, for the foreseeable future.

## Sources

- [expo/expo#37459](https://github.com/expo/expo/issues/37459) — the warning in Expo apps
- [software-mansion/react-native-screens#2632](https://github.com/software-mansion/react-native-screens/issues/2632) — screens trace
- [react-native-screens PR #3264](https://github.com/software-mansion/react-native-screens/pull/3264) — native statusBar/navigationBar impl removed (4.17.0, 2025-10-15)
- [facebook/react-native#48256](https://github.com/facebook/react-native/issues/48256) — StatusBarModule trace
- [material-components-android#4626](https://github.com/material-components/material-components-android/issues/4626) / [#4732](https://github.com/material-components/material-components-android/issues/4732) — material EdgeToEdgeUtils
- [flutter/flutter#183372](https://github.com/flutter/flutter/issues/183372) — same warning with correct config, cross-ecosystem
- [Expo SDK 55 changelog](https://expo.dev/changelog/sdk-55) — RN 0.83, screens 4.23.0, edge-to-edge mandatory, status/navigation-bar APIs no-op'd
- [Android 15 behavior changes](https://developer.android.com/about/versions/15/behavior-changes-15) — edge-to-edge enforcement at targetSdk 35
- [Android 16 behavior changes](https://developer.android.com/about/versions/16/behavior-changes-16) — opt-out removed at targetSdk 36
