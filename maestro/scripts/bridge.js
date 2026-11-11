// Toolkit bridge call — device control from inside a flow.
//
// Usage (CMD = semantic endpoint, see BRIDGE_ENDPOINTS in bin/ivy-dev.ts):
//   - runScript: { file: scripts/bridge.js, env: { CMD: "net/wifi/off" } }
//
// The bridge server and the BRIDGE_URL env var are provided automatically by
// `bin/ivy-dev.ts test --e2e` and `drive --file/--inline`. Bare `maestro test`
// has neither — start one with `bin/ivy-dev.ts test --server-only` and pass
// `-e BRIDGE_URL=...` yourself.

if (typeof BRIDGE_URL === 'undefined' || !BRIDGE_URL) {
  throw new Error(
    'BRIDGE_URL not set — run this flow via `bin/ivy-dev.ts test --e2e` or ' +
    '`bin/ivy-dev.ts drive --file`, or start `bin/ivy-dev.ts test --server-only` and ' +
    'pass -e BRIDGE_URL=... to maestro')
}

var response
try {
  response = http.get(BRIDGE_URL + '/' + CMD)
} catch (e) {
  throw new Error(
    'toolkit bridge unreachable at ' + BRIDGE_URL + ' — is ' +
    '`bin/ivy-dev.ts test --server-only` still running? (' + e + ')')
}

if (!response.ok) {
  throw new Error('bridge ' + CMD + ' failed: ' + response.body)
}
