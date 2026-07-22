/**
 * Toast helper
 *
 * Fire-and-forget Android toast notifications.
 */

import { ToastAndroid } from 'react-native'

export function toast(message: string): void {
  ToastAndroid.show(message, ToastAndroid.SHORT)
}
