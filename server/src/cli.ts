#!/usr/bin/env node

/**
 * Standalone CLI entry point: `npx pixel-agents`
 *
 * Starts the Fastify server in standalone mode with SPA serving and WebSocket.
 * Loads all assets (PNGs -> SpriteData) on startup and caches in memory.
 * Each connecting WebSocket client receives the full state on webviewReady.
 */

import * as path from 'path';

import {
  MAX_PORT,
  MIN_PORT,
  PTY_HOST_SCRIPT,
  TERMINAL_DISABLED_BY_FLAG_REASON,
  TERMINAL_KILL_GRACE_MS,
  TERMINAL_SHUTDOWN_SLACK_MS,
  WILDCARD_HOSTNAMES,
} from './constants.js';
import { hostDirectory } from './hostDirectory.js';
import { startOffice } from './office.js';
import {
  defaultPtyHostSocket,
  ptyHostLogFile,
  socketPathProblem,
} from './terminal/ptyHostProtocol.js';
import { PtySessionManager } from './terminal/ptySessionManager.js';
import { RemotePtySessions, startPtyHostProcess } from './terminal/remotePtySessions.js';
import type { TerminalSessions } from './terminal/terminalSessions.js';
import { isLoopbackHost, normalizeHostname } from './wsAuth.js';

// ── Argument parsing ──────────────────────────────────────────

export interface CliArgs {
  /** Unset -> ephemeral (OS-assigned) port, so multiple standalone instances
   *  can run at once without a collision. --port picks a fixed one. */
  port?: number;
  host: string;
  /** False when --no-terminal was passed: the office only watches agents; the
   *  browser can neither launch them nor attach to their terminals. */
  terminal: boolean;
  /** --allowed-host names (repeatable): extra Host names, beyond loopback and a
   *  specific --host, that a tokened browser session is privileged under --
   *  typically a reverse proxy's public name. See wsAuth.privilegedHostnames. */
  allowedHosts: string[];
  /** --rotate-token: replace the persisted server token before starting. */
  rotateToken: boolean;
  /** --pty-host (development only): keep the agents' terminals in a separate
   *  long-lived process, so restarting the server doesn't end them. */
  ptyHost: boolean;
  /** --pty-host-socket: where that process listens (default under ~/.pixel-agents). */
  ptyHostSocket?: string;
}

/** Thrown by parseArgs on an invalid --port. Kept separate from process.exit so
 *  the parsing logic stays a pure, unit-testable function -- main() is the only
 *  place that turns a bad argument into an exit code. */
export class CliArgsError extends Error {}

