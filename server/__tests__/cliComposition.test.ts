import { type ChildProcess, spawn } from 'child_process';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';

import { CLAUDE_HOOK_EVENTS } from '../src/providers/hook/claude/constants.js';

/**
 * Characterization of what the standalone CLI composes TODAY, observed only at
 * the process boundary: spawn the built dist/cli.js with an isolated HOME and
 * cwd, then look at what it prints, writes, serves and cleans up. It pins the
 * behaviour a refactor of the composition (e.g. extracting startOffice) must
 * preserve. Needs `npm run compile` first, like cli.test.ts.
 */
const CLI_BUNDLE = path.join(__dirname, '../../dist/cli.js');
const URL_LINE = /Pixel Agents server running at (\S+)\s/;
const TIMEOUT_MS = 15_000;

interface Host {
  home: string;
  cwd: string;
  port: number;
  child: ChildProcess;
  output: () => string;
  url: URL;
  exited: Promise<number | null>;
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function getFreePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => {
        if (address && typeof address !== 'string') resolve(address.port);
        else reject(new Error('Failed to allocate a test port'));
      });
    });
  });
}

async function waitFor(check: () => boolean | Promise<boolean>, what: string): Promise<void> {
  const deadline = Date.now() + TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for ${what}`);
}

/** Spawn the built CLI, wait for its URL line and /api/health. `home` is
 *  seeded by the caller via `seed` before the process starts. */
async function startHost(
  opts: { args?: string[]; seed?: (home: string) => void } = {},
): Promise<Host> {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-comp-home-'));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-comp-cwd-'));
  opts.seed?.(home);
  const port = await getFreePort();
  const child = spawn(
    process.execPath,
    [CLI_BUNDLE, '--port', String(port), ...(opts.args ?? [])],
    {
      cwd,
      env: { ...process.env, HOME: home, USERPROFILE: home },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let out = '';
  child.stdout?.on('data', (c: Buffer) => (out += c.toString()));
  child.stderr?.on('data', (c: Buffer) => (out += c.toString()));
  const exited = new Promise<number | null>((resolve) => child.once('close', resolve));

  cleanups.push(async () => {
    if (child.exitCode === null) {
      child.kill('SIGTERM');
      await Promise.race([exited, new Promise((r) => setTimeout(r, 2_000))]);
      if (child.exitCode === null) child.kill('SIGKILL');
    }
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  await waitFor(() => {
    if (child.exitCode !== null) throw new Error(`CLI exited before startup:\n${out}`);
    return URL_LINE.test(out);
  }, 'the printed server URL');
  await waitFor(async () => {
    try {
      return (await fetch(`http://127.0.0.1:${port}/api/health`)).ok;
    } catch {
      return false;
    }
  }, '/api/health');

  return {
    home,
    cwd,
    port,
    child,
    output: () => out,
    url: new URL(URL_LINE.exec(out)![1]),
    exited,
  };
}

function seedConfig(home: string, config: object): void {
  fs.mkdirSync(path.join(home, '.pixel-agents'), { recursive: true });
  fs.writeFileSync(path.join(home, '.pixel-agents', 'config.json'), JSON.stringify(config));
}

const registryEntries = (home: string): string[] => {
  const dir = path.join(home, '.pixel-agents', 'servers');
  return fs.existsSync(dir) ? fs.readdirSync(dir) : [];
};

/** Connect to /ws with the given query, send webviewReady, resolve with the
 *  first message of `type` the server answers with. */
async function messageAfterWebviewReady(
  host: Host,
  query: string,
  type: string,
): Promise<Record<string, unknown>> {
  const ws = new WebSocket(`ws://127.0.0.1:${host.port}/ws${query}`);
  try {
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`No ${type} within timeout`)), TIMEOUT_MS);
      ws.on('error', reject);
      ws.on('open', () => ws.send(JSON.stringify({ type: 'webviewReady' })));
      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString()) as Record<string, unknown>;
        if (msg.type === type) {
          clearTimeout(timer);
          resolve(msg);
        }
      });
    });
  } finally {
    ws.close();
  }
}

