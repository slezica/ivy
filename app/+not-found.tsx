import { Redirect, useGlobalSearchParams } from 'expo-router'

/**
 * Catch-all for unmatched routes (e.g., notification deep links).
 * Redirects to the player tab, preserving any query parameters.
 */
export default function NotFound() {
  const params = useGlobalSearchParams()

  // Build query string from params if any exist
  const queryString = Object.entries(params)
    .filter(([_, value]) => value !== undefined)
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`)
    .join('&')

  const href = queryString ? `/(tabs)/player?${queryString}` : '/(tabs)/player'

  return <Redirect href={href} />
}
