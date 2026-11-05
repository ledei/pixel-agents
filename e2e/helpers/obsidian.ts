import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { expect, type Page } from '@playwright/test';

import { type HookServerConfig, waitForHookServer } from './hooks';

const REPO_ROOT = path.join(__dirname, '../..');
const PLUGIN_BUILD = path.join(REPO_ROOT, 'dist', 'obsidian');
const FAKE_HOST = path.join(REPO_ROOT, 'e2e/fixtures/obsidian-host.cjs');
const PLUGIN_REL = path.join('.obsidian', 'plugins', 'pixel-agents');

export interface ObsidianSession {
  tmpHome: string;
  /** The vault: the office's host Directory and scan root. */
  vaultDir: string;
  /** The URL the open Obsidian view loads into its iframe. */
  viewUrl: string;
  hookServerConfig: HookServerConfig;
  /** Absolute /api/health URL of the office the view started. */
  healthUrl: string;
  /** File names under `<HOME>/.pixel-agents/servers`: one per running server. */
  registryEntries: () => string[];
  /** Close the open (last) view; resolves once the host acknowledged it. */
  closeView: () => Promise<void>;
  /** Unload the plugin and wait for the host process to exit. */
  unloadPlugin: () => Promise<void>;
  getHostLogs: () => string;
  cleanup: () => Promise<void>;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForLine(
  readOutput: () => string,
  pattern: RegExp,
  what: string,
): Promise<string> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const match = pattern.exec(readOutput())?.[1];
    if (match) return match;
    await delay(100);
  }
  throw new Error(`The fake Obsidian host never reported ${what}:\n${readOutput()}`);
}

async function stopHost(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null) return;
  // The host unloads the plugin on SIGTERM; Windows has no signals, so there
  // the same request travels over stdin.
  child.stdin.write('unload\n');
  await Promise.race([
    new Promise<void>((resolve) => child.once('exit', () => resolve())),
    delay(5_000),
  ]);
  if (child.exitCode === null) {
    child.kill('SIGKILL');
    await Promise.race([
      new Promise<void>((resolve) => child.once('exit', () => resolve())),
      delay(1_000),
    ]);
  }
}

/**
 * Install the built plugin into a temp vault and run it in a fake Obsidian host
 * (e2e/fixtures/obsidian-host.cjs) under an isolated HOME, then open the URL
 * the host's office view hands its iframe. The real Obsidian app is out of
 * reach for CI (README "What's NOT covered"); everything past the `obsidian`
 * module boundary is the shipped plugin.
 */
export async function launchObsidian(page: Page): Promise<ObsidianSession> {
  if (!fs.existsSync(path.join(PLUGIN_BUILD, 'main.js'))) {
    throw new Error(
      `Obsidian plugin not built at ${PLUGIN_BUILD}. Run 'npm run build:obsidian' before obsidian e2e tests.`,
    );
  }
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'pixel-obsidian-e2e-home-'));
  const vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pixel-obsidian-e2e-vault-'));
  fs.cpSync(PLUGIN_BUILD, path.join(vaultDir, PLUGIN_REL), { recursive: true });
  // Consent baseline, as in the standalone fixture: without it the first-run
  // dialog covers the office.
  const configPath = path.join(tmpHome, '.pixel-agents', 'config.json');
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify({ hooksConsent: { claude: 'granted' } }, null, 2));

  let stdout = '';
  let stderr = '';
  const host = spawn(process.execPath, [FAKE_HOST, vaultDir], {
    // Obsidian's renderer has an unrelated cwd; the plugin must not depend on it.
    cwd: tmpHome,
    env: { ...process.env, HOME: tmpHome, USERPROFILE: tmpHome },
    stdio: 'pipe',
  });
  host.stdout.on('data', (chunk) => {
    stdout += chunk.toString();
  });
  host.stderr.on('data', (chunk) => {
    stderr += chunk.toString();
  });
  const getHostLogs = (): string =>
    [stdout.trim(), stderr.trim()].filter((value) => value.length > 0).join('\n');
  const removeDirs = (): void => {
    fs.rmSync(tmpHome, { recursive: true, force: true });
    fs.rmSync(vaultDir, { recursive: true, force: true });
  };

  try {
    await page.setViewportSize({ width: 1280, height: 800 });
    // The e2e flag makes the webview install its test-only observability hooks.
    await page.addInitScript(() => {
      (window as unknown as { __PIXEL_AGENTS_E2E?: boolean }).__PIXEL_AGENTS_E2E = true;
    });
    // The trailing \s keeps a half-delivered line from matching a truncated URL.
    const viewUrl = await waitForLine(() => stdout, /OBSIDIAN_VIEW_URL (\S+)\s/, 'the view URL');
    const hookServerConfig = await waitForHookServer(tmpHome);
    await page.goto(viewUrl);
    await expect(page.getByRole('button', { name: 'Settings' })).toBeVisible({ timeout: 30_000 });

    const serversDir = path.join(tmpHome, '.pixel-agents', 'servers');
    return {
      tmpHome,
      vaultDir,
      viewUrl,
      hookServerConfig,
      healthUrl: new URL('/api/health', viewUrl).toString(),
      registryEntries: () => (fs.existsSync(serversDir) ? fs.readdirSync(serversDir) : []),
      closeView: async () => {
        host.stdin.write('close-view\n');
        await waitForLine(() => stdout, /(OBSIDIAN_VIEW_CLOSED)/, 'the view closing');
      },
      unloadPlugin: () => stopHost(host),
      getHostLogs,
      cleanup: async () => {
        await stopHost(host);
        removeDirs();
      },
    };
  } catch (error) {
    await stopHost(host);
    removeDirs();
    const logs = getHostLogs();
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `launchObsidian failed: ${message}\n--- fake Obsidian host output ---\n${logs.length > 0 ? logs : '(none)'}`,
      { cause: error },
    );
  }
}
