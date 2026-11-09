import type { Register } from 'claude-code';

/**
 * Pixel Agents' usage bars, fed from any Claude Code session (the desktop app
 * runs headless and never draws the status line the bars' bridge hangs on).
 *
 * Whenever a rate-limit window moves a whole point, the percentages go to every
 * live Pixel Agents server on this machine, on the same local route the status
 * line bridge uses (POST /api/usage/claude). Only the two windows' used
 * percentage and reset time are sent. It reports only while the user has turned
 * Usage Bars on (the bridge is in ~/.claude/settings.json).
 */

const BRIDGE_MARKER = 'claude-statusline.js';
const WINDOWS = ['five_hour', 'seven_day'];

export const register: Register = (on) => {
  let lastSent = '';

  on('session.measure', async ($, e, next) => {
    const limits: Record<string, { used_percentage: number; resets_at: number }> = {};
    for (const w of e.rateLimits) {
      const resetsAt = Math.floor(Date.parse(w.resetsAt) / 1000);
      if (WINDOWS.includes(w.kind) && Number.isFinite(resetsAt)) {
        limits[w.kind] = { used_percentage: w.percentUsed, resets_at: resetsAt };
      }
    }
    const body = JSON.stringify({ rate_limits: limits });
    if (Object.keys(limits).length === 0 || body === lastSent) return next(e);

    try {
      const home = await $.env.get('HOME');
      if (!home) return next(e);

      // Only while the user has Usage Bars on: the bridge is in their settings.
      const settings = JSON.parse(await $.fs.read(`${home}/.claude/settings.json`));
      const command = settings?.statusLine?.command;
      if (typeof command !== 'string' || !command.includes(BRIDGE_MARKER)) return next(e);

      // Every live server: the registry, else the legacy single server.json.
      const dir = `${home}/.pixel-agents`;
      const files = [`${dir}/server.json`];
      try {
        for (const entry of await $.fs.list(`${dir}/servers`)) {
          if (entry.name.endsWith('.json')) files.push(`${dir}/servers/${entry.name}`);
        }
      } catch {
        // no registry: server.json is all there is
      }
      const servers = new Map<number, string>();
      for (const file of files) {
        try {
          const server = JSON.parse(await $.fs.read(file));
          if (typeof server.port === 'number' && typeof server.token === 'string') {
            servers.set(server.port, server.token);
          }
        } catch {
          // unreadable entry: skip it
        }
      }

      lastSent = body;
      for (const [port, token] of servers) {
        try {
          await $.http.fetch(`http://127.0.0.1:${port}/api/usage/claude`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
            body,
          });
        } catch {
          // a stopped server must never disturb the session
        }
      }
    } catch {
      // settings unreadable: nothing to report to
    }
    return next(e);
  });
};
