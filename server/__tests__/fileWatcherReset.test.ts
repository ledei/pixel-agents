import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Same 'vscode' stub as fileWatcherDismissal.test.ts: fileWatcher imports it at load.
vi.mock('vscode', () => ({ window: { activeTerminal: undefined, terminals: [] } }));

import { AgentRuntime } from '../src/agentRuntime.js';
import { createAgentState } from '../src/agentState.js';
import { AgentStateStore } from '../src/agentStateStore.js';
import { scanForTeammateFiles, setTeamProvider } from '../src/fileWatcher.js';
import { claudeProvider } from '../src/providers/index.js';

describe('fileWatcher per-runtime state', () => {
  let tmpDir: string;
  const timers = new Map<number, ReturnType<typeof setInterval>>();

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-fw-reset-'));
  });

  afterEach(() => {
    for (const t of timers.values()) clearInterval(t);
    timers.clear();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // An office restarted in the same process (Obsidian) gets a fresh store; a
  // still-running inline teammate must be adopted again, not skipped as "known".
  it('re-adopts a teammate after the runtime is disposed', () => {
    const file = path.join(tmpDir, 'teammate.jsonl');
    fs.writeFileSync(file, '');
    // The runtime constructor installs the Claude team provider; stub it after.
    const runtime = new AgentRuntime(new AgentStateStore(), claudeProvider);
    setTeamProvider({
      discoverTeammates: () => [{ jsonlPath: file, teammateName: 'researcher' }],
    } as unknown as Parameters<typeof setTeamProvider>[0]);

    const adopt = (): AgentStateStore => {
      const store = new AgentStateStore();
      store.set(
        1,
        createAgentState({
          id: 1,
          sessionId: 's',
          isExternal: false,
          projectDir: tmpDir,
          jsonlFile: path.join(tmpDir, 's.jsonl'),
        }),
      );
      scanForTeammateFiles(
        tmpDir,
        's',
        1,
        { current: 2 },
        store,
        new Map(),
        timers,
        new Map(),
        new Map(),
        () => {},
      );
      return store;
    };

    expect(adopt().get(2)?.agentName).toBe('researcher');
    expect(adopt().get(2)).toBeUndefined();

    runtime.dispose();

    expect(adopt().get(2)?.agentName).toBe('researcher');
  });
});
