import { Redirect, usePathname } from 'expo-router'

/**
 * Catch-all for unmatched routes.
 * Tapping the playback notification sends a trackplayer:// deep link
 * with pathname /notification.click — redirect to the player tab.
 */
export default function NotFound() {
  const pathname = usePathname()
  const isNotificationTap = pathname === '/notification.click'

  return <Redirect href={isNotificationTap ? '/player' : '/'} />
}
