import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';

// Isolated HOME: the office writes config, registry entries and server.json
// under os.homedir(), and must never touch the real ~/.pixel-agents.
let tempHome: string;
vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os');
  return { ...actual, homedir: () => tempHome };
});

// Must import AFTER mock setup.
const { startOffice } = await import('../src/office.js');
const { claudeProvider } = await import('../src/providers/index.js');
const { PtySessionManager } = await import('../src/terminal/ptySessionManager.js');

type Office = Awaited<ReturnType<typeof startOffice>>;
type OfficeOptions = Parameters<typeof startOffice>[0];

/** The base build's dist/ (assets, webview, hooks), as the CLI bundle sees it. */
const DIST_ROOT = path.join(__dirname, '../../dist');

describe.skipIf(!fs.existsSync(path.join(DIST_ROOT, 'webview')))('startOffice', () => {
  let scanDir: string;
  let lines: string[];
  const offices: Office[] = [];

  beforeEach(() => {
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-office-home-'));
    scanDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-office-scan-'));
    lines = [];
  });

  afterEach(async () => {
    for (const office of offices.splice(0)) await office.stop();
    fs.rmSync(tempHome, { recursive: true, force: true });
    fs.rmSync(scanDir, { recursive: true, force: true });
  });

  async function start(overrides: Partial<OfficeOptions> = {}): Promise<Office> {
    const record = (...args: unknown[]) => lines.push(args.map(String).join(' '));
    const office = await startOffice({
      distRoot: DIST_ROOT,
      packageRoot: path.dirname(DIST_ROOT),
      staticDir: path.join(DIST_ROOT, 'webview'),
      namespace: 'obsidian',
      host: '127.0.0.1',
      ptyManager: PtySessionManager.disabled('no terminal in this test'),
      allowedHosts: [],
      rotateToken: false,
      scanDir,
      hostDirectory: { name: 'vault', path: scanDir },
      log: { log: record, error: record },
      ...overrides,
    });
    offices.push(office);
    return office;
  }

  it('serves a tokened URL and scans the given scan root, not the process cwd', async () => {
    const office = await start();

    const url = new URL(office.url);
    expect(url.searchParams.get('token')).toBe(office.config.token);
    expect(office.ownsServer).toBe(true);
    expect((await fetch(new URL('/api/health', url))).ok).toBe(true);

    const projectDir = claudeProvider.getSessionDirs!(scanDir)[0];
    expect(projectDir).not.toBe(claudeProvider.getSessionDirs!(process.cwd())[0]);
    expect(lines).toContain(`[Pixel Agents] Scanning project dir: ${projectDir}`);
  });

  it('stop() closes the port and removes its discovery records, once, without exiting', async () => {
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    try {
      const office = await start();
      expect(registryEntries()).toEqual([`${process.pid}-${office.config.port}.json`]);

      await office.stop();
      await office.stop();

      expect(registryEntries()).toEqual([]);
      expect(fs.existsSync(path.join(tempHome, '.pixel-agents', 'server.json'))).toBe(false);
      await expect(fetch(new URL('/api/health', office.url))).rejects.toThrow();
      expect(exit).not.toHaveBeenCalled();
    } finally {
      exit.mockRestore();
    }
  });

  // An Obsidian window reload keeps the renderer PID but drops the server, so
  // an office that was never stopped leaves an entry whose pid is alive (ours)
  // and whose port is dead. The next office must not adopt it.
  it('starts its own server over a same-process entry no live server owns', async () => {
    const first = await start();
    const [entryName] = registryEntries();
    const entryPath = path.join(tempHome, '.pixel-agents', 'servers', entryName);
    const leftBehind = fs.readFileSync(entryPath);
    await first.stop();
    fs.writeFileSync(entryPath, leftBehind);

    const second = await start();

    expect(second.ownsServer).toBe(true);
    expect((await fetch(new URL('/api/health', second.url))).ok).toBe(true);
    expect(registryEntries()).toEqual([`${process.pid}-${second.config.port}.json`]);
  });

  describe('host Directory', () => {
    // Host Directories are listed only while the namespace's Show setting is on.
    beforeEach(() => seedConfig({ obsidian: { showHostDirectories: true } }));

    it('lists the given host Directory to a tokened client', async () => {
      const office = await start({ hostDirectory: { name: 'My Vault', path: scanDir } });

      const msg = await firstReply(office, [{ type: 'webviewReady' }], 'directoriesLoaded');

      expect(hostEntries(msg)).toEqual([{ name: 'My Vault', path: scanDir }]);
    });

    it('lists no host Directory when the host contributes none', async () => {
      const office = await start({ hostDirectory: null });

      const msg = await firstReply(office, [{ type: 'webviewReady' }], 'directoriesLoaded');

      expect(hostEntries(msg)).toEqual([]);
    });
  });

  describe('settings namespace', () => {
    it('keeps area mappings in its own section, for saves, webviewReady and refusals', async () => {
      seedConfig({ standalone: { areaMappings: { frontend: ['Standalone'] } } });
      const office = await start({ namespace: 'obsidian' });

      const loaded = await firstReply(
        office,
        [{ type: 'saveAreaMappings', mappings: { vault: ['Notes'] } }, { type: 'webviewReady' }],
        'areaMappingsLoaded',
      );
      const refused = await firstReply(
        office,
        [{ type: 'saveAreaMappings', mappings: { other: ['Elsewhere'] } }],
        'areaMappingsLoaded',
        { tokened: false },
      );

      const cfg = JSON.parse(
        fs.readFileSync(path.join(tempHome, '.pixel-agents', 'config.json'), 'utf-8'),
      ) as Record<string, { areaMappings: unknown }>;
      expect(cfg.obsidian.areaMappings).toEqual({ vault: ['Notes'] });
      expect(cfg.standalone.areaMappings).toEqual({ frontend: ['Standalone'] });
      expect(loaded.mappings).toEqual({ vault: ['Notes'] });
      expect(refused.mappings).toEqual({ vault: ['Notes'] });
    });

    /** Report a session from a project outside the scan root over the hook
     *  endpoint, before any client's webviewReady could re-sync the runtime,
     *  and say whether the office adopted it. */
    async function adoptsSessionOutsideScanRoot(office: Office): Promise<boolean> {
      const sessionId = '0b1c2d3e-0000-4000-8000-000000000001';
      const projectDir = path.join(tempHome, '.claude', 'projects', '-somewhere-else');
      const transcriptPath = path.join(projectDir, `${sessionId}.jsonl`);
      fs.mkdirSync(projectDir, { recursive: true });
      fs.writeFileSync(transcriptPath, '');

      const ws = new WebSocket(`ws://127.0.0.1:${office.config.port}/ws`);
      const created: unknown[] = [];
      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString()) as { type: string };
        if (msg.type === 'agentCreated') created.push(msg);
      });
      await new Promise((resolve) => ws.once('open', resolve));
      try {
        for (const hook_event_name of ['SessionStart', 'Stop']) {
          await fetch(`http://127.0.0.1:${office.config.port}/api/hooks/claude`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${office.config.token}`,
            },
            body: JSON.stringify({
              session_id: sessionId,
              hook_event_name,
              transcript_path: transcriptPath,
              cwd: '/somewhere/else',
              source: 'startup',
            }),
          });
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
        return created.length > 0;
      } finally {
        ws.close();
      }
    }

    it("obsidian's watch-all default reaches the runtime: it adopts a session outside the scan root", async () => {
      const office = await start({ namespace: 'obsidian' });

      expect(await adoptsSessionOutsideScanRoot(office)).toBe(true);
    });

    it('standalone keeps watch-all off: it leaves that session alone', async () => {
      const office = await start({ namespace: 'standalone' });

      expect(await adoptsSessionOutsideScanRoot(office)).toBe(false);
    });
  });
});

function registryEntries(): string[] {
  const dir = path.join(tempHome, '.pixel-agents', 'servers');
  return fs.existsSync(dir) ? fs.readdirSync(dir) : [];
}

function seedConfig(config: object): void {
  fs.mkdirSync(path.join(tempHome, '.pixel-agents'), { recursive: true });
  fs.writeFileSync(path.join(tempHome, '.pixel-agents', 'config.json'), JSON.stringify(config));
}

function hostEntries(msg: Record<string, unknown>): Array<{ name: string; path: string }> {
  return (msg.directories as Array<{ name: string; path: string; source: string }>)
    .filter((d) => d.source === 'host')
    .map(({ name, path }) => ({ name, path }));
}

/** Open /ws -- with the office's token as the SPA does from its URL, or
 *  without it as a read-only viewer -- send `messages` in order, and resolve
 *  with the first message of `type` the office answers with. */
async function firstReply(
  office: { url: string; config: { port: number } },
  messages: object[],
  type: string,
  { tokened = true } = {},
): Promise<Record<string, unknown>> {
  const query = tokened ? `?token=${new URL(office.url).searchParams.get('token')}` : '';
  const ws = new WebSocket(`ws://127.0.0.1:${office.config.port}/ws${query}`);
  try {
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`no ${type}`)), 5_000);
      ws.on('error', reject);
      ws.on('open', () => messages.forEach((m) => ws.send(JSON.stringify(m))));
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
