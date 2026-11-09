/**
 * The usage mod: a small Claude Code plugin (claude-plugin/, shipped as
 * dist/claude-plugin) that reports the plan rate limits of every Claude Code
 * session to the office, the desktop app's headless sessions included — they
 * never draw the status line the bridge hangs on.
 *
 * It installs and uninstalls with Usage Bars (the same click, the same
 * consent): the bundled marketplace is copied to ~/.pixel-agents/claude-plugin
 * and registered with `claude plugin marketplace add`, then the plugin is
 * installed from it. Claude Code reads a local marketplace in place, so
 * refreshing the copy updates the installed plugin.
 */

import { execFile } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { PIXEL_AGENTS_DIR } from '../../../constants.js';
import {
  CLAUDE_BINARY_ENV,
  CLAUDE_CLI_TIMEOUT_MS,
  CLAUDE_PLUGIN_DIR_NAME,
  USAGE_MOD_MARKETPLACE,
  USAGE_MOD_PLUGIN,
} from './constants.js';

/** Runs `claude <args>`; resolves ok=false (never rejects) with the output. */
export type RunClaude = (args: readonly string[]) => Promise<{ ok: boolean; output: string }>;

const PLUGIN_ID = `${USAGE_MOD_PLUGIN}@${USAGE_MOD_MARKETPLACE}`;

/** Where the CLI usually lives; an app launched from the Dock (Obsidian) has no
 *  shell PATH, so `claude` alone is not enough. */
function claudeBinary(): string {
  const home = os.homedir();
  const candidates = [
    process.env[CLAUDE_BINARY_ENV],
    path.join(home, '.local', 'bin', 'claude'),
    path.join(home, '.claude', 'local', 'claude'),
    '/opt/homebrew/bin/claude',
    '/usr/local/bin/claude',
  ];
  return candidates.find((p) => p && fs.existsSync(p)) ?? 'claude';
}

export const runClaude: RunClaude = (args) =>
  new Promise((resolve) => {
    execFile(
      claudeBinary(),
      [...args],
      { timeout: CLAUDE_CLI_TIMEOUT_MS, shell: process.platform === 'win32' },
      (error, stdout, stderr) => {
        resolve({ ok: !error, output: `${stdout}${stderr}`.trim() || String(error ?? '') });
      },
    );
  });

/** Where the marketplace lives once installed: ~/.pixel-agents/claude-plugin. */
export function usageModMarketplacePath(): string {
  return path.join(os.homedir(), PIXEL_AGENTS_DIR, CLAUDE_PLUGIN_DIR_NAME);
}

/** Copy the bundled marketplace (`dist/claude-plugin`) to ~/.pixel-agents.
 *  False when the package has none or the copy failed. */
export function copyUsageModMarketplace(packageRoot: string): boolean {
  const src = path.join(packageRoot, 'dist', CLAUDE_PLUGIN_DIR_NAME);
  const dst = usageModMarketplacePath();
  try {
    if (!fs.existsSync(src)) {
      console.warn(`[Pixel Agents] Usage plugin not found at ${src}`);
      return false;
    }
    fs.rmSync(dst, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(dst), { recursive: true, mode: 0o700 });
    fs.cpSync(src, dst, { recursive: true });
    return true;
  } catch (e) {
    console.error(`[Pixel Agents] Failed to copy the usage plugin: ${e}`);
    return false;
  }
}

/** Install the mod. Throws with Claude Code's own message when a step fails. */
export async function installUsageMod(
  packageRoot: string,
  run: RunClaude = runClaude,
): Promise<void> {
  if (!copyUsageModMarketplace(packageRoot)) {
    throw new Error('Could not copy the usage plugin.');
  }
  const steps = [
    ['plugin', 'marketplace', 'add', usageModMarketplacePath(), '--scope', 'user'],
    ['plugin', 'install', PLUGIN_ID, '--scope', 'user'],
  ];
  for (const args of steps) {
    const { ok, output } = await run(args);
    if (!ok) throw new Error(`claude ${args.slice(0, 3).join(' ')} failed: ${output}`);
  }
}

/** Remove the mod and its marketplace. Best effort: a step that fails (already
 *  gone, no CLI) must not keep Usage Bars from turning off. */
export async function uninstallUsageMod(run: RunClaude = runClaude): Promise<void> {
  await run(['plugin', 'uninstall', PLUGIN_ID, '--scope', 'user']);
  await run(['plugin', 'marketplace', 'remove', USAGE_MOD_MARKETPLACE]);
  fs.rmSync(usageModMarketplacePath(), { recursive: true, force: true });
}
