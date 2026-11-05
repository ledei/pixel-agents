import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';

import { expect, test } from '../../fixtures/obsidian';
import type { TestHooksWindow } from '../../helpers/editor';
import { preToolUseBash, sendHookEvent, sessionStartStartup } from '../../helpers/hooks';
import { expectOverlayCount, expectOverlayVisible } from '../../helpers/office';
import { setSettings } from '../../helpers/webview';

/**
 * The Obsidian adapter, loaded as Obsidian would: a fake host process stubs the
 * `obsidian` module around the built plugin (dist/obsidian), so the tests see
 * the office exactly as the view's iframe does. The host has no terminal, so
 * agents are driven through the hook endpoint (the sanctioned exception in
 * e2e/README.md "Mocking model & rules").
 */
test.describe('Obsidian / office', () => {
  test('opening the view serves a privileged office whose + Agent says why it is unavailable @area:obsidian', async ({
    page,
    obsidian,
  }) => {
    void obsidian;
    // The tokened URL makes the session privileged: the toolbar is there and
    // the read-only label is not.
    await expect
      .poll(
        () =>
          page.evaluate(
            () =>
              (window as TestHooksWindow).__pixelAgentsTestHooks?.getTiles?.()?.tiles.length ?? 0,
          ),
        { timeout: 30_000 },
      )
      .toBeGreaterThan(0);
    await expect(page.getByRole('button', { name: 'Layout', exact: true })).toBeVisible();
    await expect(page.getByText('View only', { exact: true })).toHaveCount(0);

    // No terminal: the launch button stays, disabled, with the adapter's reason.
    const addAgent = page.getByRole('button', { name: '+ Agent' });
    await expect(addAgent).toBeVisible();
    await expect(addAgent).toBeDisabled();
    await expect(addAgent).toHaveAttribute('title', /Obsidian has no terminal/);
    await expect(page.locator('.xterm')).toHaveCount(0);
  });

  test('an agent whose hook arrives is adopted and shown without any setting @area:obsidian', async ({
    page,
    obsidian,
  }) => {
    // Labels only make the overlay always visible. watchAllSessions is NOT
    // toggled: it defaults on for Obsidian, which is what adopts the agent.
    await setSettings(page, { alwaysShowLabels: true });
    const sessionId = 'obsidian-watch-session';
    await sendHookEvent(
      obsidian.hookServerConfig,
      sessionStartStartup(sessionId, obsidian.vaultDir),
    );
    await sendHookEvent(obsidian.hookServerConfig, preToolUseBash(sessionId, 'npm test'));

    await expectOverlayCount(page, 1);
    await expectOverlayVisible(page, 'Running: npm test');
  });

  test('closing the last view stops the office and removes its registry entry @area:obsidian', async ({
    obsidian,
  }) => {
    expect((await fetch(obsidian.healthUrl)).ok).toBe(true);
    expect(obsidian.registryEntries()).toHaveLength(1);

    await obsidian.closeView();

    await expect
      .poll(() =>
        fetch(obsidian.healthUrl).then(
          () => 'up',
          () => 'down',
        ),
      )
      .toBe('down');
    expect(obsidian.registryEntries()).toEqual([]);
  });

  test('a window reload that does not await unload stops the old office and starts one new one @area:obsidian', async ({
    page,
    obsidian,
  }) => {
    const oldHealth = obsidian.healthUrl;
    expect(obsidian.registryEntries()).toHaveLength(1);

    const nextUrl = await obsidian.reloadPlugin();

    const health = new URL('/api/health', nextUrl).toString();
    await expect
      .poll(() =>
        fetch(oldHealth).then(
          () => 'up',
          () => 'down',
        ),
      )
      .toBe('down');
    await expect
      .poll(() =>
        fetch(health).then(
          (r) => r.ok,
          () => false,
        ),
      )
      .toBe(true);
    await expect.poll(() => obsidian.registryEntries()).toHaveLength(1);
    await page.goto(nextUrl);
    await expect(page.getByRole('button', { name: 'Layout', exact: true })).toBeVisible();
  });

  test('an entry left by a renderer that died without unloading is not reused @area:obsidian', async ({
    obsidian,
  }) => {
    // A crashed renderer leaves its entry behind under the same PID (Obsidian
    // keeps the PID across reloads), pointing at a port nothing serves now.
    const serversDir = path.join(obsidian.tmpHome, '.pixel-agents', 'servers');
    const [live] = obsidian.registryEntries();
    const entry = JSON.parse(fs.readFileSync(path.join(serversDir, live), 'utf8'));
    const deadPort = await closedPort();
    const stale = `${entry.pid}-${deadPort}.json`;
    fs.writeFileSync(path.join(serversDir, stale), JSON.stringify({ ...entry, port: deadPort }));

    const nextUrl = await obsidian.reloadPlugin();

    expect(new URL(nextUrl).port).not.toBe(String(deadPort));
    const health = new URL('/api/health', nextUrl).toString();
    await expect
      .poll(() =>
        fetch(health).then(
          (r) => r.ok,
          () => false,
        ),
      )
      .toBe(true);
    expect(obsidian.registryEntries()).not.toContain(stale);
  });
});

/** A port that was free a moment ago and has nothing listening now. */
function closedPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as net.AddressInfo;
      server.close(() => resolve(port));
    });
  });
}
