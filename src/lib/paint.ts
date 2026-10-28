/**
 * Resolves once the browser has had a chance to paint, so background sync work
 * never delays the first frame of the cached list. A hidden tab does not paint,
 * so the wait is capped.
 */
export function afterPaint(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof requestAnimationFrame === "undefined") return resolve();
    const cap = setTimeout(resolve, 250);
    requestAnimationFrame(() =>
      setTimeout(() => {
        clearTimeout(cap);
        resolve();
      }, 0),
    );
  });
}
