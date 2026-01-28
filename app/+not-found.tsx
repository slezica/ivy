import { Redirect, useGlobalSearchParams } from 'expo-router'

/**
 * Catch-all for unmatched routes (e.g., notification deep links).
 */
export default function NotFound() {
  return <Redirect href={'/'} />
}
