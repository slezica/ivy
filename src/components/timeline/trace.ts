/**
 * Timeline interaction tracing.
 *
 * Ultra-granular logging of timeline internals for diagnosing interaction
 * oddities that only reproduce under live monkeying: every gesture input,
 * every engine mode transition (with cause), every external-position
 * decision, seek, and selection emission — plus a low-rate state sample.
 *
 * Test builds only (debug/maestro, via ivy_build_variant): in production
 * builds every call no-ops. Continuous sources (panUpdate, state samples)
 * are throttled at the call site so tracing doesn't perturb the timing it
 * observes.
 *
 * Reading the stream: `bin/ivy.ts logs --follow --tag ReactNativeJS`, then
 * grep TLTRACE. Timestamps are performance.now() ms, the same clock the
 * engine runs on. Each line carries the emitting instance's id — the player
 * and the clip editor mount separate timelines.
 */

import { isTestBuild } from '../../services'

export const traceEnabled = isTestBuild()

let nextInstance = 0

/** Short per-timeline id: 'T0', 'T1', ... in mount order. */
export function traceInstanceId(): string {
  return `T${nextInstance++}`
}

export function timelineTrace(instance: string, tag: string, detail = ''): void {
  if (!traceEnabled) return
  console.log(`TLTRACE ${performance.now().toFixed(1)} ${instance} ${tag}${detail ? ' ' + detail : ''}`)
}
