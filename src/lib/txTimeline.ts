/**
 * Stage-by-stage clock for one transaction attempt, started when the app receives the request (the Send click) and
 * continued after the hash exists (receipt lookups, confirmation). All numbers are milliseconds since the click.
 */
export interface Timeline {
  t0: number
  marks: { name: string; ms: number }[]
}

export const newTimeline = (): Timeline => ({ t0: performance.now(), marks: [{ name: 'Request received by the app (Send clicked)', ms: 0 }] })

/** Records a stage once. Later calls with the same name are ignored, so "first" events stay first. */
export function mark(tl: Timeline | undefined, name: string): void {
  if (!tl || tl.marks.some((m) => m.name === name)) return
  tl.marks.push({ name, ms: Math.round(performance.now() - tl.t0) })
}

/** Plain-text table: elapsed since click, and the gap since the previous stage. */
export function formatTimeline(tl: Timeline): string {
  let prev = 0
  return tl.marks
    .map((m) => {
      const line = `${String(m.ms).padStart(7)} ms  (+${String(m.ms - prev).padStart(6)} ms)  ${m.name}`
      prev = m.ms
      return line
    })
    .join('\n')
}
