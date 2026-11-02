import type { AppKit } from '@circle-fin/app-kit'

/**
 * The Circle bridge kit is large (over 1 MB). It is loaded on demand, and warmed in the background, so opening
 * the Bridge page does not wait for it and the rest of the app never pays for it.
 */
let kitPromise: Promise<AppKit> | undefined
let adapterPromise: Promise<typeof import('@circle-fin/adapter-viem-v2')> | undefined

export function loadBridgeKit(): Promise<AppKit> {
  kitPromise ??= import('@circle-fin/app-kit').then((m) => new m.AppKit())
  kitPromise.catch(() => {
    kitPromise = undefined // allow a retry after a network failure
  })
  return kitPromise
}

export function loadViemAdapter() {
  adapterPromise ??= import('@circle-fin/adapter-viem-v2')
  adapterPromise.catch(() => {
    adapterPromise = undefined
  })
  return adapterPromise
}

export function preloadBridgeKit(): void {
  void loadBridgeKit().catch(() => undefined)
  void loadViemAdapter().catch(() => undefined)
}
