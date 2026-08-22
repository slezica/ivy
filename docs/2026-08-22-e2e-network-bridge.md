# E2E Network Bridge (Toolkit ↔ Maestro Device Control)

**Status: implemented.** Enables e2e coverage of the transcription-status
states (docs/2026-08-21-transcription-status-visibility.md), which require
toggling device network state *mid-flow*.

## The Problem

Maestro has no shell/adb step (long-open upstream requests: issues #247,
#1682, #1507) and its JS sandbox exposes only `http.*` — no filesystem, no
child_process. But the transcription states are driven by network transitions
(metered → Wi-Fi → offline → reconnect) that must happen at precise points
inside a flow.

## Decision: auto-provisioned HTTP bridge

The toolkit starts a small localhost HTTP server for every e2e run
(`test --e2e`, `drive --file/--inline`), injects `BRIDGE_URL` into maestro's
env, and tears it down afterwards, restoring wifi+data (emulator only). Flows
call it through a shared helper:

```yaml
- runScript: { file: scripts/bridge.js, env: { CMD: "net/wifi/off" } }
```

Key detail making this work: `runScript` executes on the **maestro CLI host**
(the container), not the device — `http.get('http://127.0.0.1:…')` reaches
the toolkit directly.

Design rules:

- **Semantic endpoints only** (`net/wifi/on|off`, `net/data/on|off`): adb
  knowledge stays in the toolkit; yaml states intent. No generic `/adb?cmd=`
  escape hatch — resist until a real need appears.
- **Server errors fail the test**: non-200 responses carry the error message;
  `bridge.js` throws it into the flow. Connection-refused throws a message
  pointing at the toolkit (`run via bin/ivy.ts test --e2e`).
- **Silent when green**: no logging in normal operation; server output goes to
  a tmp log file for postmortem.
- **Network endpoints refuse non-emulator devices** (same guard as the
  toolkit's destructive commands).
- The bridge runs as a toolkit **child process**: the parent blocks on
  spawnSync while maestro runs, so an in-process server could never answer.

Companion changes: `test [name]` runs a single case (jest pattern or flow
name; requires exactly one of --unit/--e2e), `test --server-only` starts just
the bridge for hand-run maestro sessions, and the transcription-start retry
backoff is injected as 1/3/5s on test builds (5/15/30s in production) so the
states flow traverses backoff → give-up in seconds.

## Rejected Alternatives

- **Toolkit-as-runner with per-flow special handling** (adb hooks before/after
  each flow): full control, but test semantics migrate from yaml into toolkit
  code, scenarios split across ordered flow fragments, and maestro's JVM
  startup (~3-5s) lands inside state transitions — fatally slow against a
  1/3/5s backoff. The bridge keeps the yaml as the complete test description;
  the toolkit's role stays provisioning, which is the existing contract
  (fixtures already work that way).
- **Boundary-chopped phase flows** (network changes between flows, states
  asserted from persistence): workable for the stable states, fragile for the
  countdown, and couples flows through ordering.

## Consequence

A flow calling the bridge is meaningless under bare `maestro test` — it fails
in `bridge.js` with instructions. Accepted; documented in maestro/README.md.
