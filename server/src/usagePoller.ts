/**
 * Keeps the usage bars fed for sessions that never run a status line (a
 * headless host such as the Claude desktop app): every
 * USAGE_POLL_INTERVAL_MS, each provider whose usage bridge is installed and
 * can `poll` is asked for the account's limits. A report newer than the
 * interval (a terminal session's status line is feeding it) skips the poll.
 */

import type { HookProvider } from '../../core/src/provider.js';
import { USAGE_POLL_FIRST_DELAY_MS, USAGE_POLL_INTERVAL_MS } from './constants.js';
import { usageAgeMs } from './usageLimits.js';

export interface UsagePoller {
  stop(): void;
}

/** `onReport` gets the raw report for a provider (recordUsageReport + broadcast). */
export function startUsagePoller(
  providers: readonly HookProvider[],
  onReport: (provider: HookProvider, raw: unknown) => void,
  intervalMs: number = USAGE_POLL_INTERVAL_MS,
  firstDelayMs: number = USAGE_POLL_FIRST_DELAY_MS,
): UsagePoller {
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;

  const tick = async (): Promise<void> => {
    for (const provider of providers) {
      const bridge = provider.usageBridge;
      if (!bridge?.poll || !bridge.isInstalled()) continue;
      if (usageAgeMs(provider.id) < intervalMs) continue;
      const raw = await bridge.poll();
      if (raw && !stopped) onReport(provider, raw);
    }
    if (!stopped) timer = setTimeout(() => void tick(), intervalMs);
  };
  timer = setTimeout(() => void tick(), firstDelayMs);

  return {
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}
