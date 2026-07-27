import type { SharingService } from '../services'
import type { GetState, Action, ActionFactory } from '../store/types'
import { createLogger } from '../utils'


export interface ShareClipDeps {
  sharing: SharingService
  get: GetState
}

export type ShareClip = Action<[string]>

export const createShareClip: ActionFactory<ShareClipDeps, ShareClip> = (deps) => (
  async (clipId) => {
    const { sharing, get } = deps
    const log = createLogger('ShareClip')

    const { clips } = get()
    const clip = clips[clipId]

    if (!clip) {
      throw new Error('Clip not found')
    }

    const title = clip.note || clip.file_name || clip.source_title || 'Clip'
    const filename = shareFilename(clip.id, clip.uri, clip.file_title || clip.source_title)
    log(`Sharing clip "${title}" as "${filename}"`)

    // Share using the clip's existing audio file
    await sharing.shareClipFile(clip.uri, title, filename)
  }
)

// Recipient apps display the shared file's name, so build a friendly one:
// "Clip from <book title> <uuid8>.m4a". The uuid fragment keeps names unique
// across clips (and stable per clip) without adding visible information.
export function shareFilename(clipId: string, clipUri: string, bookTitle: string | null): string {
  const base = sanitizeFilename(bookTitle ? `Clip from ${bookTitle}` : 'Clip').slice(0, 70).trim()
  const extension = clipUri.match(/\.(\w+)$/)?.[1] ?? 'm4a'
  return `${base} ${clipId.slice(0, 8)}.${extension}`
}

// Strip path separators, control characters, and Windows-reserved characters
function sanitizeFilename(name: string): string {
  return name
    .replace(/[/\\:*?"<>|]/g, ' ')
    .replace(/[\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}
