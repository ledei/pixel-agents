/**
 * Plan usage for sessions that never draw a status line (the Claude desktop
 * app runs Claude Code headless, so the status line bridge never fires there).
 *
 * Claude Code's stream-json output opens every request with a
 * `rate_limit_event` carrying both windows:
 *
 *   { "type": "rate_limit_event", "rate_limit_info": { "unifiedWindows": {
 *       "five_hour": { "utilization": 0.42, "resetsAt": 1738425600 },
 *       "seven_day": { "utilization": 0.18, "resetsAt": 1738857600 } } } }
 *
 * `utilization` is a 0..1 share. So a tiny headless `claude -p` is enough to
 * read the account's limits: hooks are disabled (it must not appear in the
 * office or run the user's hooks), nothing is persisted (no transcript for the
 * scanners to adopt), and the process is stopped as soon as the event arrives.
 *
 * The result is shaped like the status line's report, so it takes the same
 * path (normalizeClaudeUsageReport → recordUsageReport).
 */

import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { PIXEL_AGENTS_DIR } from '../../../constants.js';
import { isRecord } from '../../../serverConfig.js';
import {
  CLAUDE_USAGE_POLL_ARGS,
  CLAUDE_USAGE_POLL_BINARY_ENV,
  CLAUDE_USAGE_POLL_DIR_NAME,
  CLAUDE_USAGE_POLL_TIMEOUT_MS,
} from './constants.js';

/** Where the CLI usually lives; an app launched from the Dock (Obsidian) has no
 *  shell PATH, so `claude` alone is not enough. */
function binaryCandidates(): string[] {
  const home = os.homedir();
  const fromEnv = process.env[CLAUDE_USAGE_POLL_BINARY_ENV];
  return [
    ...(fromEnv ? [fromEnv] : []),
    path.join(home, '.local', 'bin', 'claude'),
    path.join(home, '.claude', 'local', 'claude'),
    '/opt/homebrew/bin/claude',
    '/usr/local/bin/claude',
  ];
}

function claudeBinary(): string {
  return binaryCandidates().find((p) => fs.existsSync(p)) ?? 'claude';
}

/** A folder only this user can write, so nothing planted there (settings, an
 *  .mcp.json) can reach the run. Null when it cannot be made. */
function privateWorkingDir(): string | null {
  const dir = path.join(os.homedir(), PIXEL_AGENTS_DIR, CLAUDE_USAGE_POLL_DIR_NAME);
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.chmodSync(dir, 0o700);
    return dir;
  } catch {
    return null;
  }
}

function windowOf(raw: unknown): { used_percentage: number; resets_at: number } | undefined {
  if (!isRecord(raw)) return undefined;
  const { utilization, resetsAt } = raw;
  if (typeof utilization !== 'number' || !Number.isFinite(utilization)) return undefined;
  if (typeof resetsAt !== 'number' || !Number.isFinite(resetsAt)) return undefined;
  return { used_percentage: utilization * 100, resets_at: resetsAt };
}

/** One stream-json line as a status-line-shaped report; null when it is not a
 *  rate-limit event with a window in it. */
export function usageReportFromStreamLine(line: string): Record<string, unknown> | null {
  let event: unknown;
  try {
    event = JSON.parse(line);
  } catch {
    return null;
  }
  if (!isRecord(event) || event.type !== 'rate_limit_event') return null;
  const info = event.rate_limit_info;
  const windows = isRecord(info) ? info.unifiedWindows : undefined;
  if (!isRecord(windows)) return null;
  const five_hour = windowOf(windows.five_hour);
  const seven_day = windowOf(windows.seven_day);
  if (!five_hour && !seven_day) return null;
  return {
    rate_limits: { ...(five_hour ? { five_hour } : {}), ...(seven_day ? { seven_day } : {}) },
  };
}

/** Ask Claude Code for the account's limits. Resolves null on any failure
 *  (no CLI, not logged in, no event in time): the bars just keep their last
 *  report. Never rejects. */
export function pollClaudeUsage(): Promise<Record<string, unknown> | null> {
  const cwd = privateWorkingDir();
  if (!cwd) return Promise.resolve(null);
  return new Promise((resolve) => {
    let settled = false;
    let buffer = '';
    const done = (value: Record<string, unknown> | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill('SIGTERM');
      resolve(value);
    };
    const child = spawn(claudeBinary(), [...CLAUDE_USAGE_POLL_ARGS], {
      cwd,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const timer = setTimeout(() => done(null), CLAUDE_USAGE_POLL_TIMEOUT_MS);
    child.on('error', () => done(null));
    child.on('close', () => done(null));
    child.stdout.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf-8');
      let at: number;
      while ((at = buffer.indexOf('\n')) >= 0) {
        const report = usageReportFromStreamLine(buffer.slice(0, at));
        buffer = buffer.slice(at + 1);
        if (report) return done(report);
      }
    });
  });
}
