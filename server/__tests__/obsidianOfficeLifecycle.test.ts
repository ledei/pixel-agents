import { describe, expect, it } from 'vitest';

import { OfficeLifecycle } from '../../adapters/obsidian/officeLifecycle.js';

/** A starter whose offices start only when the test says so. */
function fakeStarter() {
  const starts: Array<{
    resolve: () => void;
    reject: (err: Error) => void;
    started: boolean;
    stops: number;
  }> = [];
  const start = () =>
    new Promise<{ url: string; stop(): Promise<void> }>((resolve, reject) => {
      const n = starts.length + 1;
      const entry = {
        started: false,
        stops: 0,
        resolve: () => {
          entry.started = true;
          resolve({
            url: `http://127.0.0.1:${4000 + n}/?token=t${n}`,
            stop: async () => void entry.stops++,
          });
        },
        reject,
      };
      starts.push(entry);
    });
  return {
    start,
    starts,
    /** Offices started and not yet stopped. */
    running: () => starts.filter((s) => s.started && s.stops === 0).length,
  };
}

/** A starter whose offices start at once but stop only when the test says so. */
function slowStopStarter() {
  const starter = {
    starts: 0,
    finishStop: () => {},
    start: async () => {
      starter.starts++;
      return {
        url: 'http://127.0.0.1:4001/?token=t',
        stop: () => new Promise<void>((resolve) => (starter.finishStop = resolve)),
      };
    },
  };
  return starter;
}

/** Let pending promise callbacks run. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('OfficeLifecycle', () => {
  it('starts the office once for every view that opens', async () => {
    const starter = fakeStarter();
    const lifecycle = new OfficeLifecycle(starter.start);

    const first = lifecycle.acquire();
    await settle();
    starter.starts[0].resolve();
    const second = lifecycle.acquire();

    expect(await first).toBe('http://127.0.0.1:4001/?token=t1');
    expect(await second).toBe('http://127.0.0.1:4001/?token=t1');
    expect(starter.starts).toHaveLength(1);
    expect(starter.running()).toBe(1);
  });

  it('keeps the office running until the last view closes', async () => {
    const starter = fakeStarter();
    const lifecycle = new OfficeLifecycle(starter.start);
    const opened = [lifecycle.acquire(), lifecycle.acquire()];
    await settle();
    starter.starts[0].resolve();
    await Promise.all(opened);

    await lifecycle.release();
    expect(starter.running()).toBe(1);

    await lifecycle.release();
    expect(starter.running()).toBe(0);
    expect(starter.starts[0].stops).toBe(1);
  });

  it('reports a failed start to every waiting view, and the next open retries', async () => {
    const starter = fakeStarter();
    const lifecycle = new OfficeLifecycle(starter.start);
    const opened = [lifecycle.acquire(), lifecycle.acquire()];
    await settle();
    starter.starts[0].reject(new Error('port in use'));

    for (const view of opened) await expect(view).rejects.toThrow('port in use');
    expect(starter.running()).toBe(0);

    const retried = lifecycle.acquire();
    await settle();
    starter.starts[1].resolve();
    expect(await retried).toBe('http://127.0.0.1:4002/?token=t2');
  });

  it('closing every failed view stops nothing and leaves the next open free to start', async () => {
    const starter = fakeStarter();
    const lifecycle = new OfficeLifecycle(starter.start);
    const failed = lifecycle.acquire();
    await settle();
    starter.starts[0].reject(new Error('no assets'));
    await expect(failed).rejects.toThrow('no assets');

    await lifecycle.release();

    const reopened = lifecycle.acquire();
    await settle();
    starter.starts[1].resolve();
    expect(await reopened).toBe('http://127.0.0.1:4002/?token=t2');
    await lifecycle.release();
    expect(starter.running()).toBe(0);
  });

  it('stops an office the last view stopped waiting for, once it has started', async () => {
    const starter = fakeStarter();
    const lifecycle = new OfficeLifecycle(starter.start);
    void lifecycle.acquire();
    await settle();

    const closed = lifecycle.release();
    starter.starts[0].resolve();
    await closed;

    expect(starter.running()).toBe(0);
    expect(starter.starts[0].stops).toBe(1);
  });

  // A server that is still stopping can be reused by the next start, which
  // would then be left serving from a stopped office.
  it('starts the next office only after the previous one finished stopping', async () => {
    const starter = slowStopStarter();
    const lifecycle = new OfficeLifecycle(starter.start);
    await lifecycle.acquire();
    const closed = lifecycle.release();
    await settle();

    const reopened = lifecycle.acquire();
    await settle();
    expect(starter.starts).toBe(1);

    starter.finishStop();
    await Promise.all([closed, reopened]);
    expect(starter.starts).toBe(2);
  });

  // Obsidian keeps the renderer PID across a window reload, so an unload that
  // returns while the server still runs leaves a live-looking registry entry.
  it('dispose right after the last close waits for that stop to finish', async () => {
    const starter = slowStopStarter();
    const lifecycle = new OfficeLifecycle(starter.start);
    await lifecycle.acquire();
    void lifecycle.release();
    await settle();

    let unloaded = false;
    const unloading = lifecycle.dispose().then(() => (unloaded = true));
    await settle();
    expect(unloaded).toBe(false);

    starter.finishStop();
    await unloading;
    expect(unloaded).toBe(true);
  });

  it('dispose stops the office although views are still open', async () => {
    const starter = fakeStarter();
    const lifecycle = new OfficeLifecycle(starter.start);
    const opened = [lifecycle.acquire(), lifecycle.acquire()];
    await settle();
    starter.starts[0].resolve();
    await Promise.all(opened);

    await lifecycle.dispose();
    expect(starter.running()).toBe(0);

    // The views' own close after an unload stops nothing twice.
    await lifecycle.release();
    await lifecycle.release();
    expect(starter.starts[0].stops).toBe(1);
  });
});
