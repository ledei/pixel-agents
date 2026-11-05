/**
 * The office runtime as an adapter composes it: assets, store, runtime, server,
 * hooks and scanning, wired once for any host that serves the office from a
 * local server (the standalone CLI, the Obsidian plugin).
 *
 * Host-agnostic on purpose: it never reads process.cwd(), never prints the URL
 * and never exits the process. The host says where to scan, which Directory it
 * contributes and which settings namespace it owns; it decides what to do with
 * the URL and when to stop.
 */

import { AgentRuntime } from './agentRuntime.js';
import { AgentStateStore } from './agentStateStore.js';
import {
  buildAssetCache,
  loadAllCharacters,
  loadAllFurniture,
  loadAllPets,
} from './assetReload.js';
import type { AssetCache, ReloadAssetsSideEffect } from './clientMessageHandler.js';
import type { ConfigNamespace } from './configPersistence.js';
import {
  getHooksConsent,
  getHooksEnabled,
  grantHooksConsent,
  readConfig,
} from './configPersistence.js';
import type { HostDirectoryEntry } from './directories.js';
import { FileStateAdapter } from './fileStateAdapter.js';
import { claudeProvider, copyHookScript, hookProviderById } from './providers/index.js';
import type { ServerConfig } from './server.js';
import { PixelAgentsServer } from './server.js';
import type { PtySessionManager } from './terminal/ptySessionManager.js';

type OfficeLog = Pick<Console, 'log' | 'error'>;

export interface OfficeOptions {
  /** Folder holding assets/ (and, for the CLI, the bundle itself). */
  distRoot: string;
  /** Folder whose dist/hooks/ holds the bundled hook script. */
  packageRoot: string;
  /** The webview SPA served at `/`. */
  staticDir: string;
  /** Settings section and state file this host owns. */
  namespace: ConfigNamespace;
  host: string;
  /** Unset -> OS-assigned port. */
  port?: number;
  ptyManager: PtySessionManager;
  allowedHosts: string[];
  rotateToken: boolean;
  /** Project the office scans for sessions. */
  scanDir: string;
  /** The Directory this host contributes; null contributes none. */
  hostDirectory: HostDirectoryEntry | null;
  log?: OfficeLog;
}

export interface Office {
  /** The tokened, browsable URL: what makes a session privileged. */
  url: string;
  config: ServerConfig;
  /** False when a compatible running server was reused instead of started. */
  ownsServer: boolean;
  /** Kill terminals, stop the runtime and the server. Idempotent; never exits the process. */
  stop(): Promise<void>;
}

/**
 * Copy the bundled hook script into ~/.pixel-agents/hooks/, reporting failure.
 *
 * Callers run this BEFORE installing the settings.json entries and abort when
 * it returns false: an entry whose command points at a missing script makes
 * Claude Code spawn a dead `node` process for every event, which is strictly
 * worse than no hooks at all.
 */
function copyHookScriptOrReport(packageRoot: string, log: OfficeLog, context = ''): boolean {
  if (copyHookScript(packageRoot)) return true;
  log.error(`[Pixel Agents] Hooks NOT installed${context}: hook script missing.`);
  return false;
}