export function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    host: '127.0.0.1',
    terminal: true,
    allowedHosts: [],
    rotateToken: false,
    ptyHost: false,
  };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--port' || argv[i] === '-p') {
      const raw = argv[i + 1];
      if (raw === undefined) {
        throw new CliArgsError(
          `Missing value for ${argv[i]}: expected an integer between ${MIN_PORT} and ${MAX_PORT}.`,
        );
      }
      const parsed = Number(raw);
      if (!Number.isInteger(parsed) || parsed < MIN_PORT || parsed > MAX_PORT) {
        throw new CliArgsError(
          `Invalid --port "${raw}": must be an integer between ${MIN_PORT} and ${MAX_PORT}.`,
        );
      }
      args.port = parsed;
      i++;
    } else if (argv[i] === '--host' && argv[i + 1]) {
      args.host = argv[i + 1];
      i++;
    } else if (argv[i] === '--allowed-host') {
      const raw = argv[i + 1];
      const name = normalizeHostname(raw);
      if (name === null || (WILDCARD_HOSTNAMES as readonly string[]).includes(name)) {
        throw new CliArgsError(
          raw === undefined
            ? 'Missing value for --allowed-host: expected a host name, e.g. my-mac.tailnet.ts.net.'
            : `Invalid --allowed-host "${raw}": expected a host name, e.g. my-mac.tailnet.ts.net.`,
        );
      }
      args.allowedHosts.push(raw as string);
      i++;
    } else if (argv[i] === '--rotate-token') {
      args.rotateToken = true;
    } else if (argv[i] === '--no-terminal') {
      args.terminal = false;
    } else if (argv[i] === '--pty-host') {
      args.ptyHost = true;
    } else if (argv[i] === '--pty-host-socket') {
      const raw = argv[i + 1];
      if (!raw) throw new CliArgsError('Missing value for --pty-host-socket: expected a path.');
      args.ptyHost = true;
      args.ptyHostSocket = path.resolve(raw);
      i++;
    } else if (argv[i] === '--help') {
      console.log(`Usage: pixel-agents [options]

Options:
  --port, -p <number>   Port to listen on (default: OS-assigned ephemeral port)
  --host <string>       Host to bind to (default: 127.0.0.1)
  --allowed-host <name> Also accept the tokened URL at this host name, e.g. a
                        reverse proxy's (Tailscale Serve). Repeatable. Without
                        it, only localhost and a specific --host are privileged
  --rotate-token        Replace the server token. Every URL that carried the
                        old one (bookmarks, other devices) stops working
  --no-terminal         Disable the embedded terminal (watch agents only; no
                        launching or attaching from the browser)
  --pty-host            Development only: run agents' terminals in a separate
                        process that outlives the server, so restarting it
                        (e.g. to update it) leaves agents running
  --pty-host-socket <path>
                        That process's socket (implies --pty-host)
  --help                Show this help message`);
      process.exit(0);
    }
  }
  return args;
}

// ── Terminal status reporting ─────────────────────────────────

/**
 * Log one clear line about terminal availability, plus a security warning when
 * a working terminal is bound to a non-loopback address.
 *
 * The reason string matters: the most likely failure (npm >=11.16 gating
 * node-pty's install scripts, so it imports but can't spawn) is invisible
 * otherwise -- the user would just see a + Agent button that does nothing.
 *
 * Opting out with --no-terminal is not a failure, so it gets a quiet
 * confirmation instead of the reinstall hint, and skips the non-loopback shell
 * warning (there is no shell surface to warn about).
 */
function reportTerminalStatus(
  ptyManager: TerminalSessions,
  host: string,
  enabledByFlag: boolean,
): void {
  if (!enabledByFlag) {
    console.log(
      '[Pixel Agents] Terminal disabled (--no-terminal): agents can be watched but not launched from the browser.',
    );
    return;
  }

  if (!ptyManager.isAvailable()) {
    console.warn(
      `[Pixel Agents] Terminal disabled: ${ptyManager.unavailableReason()}\n` +
        `[Pixel Agents] The office still works; you just can't launch agents from the browser.\n` +
        `[Pixel Agents] To enable it, reinstall so the optional PTY module is present.`,
    );
    return;
  }

  console.log(`[Pixel Agents] Terminal enabled (via ${ptyManager.moduleId()})`);

  if (!isLoopbackHost(host)) {
    console.warn(
      `[Pixel Agents] WARNING: bound to ${host}, not loopback. The terminal is a shell:\n` +
        `[Pixel Agents] anyone who can reach this port AND has the auth token can run commands\n` +
        `[Pixel Agents] as you, and plain HTTP sends that token unencrypted. Behind a reverse\n` +
        `[Pixel Agents] proxy (e.g. Tailscale Serve), keep --host 127.0.0.1 and pass the proxy's\n` +
        `[Pixel Agents] name with --allowed-host instead.`,
    );
  }
}

// ── PTY host (development only) ───────────────────────────────

