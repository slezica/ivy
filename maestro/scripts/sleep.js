// Busy-wait — maestro has no sleep command. Use sparingly, for real-time
// effects a flow must let happen (playback advancing, a timer running):
//   - runScript: { file: scripts/sleep.js, env: { MS: "3000" } }
var end = Date.now() + Number(MS)
while (Date.now() < end) {}
