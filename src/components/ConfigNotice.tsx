import { useState } from 'react'
import { getConfigIssues } from '@/lib/configIssues'
import { Notice } from './ui'

/** Lists environment variables that are set but wrong. Nothing is shown when the configuration is clean. */
export function ConfigNotice() {
  const [hidden, setHidden] = useState(false)
  const issues = getConfigIssues()
  if (hidden || issues.length === 0) return null
  return (
    <Notice tone="warn" action={<button className="underline" onClick={() => setHidden(true)}>Hide</button>}>
      <span className="block font-semibold">Configuration problem</span>
      <ul className="mt-1 list-disc space-y-0.5 pl-5 text-xs">
        {issues.map((i) => (
          <li key={i}>{i}</li>
        ))}
      </ul>
      <span className="mt-1 block text-xs opacity-80">See .env.example and docs/CONFIGURATION.md, then restart or rebuild.</span>
    </Notice>
  )
}
