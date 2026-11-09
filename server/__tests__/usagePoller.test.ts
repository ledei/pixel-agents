import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { HookProvider } from '../../core/src/provider.js';
import { normalizeClaudeUsageReport } from '../src/providers/hook/claude/claudeUsageBridge.js';
import { usageReportFromStreamLine } from '../src/providers/hook/claude/claudeUsagePoll.js';

vi.mock('../src/usageLimits.js', () => ({ usageAgeMs: vi.fn(() => Number.POSITIVE_INFINITY) }));
const { usageAgeMs } = await import('../src/usageLimits.js');
const { startUsagePoller } = await import('../src/usagePoller.js');

const event = (windows: unknown) =>
  JSON.stringify({ type: 'rate_limit_event', rate_limit_info: { unifiedWindows: windows } });

describe('usageReportFromStreamLine', () => {
  it('turns utilization shares into the status line report', () => {
    const line = event({
      five_hour: { utilization: 0.42, resetsAt: 1_900_000_000, status: 'allowed' },
      seven_day: { utilization: 1, resetsAt: 1_900_500_000, status: 'rejected' },
    });
    const report = usageReportFromStreamLine(line);
    expect(normalizeClaudeUsageReport(report)).toEqual({
      fiveHour: { usedPercentage: 42, resetsAt: 1_900_000_000 },
      sevenDay: { usedPercentage: 100, resetsAt: 1_900_500_000 },
    });
  });

  it('keeps a window that is the only one reported', () => {
    const report = usageReportFromStreamLine(
      event({ seven_day: { utilization: 0.5, resetsAt: 1_900_500_000 } }),
    );
    expect(normalizeClaudeUsageReport(report)?.fiveHour).toBeUndefined();
    expect(normalizeClaudeUsageReport(report)?.sevenDay?.usedPercentage).toBe(50);
  });

  it.each([
    'not json',
    JSON.stringify({ type: 'assistant' }),
    JSON.stringify({ type: 'rate_limit_event', rate_limit_info: {} }),
    event({ five_hour: { utilization: 'x', resetsAt: 1 } }),
  ])('ignores %s', (line) => {
    expect(usageReportFromStreamLine(line)).toBeNull();
  });
});

describe('startUsagePoller', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    vi.mocked(usageAgeMs).mockReturnValue(Number.POSITIVE_INFINITY);
  });

  const provider = (installed: boolean, poll?: () => Promise<unknown>): HookProvider =>
    ({
      id: 'claude',
      usageBridge: { isInstalled: () => installed, poll },
    }) as unknown as HookProvider;

  it('polls an installed bridge, reports, and repeats', async () => {
    const poll = vi.fn(async () => ({ rate_limits: {} }));
    const onReport = vi.fn();
    const poller = startUsagePoller([provider(true, poll)], onReport, 1000, 10);
    await vi.advanceTimersByTimeAsync(10);
    expect(onReport).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(poll).toHaveBeenCalledTimes(2);
    poller.stop();
    await vi.advanceTimersByTimeAsync(5000);
    expect(poll).toHaveBeenCalledTimes(2);
  });

  it('does not poll when the bridge is off, cannot poll, or a fresh report exists', async () => {
    const poll = vi.fn(async () => ({}));
    const onReport = vi.fn();
    vi.mocked(usageAgeMs).mockReturnValue(10);
    startUsagePoller(
      [provider(false, poll), provider(true, undefined), provider(true, poll)],
      onReport,
      1000,
      10,
    );
    await vi.advanceTimersByTimeAsync(10);
    expect(poll).not.toHaveBeenCalled();
    expect(onReport).not.toHaveBeenCalled();
  });

  it('drops a null report', async () => {
    const onReport = vi.fn();
    startUsagePoller([provider(true, async () => null)], onReport, 1000, 10);
    await vi.advanceTimersByTimeAsync(10);
    expect(onReport).not.toHaveBeenCalled();
  });
});
