/**
 * The narrow, structural slice of the AdonisJS event emitter the watchers in this
 * package depend on. Mirroring the `@adonisjs/events` `Emitter` surface
 * structurally — rather than importing it — keeps the watchers unit-testable with
 * a plain double and avoids a hard build-time coupling to a specific emitter
 * version.
 *
 * `on()` returns an unsubscribe function (this is exactly what the real Adonis
 * emitter, built on `emittery`, returns), which is how every watcher tears down
 * cleanly on {@link Watcher.stop}.
 */
export interface EmitterLike {
  /**
   * Subscribe `listener` to `event`. Returns a function that removes that exact
   * subscription when called.
   */
  on(event: string, listener: (data: unknown) => void): () => void;
}

/**
 * The common shape every per-technology watcher implements: start subscribing on
 * an emitter, and stop (fully unsubscribe) later. Neither method ever throws into
 * the host application.
 */
export interface Watcher {
  /** The telescope entry `type` this watcher records under. */
  readonly type: string;
  /** Begin recording by subscribing to the relevant emitter event(s). */
  start(emitter: EmitterLike): void;
  /** Stop recording by removing every subscription this watcher added. */
  stop(): void;
}
