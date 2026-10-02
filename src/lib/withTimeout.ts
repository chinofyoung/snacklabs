/**
 * Rejects with `message` if `promise` has not settled within `ms`.
 *
 * Exists for promises that can hang forever rather than reject, such as
 * `navigator.serviceWorker.ready` when registration failed. The timer is cleared
 * as soon as the promise settles, so a fast success leaves nothing pending.
 * Timing out does not cancel the underlying promise; it only stops waiting on it.
 */
export function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (reason: unknown) => {
        clearTimeout(timer)
        reject(reason)
      },
    )
  })
}
