/**
 * Timeline components for audio scrubbing and selection.
 */

export * from './constants'
export * from './utils'

// Unified component (preferred)
export { Timeline } from './Timeline'
export type { TimelineProps } from './Timeline'
export { useTimelinePhysics } from './useTimelinePhysics'
export type { UseTimelinePhysicsOptions, TimelinePhysicsResult, SelectionConfig } from './useTimelinePhysics'

// Legacy components (deprecated, kept for reference)
export { useScrollPhysics } from './useScrollPhysics'
export type { UseScrollPhysicsOptions, ScrollPhysicsResult } from './useScrollPhysics'
export { PlaybackTimeline } from './PlaybackTimeline'
export { SelectionTimeline } from './SelectionTimeline'
export type { SelectionTimelineProps } from './SelectionTimeline'
