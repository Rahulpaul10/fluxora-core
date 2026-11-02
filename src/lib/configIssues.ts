/**
 * Misconfiguration found while reading environment variables. Collected once at startup and shown in the UI,
 * so a typo in .env produces a clear message instead of a feature that silently does nothing.
 */
const issues: string[] = []

export function reportConfigIssue(message: string) {
  if (!issues.includes(message)) issues.push(message)
  console.warn(`[FLUXORA config] ${message}`)
}

export const getConfigIssues = (): readonly string[] => issues
