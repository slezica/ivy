/**
 * Clipboard helper
 *
 * Fire-and-forget copy to the system clipboard with a confirmation toast.
 */

import * as Clipboard from 'expo-clipboard'
import { toast } from './toast'

export function copyText(value: string): void {
  Clipboard.setStringAsync(value)
  toast('Copied')
}