export async function startOffice(options: OfficeOptions): Promise<Office> {
  const { distRoot, packageRoot, ptyManager } = options;
  const log = options.log ?? console;

  // ── Load assets on startup (same pipeline as VS Code extension) ──
  // External asset directories are merged at startup too, so directories added
  // in a previous session survive a restart. buildAssetCache is the shared
  // loader used by both the standalone server and the VS Code adapter.
  log.log('[Pixel Agents] Loading assets...');
  const assetCache: AssetCache = await buildAssetCache(
    distRoot,
    readConfig().externalAssetDirectories,
  );
  const charCount = assetCache.characters?.characters.length ?? 0;
  const petCount = assetCache.pets?.pets.length ?? 0;
  const furnitureCount = assetCache.furniture?.catalog.length ?? 0;
  log.log(
    `[Pixel Agents] Assets loaded: ${charCount} characters, ${petCount} pets, ${furnitureCount} furniture items`,
  );

  // ── Store + adapter (shared settings + host-scoped agents/seats) ──
  const store = new AgentStateStore();
  const adapter = new FileStateAdapter({ namespace: options.namespace });
  store.setAdapter(adapter);

  const server = new PixelAgentsServer();
  const runtime = new AgentRuntime(store, claudeProvider);

  let stopping: Promise<void> | null = null;
  const stop = (): Promise<void> => {
    stopping ??= (async () => {
      // Kill child terminals before the runtime tears their agents down, and
      // wait for them: exiting now would cancel the SIGKILL escalation and
      // leave a child that ignores SIGHUP orphaned on a dead server.
      await ptyManager.disposeAll();
      runtime.dispose();
      await server.stop();
    })();
    return stopping;
  };

  // Wire hook events: HTTP POST -> runtime -> hookEventHandler -> agents
  server.onHookEvent((providerId, event) => {
    runtime.handleHookEvent(providerId, event);
  });

  // onSetHooksEnabled side effect: install/uninstall the named provider's
  // hooks when the user toggles in the UI (or answers the consent ask).
  // Captures config from the outer scope after server.start().
  let currentConfig: { port: number; token: string } | null = null;
  const onSetHooksEnabled = async (providerId: string, enabled: boolean): Promise<void> => {
    if (!currentConfig) return;
    const provider = hookProviderById(providerId);
    if (!provider) return; // unknown id: nothing to install into
    if (enabled) {
      // An explicit toggle in the UI IS the consent to modify the
      // provider's settings file. The bundled claude-hook.js script belongs
      // to the Claude provider alone; another provider's install must
      // neither copy it nor be blocked by it.
      grantHooksConsent(provider.id);
      if (
        provider.id === claudeProvider.id &&
        !copyHookScriptOrReport(packageRoot, log, ' (user toggle)')
      ) {
        return;
      }
      try {
        await provider.installHooks(`http://127.0.0.1:${currentConfig.port}`, currentConfig.token);
      } catch (err) {
        log.error(`[Pixel Agents] ${err instanceof Error ? err.message : String(err)}`);
        return;
      }
      log.log('[Pixel Agents] Hooks installed (user toggle)');
    } else {
      try {
        await provider.uninstallHooks();
        log.log('[Pixel Agents] Hooks uninstalled (user toggle)');
      } catch (err) {
        log.error(`[Pixel Agents] ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  };

  // onReloadAssets side effect: re-run the shared loaders (bundled + external
  // dirs) after an external-asset-directory change, then re-broadcast the
  // updated sprites to the requesting client. Mutates the assetCache object in
  // place so already-open sockets (which captured the same reference) and
  // future webviewReady handshakes both observe the new assets. Only
  // characters/pets/furniture can come from external dirs, so only those three
  // are reloaded and re-sent (mirrors the VS Code reload path).
  const onReloadAssets: ReloadAssetsSideEffect = async (send): Promise<void> => {
    const externalDirs = readConfig().externalAssetDirectories;
    const [characters, pets, furniture] = await Promise.all([
      loadAllCharacters(distRoot, externalDirs),
      loadAllPets(distRoot, externalDirs),
      loadAllFurniture(distRoot, externalDirs),
    ]);
    assetCache.characters = characters;
    assetCache.pets = pets;
    assetCache.furniture = furniture;
    if (characters) {
      send({ type: 'characterSpritesLoaded', characters: characters.characters });
    }
    if (pets) {
      send({
        type: 'petSpritesLoaded',
        pets: pets.pets,
        petNames: pets.manifests.map((m) => m.name),
      });
    }
    if (furniture) {
      send({
        type: 'furnitureAssetsLoaded',
        catalog: furniture.catalog,
        sprites: Object.fromEntries(furniture.sprites),
      });
    }
    log.log('[Pixel Agents] Assets reloaded (external directory change)');
  };

  try {
    const config = await server.start({
      store,
      runtime,
      embedded: false,
      host: options.host,
      port: options.port,
      staticDir: options.staticDir,
      assetCache,
      onSetHooksEnabled,
      onReloadAssets,
      ptyManager,
      allowedHosts: options.allowedHosts,
      rotateToken: options.rotateToken,
      namespace: options.namespace,
      hostDirectory: options.hostDirectory,
    });
    currentConfig = { port: config.port, token: config.token };

    // Sync runtime refs with persisted settings BEFORE first scan tick. The
    // runtime's single hooksEnabled ref follows the Claude provider until the
    // scanners grow per-provider awareness alongside the Settings UI.
    runtime.hooksEnabled.current = getHooksEnabled(claudeProvider.id);
    runtime.watchAllSessions.current = adapter.getSetting('pixel-agents.watchAllSessions', false);

    // Install hooks on startup if the persisted setting says so — gated on the
    // one-time consent to modify ~/.claude/settings.json. First-run consent is
    // asked IN THE APP: the server sends a hooksConsentRequest to privileged
    // (tokened) connections during the webviewReady handshake
    // (clientMessageHandler.ts). The one exception that needs no dialog is the
    // silent-grant migration below.
    if (runtime.hooksEnabled.current) {
      let consent = getHooksConsent(claudeProvider.id) === 'granted';
      if (!consent && (await claudeProvider.areHooksInstalled())) {
        // Our hooks are already installed and already firing — a pre-consent
        // version put them there. Grant and continue with NO prompt: the
        // install below is the 14 -> 12 migration, and it only ever REDUCES
        // scope (it drops UserPromptSubmit and TaskCreated, the two events that
        // forwarded prompt text and were consumed by nothing). Asking would buy
        // this user no protection they do not already have, so they are not
        // asked. A fresh install still is, in full — in the browser UI, when a
        // tokened client connects (clientMessageHandler's webviewReady).
        grantHooksConsent(claudeProvider.id);
        consent = true;
      }
      if (!consent) {
        log.log(
          '[Pixel Agents] Hooks not installed: modifying ~/.claude/settings.json needs one-time approval — approve it in the office.',
        );
      } else if (copyHookScriptOrReport(packageRoot, log)) {
        try {
          await claudeProvider.installHooks(`http://127.0.0.1:${config.port}`, config.token);
          log.log('[Pixel Agents] Hooks installed');
        } catch (err) {
          log.error(`[Pixel Agents] ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    } else {
      // Without this line, a persisted hooks-off makes startup skip the entire
      // consent/install flow with zero output — indistinguishable from a bug.
      log.log(
        '[Pixel Agents] Hooks disabled — enable "Instant Detection (Hooks)" in the UI settings to install them.',
      );
    }

    // Start scanning for external sessions (Claude running in user's terminal)
    const projectDir = claudeProvider.getSessionDirs?.(options.scanDir)[0];
    if (projectDir) {
      log.log(`[Pixel Agents] Scanning project dir: ${projectDir}`);
      runtime.startProjectScan(projectDir);
      runtime.startExternalScanning(projectDir);
      runtime.startStaleCheck();
    }

    // The URL has to be REACHABLE (a wildcard bind address is a bind target,
    // not an address you can browse to — `--host 0.0.0.0` used to print a dead
    // `http://0.0.0.0:PORT`) and has to carry the token, which is what makes
    // the session it loads privileged enough to approve a hook install (see
    // standaloneTokenValid in httpServer.ts). Under `--host 0.0.0.0` the office
    // stays readable from the LAN at this machine's own address; only the
    // consent-bearing toggle needs the token.
    const displayHost =
      options.host === '0.0.0.0' || options.host === '::' || options.host === ''
        ? '127.0.0.1'
        : options.host;
    return {
      url: `http://${displayHost}:${config.port}/?token=${config.token}`,
      config,
      ownsServer: server.isOwner(),
      stop,
    };
  } catch (err) {
    await stop();
    throw err;
  }
}
