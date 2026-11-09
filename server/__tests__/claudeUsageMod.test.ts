import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let tmpBase: string;

vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os');
  return { ...actual, homedir: () => tmpBase };
});

const { installUsageMod, uninstallUsageMod, usageModMarketplacePath } =
  await import('../src/providers/hook/claude/claudeUsageMod.js');

/** A package root holding dist/claude-plugin with one marker file. */
function makePackage(): string {
  const root = fs.mkdtempSync(path.join(tmpBase, 'pkg-'));
  const plugin = path.join(root, 'dist', 'claude-plugin', '.claude-plugin');
  fs.mkdirSync(plugin, { recursive: true });
  fs.writeFileSync(path.join(plugin, 'marketplace.json'), '{}');
  return root;
}

const recorder = (failOn?: string) => {
  const calls: string[][] = [];
  const run = async (args: readonly string[]) => {
    calls.push([...args]);
    const failed = failOn !== undefined && args.includes(failOn);
    return { ok: !failed, output: failed ? 'boom' : '' };
  };
  return { calls, run };
};

describe('usage mod', () => {
  beforeEach(() => {
    tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-usagemod-'));
  });
  afterEach(() => fs.rmSync(tmpBase, { recursive: true, force: true }));

  it('copies the marketplace, registers it, then installs the plugin at user scope', async () => {
    const { calls, run } = recorder();
    await installUsageMod(makePackage(), run);
    const dir = usageModMarketplacePath();
    expect(fs.existsSync(path.join(dir, '.claude-plugin', 'marketplace.json'))).toBe(true);
    expect(calls).toEqual([
      ['plugin', 'marketplace', 'add', dir, '--scope', 'user'],
      ['plugin', 'install', 'pixel-agents-usage@pixel-agents', '--scope', 'user'],
    ]);
  });

  it("throws Claude Code's own message when a step fails, and stops there", async () => {
    const { calls, run } = recorder('add');
    await expect(installUsageMod(makePackage(), run)).rejects.toThrow(
      /marketplace add failed: boom/,
    );
    expect(calls).toHaveLength(1);
  });

  it('throws when the package ships no plugin', async () => {
    const empty = fs.mkdtempSync(path.join(tmpBase, 'empty-'));
    await expect(installUsageMod(empty, recorder().run)).rejects.toThrow(/copy the usage plugin/);
  });

  it('uninstalls the plugin and the marketplace, and tolerates failures', async () => {
    const { run } = recorder();
    await installUsageMod(makePackage(), run);
    const failing = recorder('uninstall');
    await expect(uninstallUsageMod(failing.run)).resolves.toBeUndefined();
    expect(failing.calls.map((c) => c[1])).toEqual(['uninstall', 'marketplace']);
    expect(fs.existsSync(usageModMarketplacePath())).toBe(false);
  });
});
