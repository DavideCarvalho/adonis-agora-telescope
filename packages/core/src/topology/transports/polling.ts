import { runAsTelescopeWork } from '../../self_scope.js';

/**
 * A poll loop for drivers that pull: `step()` takes one message and says whether it found one.
 * While messages keep coming it runs back to back; on an empty read (or an error) it waits
 * `intervalMs`. The timer is unref'd: it never keeps the process alive.
 */
export class PollingConsumer {
  private running = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private current: Promise<void> | null = null;

  constructor(
    private readonly intervalMs: number,
    private readonly onError: (error: unknown) => void,
  ) {}

  start(step: () => Promise<boolean>): void {
    if (this.running) return;
    this.running = true;
    const loop = async (): Promise<void> => {
      let found = false;
      try {
        // Telescope's own traffic: the broker reads are not recorded as app work.
        found = await runAsTelescopeWork(step);
      } catch (error) {
        this.onError(error);
      }
      if (!this.running) return;
      this.timer = setTimeout(
        () => {
          this.current = loop();
        },
        found ? 0 : this.intervalMs,
      );
      this.timer.unref?.();
    };
    this.current = loop();
  }

  /** Stop and wait for the message in hand. */
  async stop(): Promise<void> {
    this.running = false;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    await this.current?.catch(() => {});
  }
}