/** Connect to the PTY host, starting one (dist/pty-host.js) if none runs. */
async function connectPtyHost(distRoot: string, socketPath: string): Promise<RemotePtySessions> {
  const problem = socketPathProblem(socketPath);
  if (problem) throw new Error(problem);
  const sessions = await RemotePtySessions.connect({
    socketPath,
    startHost: () =>
      startPtyHostProcess(path.join(distRoot, PTY_HOST_SCRIPT), socketPath, ptyHostLogFile()),
  });
  const running = sessions.survivors().length;
  console.log(
    `[Pixel Agents] PTY host (pid ${sessions.hostPid}) on ${socketPath}: ${running} running terminal(s). ` +
      `Restarting this server leaves them running; stopping the host ends them.`,
  );
  return sessions;
}

/**
 * The terminals for agents this server launches. Construction is cheap -- the
 * native module is resolved (and probed) lazily on first use, so a user who
 * never opens a terminal never pays for it. With --no-terminal, a disabled
 * manager reports "unavailable" through the same plumbing (availability
 * broadcast, session route, launcher), so nothing downstream special-cases it.
 *
 * --pty-host (development only) moves them into a separate process that
 * outlives this one, so a restart leaves running agents alone. Throws when no
 * PTY host can be reached.
 */
async function openTerminalSessions(args: CliArgs, distRoot: string): Promise<TerminalSessions> {
  if (!args.terminal) return PtySessionManager.disabled(TERMINAL_DISABLED_BY_FLAG_REASON);
  if (args.ptyHost) {
    return connectPtyHost(distRoot, args.ptyHostSocket ?? defaultPtyHostSocket());
  }
  return new PtySessionManager();
}

// ── Main ──────────────────────────────────────────────────────

async function main(): Promise<void> {
  let args: CliArgs;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`[Pixel Agents] ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  // dist/ contains both the CLI bundle and the assets/ + webview/ directories
  const distRoot = __dirname;

  // Terminals for agents this server launches.
  const ptyManager = await openTerminalSessions(args, distRoot).catch((err: unknown) => {
    console.error(`[Pixel Agents] --pty-host: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });

  try {
    // Standalone scans, and contributes as its host Directory, the directory
    // it was started from.
    const office = await startOffice({
      distRoot,
      packageRoot: path.dirname(distRoot),
      staticDir: path.join(distRoot, 'webview'),
      namespace: 'standalone',
      host: args.host,
      port: args.port,
      ptyManager,
      keepAgentsOnStop: args.ptyHost,
      allowedHosts: args.allowedHosts,
      rotateToken: args.rotateToken,
      scanDir: process.cwd(),
      hostDirectory: hostDirectory(),
    });
    if (args.rotateToken) {
      console.log(
        '[Pixel Agents] Server token rotated: URLs carrying the old token no longer grant access. Open the new URL below on each device.',
      );
    }

    reportTerminalStatus(ptyManager, args.host, args.terminal);

    console.log(`\n  Pixel Agents server running at ${office.url}\n`);

    // ── Graceful shutdown ──
    let shuttingDown = false;
    async function shutdown(): Promise<void> {
      // A second Ctrl+C means "don't wait": quit without finishing the close.
      if (shuttingDown) process.exit(1);
      shuttingDown = true;
      console.log('\nShutting down...');
      // A request stuck mid-flight must not hold the exit: cap the close, past
      // the terminals' own kill budget so the server still gets to close.
      const cap = TERMINAL_KILL_GRACE_MS + TERMINAL_SHUTDOWN_SLACK_MS + 1_000;
      await Promise.race([office.stop(), new Promise((r) => setTimeout(r, cap).unref())]);
      process.exit(0);
    }

    process.on('SIGINT', () => void shutdown());
    process.on('SIGTERM', () => void shutdown());
  } catch (err) {
    console.error('Failed to start server:', err);
    process.exit(1);
  }
}

// Only auto-run when this file is executed directly (`node dist/cli.js`), not
// when it's imported for its exports (e.g. `parseArgs` in tests) -- importing
// it unconditionally used to start a real server and install real Claude
// hooks as a side effect of module load.
if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
