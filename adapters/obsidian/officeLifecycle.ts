/**
 * When the Obsidian adapter's office runs: from the first open view to the
 * last close, or the plugin's unload. No `obsidian` import, so it is
 * unit-testable with a fake starter.
 */

/** The part of a started office the lifecycle needs (startOffice's result). */
export interface RunningOffice {
  url: string;
  stop(): Promise<void>;
}

export class OfficeLifecycle {
  /** The current office, started or starting; null when none runs. */
  private office: Promise<RunningOffice> | null = null;
  /** The previous office's stop, settled whether or not it failed. A start
   *  waits for it: a server that is still stopping would otherwise be reused,
   *  and the new office served by nothing. */
  private stopped: Promise<void> = Promise.resolve();
  private views = 0;

  constructor(private readonly start: () => Promise<RunningOffice>) {}

  /** A view opened: resolve with the office URL, starting the office for the
   *  first view. Views opened while it starts share that start, and its failure. */
  async acquire(): Promise<string> {
    this.views++;
    if (!this.office) {
      const office = this.stopped.then(() => this.start());
      this.office = office;
      // A failed start leaves no office behind: the next open starts afresh.
      office.catch(() => {
        if (this.office === office) this.office = null;
      });
    }
    return (await this.office).url;
  }

  /** A view closed: the last one stops the office (once it has started). */
  release(): Promise<void> {
    this.views = Math.max(0, this.views - 1);
    return this.views > 0 ? Promise.resolve() : this.stop();
  }

  /** The plugin unloads: stop the office whatever views are still open. */
  dispose(): Promise<void> {
    this.views = 0;
    return this.stop();
  }

  private stop(): Promise<void> {
    const office = this.office;
    // No office: wait out a stop already in flight (an unload right after the
    // last close must not return while that server still runs).
    if (!office) return this.stopped;
    this.office = null;
    const stopping = office.then(
      (started) => started.stop(),
      () => undefined,
    );
    // The caller hears a failed stop; the next start only waits for it.
    this.stopped = stopping.catch(() => undefined);
    return stopping;
  }
}
