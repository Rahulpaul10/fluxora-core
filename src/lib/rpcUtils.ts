/** Small helpers for talking to a rate-limited public RPC without making things worse. */

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

const messageOf = (error: unknown): string => {
  const parts: string[] = []
  let cur: unknown = error
  for (let i = 0; i < 6 && cur; i++) {
    if (cur instanceof Error) parts.push(cur.message)
    cur = (cur as { cause?: unknown }).cause
  }
  return parts.join(' ').toLowerCase()
}

/** The endpoint is throttling us. Splitting the request would only multiply the load: wait and retry instead. */
export const isRateLimitError = (error: unknown): boolean => /rate limit|too many requests|429|exceeds defined limit/.test(messageOf(error)) && !isRangeError(error)

/** The query itself is too wide (block range or result count): splitting it is the right fix. */
export const isRangeError = (error: unknown): boolean => /range|too large|more than \d+ results|max results|query returned/.test(messageOf(error))

/** Runs fn over items with at most `limit` in flight. Results keep the input order. */
export async function pool<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array<R>(items.length)
  let next = 0
  const worker = async () => {
    while (next < items.length) {
      const i = next++
      out[i] = await fn(items[i])
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return out
}

/** Retries only rate-limit failures, with exponential backoff. Anything else is thrown immediately. */
export async function withRateLimitRetry<T>(run: () => Promise<T>, attempts = 4): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await run()
    } catch (error) {
      if (!isRateLimitError(error) || i >= attempts - 1) throw error
      await sleep(500 * 2 ** i)
    }
  }
}