describe.skipIf(!fs.existsSync(CLI_BUNDLE))('standalone CLI composition (dist/cli.js)', () => {
  it('prints a tokened URL, serves /api/health, and records itself in the registry and server.json', async () => {
    const host = await startHost({ args: ['--no-terminal'] });

    const serverJson = JSON.parse(
      fs.readFileSync(path.join(host.home, '.pixel-agents', 'server.json'), 'utf-8'),
    ) as { port: number; pid: number; token: string };

    expect(host.url.hostname).toBe('127.0.0.1');
    expect(host.url.port).toBe(String(host.port));
    expect(host.url.searchParams.get('token')).toBe(serverJson.token);
    expect(serverJson).toMatchObject({ port: host.port, pid: host.child.pid });

    const entries = registryEntries(host.home);
    expect(entries).toEqual([`${host.child.pid}-${host.port}.json`]);
    const entry = JSON.parse(
      fs.readFileSync(path.join(host.home, '.pixel-agents', 'servers', entries[0]), 'utf-8'),
    ) as { port: number; pid: number };
    expect(entry).toMatchObject({ port: host.port, pid: host.child.pid });

    const health = await fetch(`http://127.0.0.1:${host.port}/api/health`);
    expect(health.ok).toBe(true);
  });

  it('exits 0 on SIGTERM and removes its registry entry', async () => {
    const host = await startHost({ args: ['--no-terminal'] });
    expect(registryEntries(host.home)).toHaveLength(1);

    host.child.kill('SIGTERM');

    // Windows has no SIGTERM: kill() terminates the process, so exit-code and
    // cleanup semantics only apply to POSIX.
    if (process.platform !== 'win32') {
      expect(await host.exited).toBe(0);
      expect(registryEntries(host.home)).toEqual([]);
    }
  });

  it('writes no hooks to ~/.claude/settings.json without consent', async () => {
    const host = await startHost({ args: ['--no-terminal'] });
    await new Promise((resolve) => setTimeout(resolve, 300));

    expect(fs.existsSync(path.join(host.home, '.claude', 'settings.json'))).toBe(false);
    expect(fs.existsSync(path.join(host.home, '.pixel-agents', 'hooks', 'claude-hook.js'))).toBe(
      false,
    );
  });

  it('installs hooks and copies the hook script when consent is granted', async () => {
    const host = await startHost({
      args: ['--no-terminal'],
      seed: (home) => seedConfig(home, { hooksConsent: { claude: 'granted' } }),
    });
    await waitFor(() => host.output().includes('[Pixel Agents] Hooks installed'), 'hook install');

    const script = path.join(host.home, '.pixel-agents', 'hooks', 'claude-hook.js');
    expect(fs.existsSync(script)).toBe(true);

    const settings = JSON.parse(
      fs.readFileSync(path.join(host.home, '.claude', 'settings.json'), 'utf-8'),
    ) as { hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>> };
    expect(Object.keys(settings.hooks).sort()).toEqual([...CLAUDE_HOOK_EVENTS].sort());
    for (const entries of Object.values(settings.hooks)) {
      expect(entries.some((e) => e.hooks.some((h) => h.command.includes(script)))).toBe(true);
    }
  });

  // The host Directory is the cwd, but only listed once the host's Show
  // setting is on (default off) and only when a terminal exists
  // (clientMessageHandler hostDirectoriesFor), so this case keeps the terminal.
  it('sends the spawn cwd as the host Directory to a tokened /ws client on webviewReady', async () => {
    const host = await startHost({
      seed: (home) => seedConfig(home, { standalone: { showHostDirectories: true } }),
    });

    const token = host.url.searchParams.get('token')!;
    const msg = await messageAfterWebviewReady(host, `?token=${token}`, 'directoriesLoaded');

    const directories = msg.directories as Array<{ name: string; path: string; source: string }>;
    const hostDirs = directories.filter((d) => d.source === 'host');
    expect(hostDirs).toHaveLength(1);
    expect(fs.realpathSync(hostDirs[0].path)).toBe(fs.realpathSync(host.cwd));
    expect(hostDirs[0].name).toBe(path.basename(hostDirs[0].path));
  });
});
