import { Redirect } from 'expo-router'

/**
 * Catch-all for unmatched routes (e.g., notification deep links).
 * Redirects to the player tab.
 */
export default function NotFound() {
  return <Redirect href="/(tabs)/player" />
}
