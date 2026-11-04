/** Wait before reconnect attempt `n` (0-based): 0.5 s doubling, at most 10 s (the web's rule). */
export const reconnectDelay = (attempt: number): number =>
  Math.min(500 * 2 ** Math.max(0, attempt), 10_000);
