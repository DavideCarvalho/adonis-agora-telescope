/** The signals a process is asked to stop with. */
const SHUTDOWN_SIGNALS = ['SIGTERM', 'SIGINT'] as const;

/**
 * Call `onSignal` when the process is asked to stop (`SIGTERM`, `SIGINT`), without changing what
 * the signal does: a process that handles it keeps doing so, and one that does not still exits
 * (the signal is raised again once this observer is out of the way). Returns the unsubscribe.
 */
export function observeShutdownSignals(onSignal: () => void): () => void {
  const stops: Array<() => void> = [];
  const stop = () => {
    for (const off of stops.splice(0)) off();
  };
  for (const signal of SHUTDOWN_SIGNALS) {
    // Per signal, closed over: never relies on the listener's argument.
    const listener = () => {
      try {
        onSignal();
      } catch {
        // An observer must never change how the process stops.
      }
      // Prepended, so every other listener is still registered here: alone means nobody else
      // handles it, and Node's default (exit) must apply.
      if (process.listenerCount(signal) === 1) {
        stop();
        process.kill(process.pid, signal);
      }
    };
    process.prependListener(signal, listener);
    stops.push(() => process.off(signal, listener));
  }
  return stop;
}
