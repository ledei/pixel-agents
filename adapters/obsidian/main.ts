/**
 * Obsidian adapter: the office as an Obsidian view, its runtime in-process.
 *
 * The office starts when the first office view opens and stops when the last
 * one closes or the plugin unloads. The vault is the scan root and the host
 * Directory. There is no terminal: agents are watched and adopted, never
 * launched from the office.
 */

import { FileSystemAdapter, Plugin } from 'obsidian';
import * as path from 'path';

import type { Office } from '../../server/src/office.js';
import {
  OFFICE_HOST,
  OFFICE_ICON,
  OFFICE_VIEW_TITLE,
  OFFICE_VIEW_TYPE,
  OPEN_OFFICE_COMMAND_ID,
  OPEN_OFFICE_COMMAND_NAME,
  SETTINGS_NAMESPACE,
  TERMINAL_UNAVAILABLE_REASON,
} from './constants.js';
import { OfficeLifecycle } from './officeLifecycle.js';
import { OfficeView } from './officeView.js';

export default class PixelAgentsPlugin extends Plugin {
  private lifecycle: OfficeLifecycle | null = null;

  onload(): void {
    const lifecycle = new OfficeLifecycle(() => this.startOffice());
    this.lifecycle = lifecycle;
    this.registerView(OFFICE_VIEW_TYPE, (leaf) => new OfficeView(leaf, lifecycle));
    this.addRibbonIcon(OFFICE_ICON, OFFICE_VIEW_TITLE, () => void this.openOffice());
    this.addCommand({
      id: OPEN_OFFICE_COMMAND_ID,
      name: OPEN_OFFICE_COMMAND_NAME,
      callback: () => void this.openOffice(),
    });
  }

  /** Stop the office before the plugin goes: a window reload keeps the
   *  renderer's PID, so a server left behind looks alive to the next start. */
  async onunload(): Promise<void> {
    await this.lifecycle?.dispose();
  }

  /** Reveal the open office view, or open one in a new tab. */
  private async openOffice(): Promise<void> {
    const { workspace } = this.app;
    let leaf = workspace.getLeavesOfType(OFFICE_VIEW_TYPE)[0];
    if (!leaf) {
      leaf = workspace.getLeaf('tab');
      await leaf.setViewState({ type: OFFICE_VIEW_TYPE, active: true });
    }
    await workspace.revealLeaf(leaf);
  }

  /** The runtime (Fastify and all) loads on the first open, not with Obsidian. */
  private async startOffice(): Promise<Office> {
    const [{ startOffice }, { PtySessionManager }, { directoryNameFor }] = await Promise.all([
      import('../../server/src/office.js'),
      import('../../server/src/terminal/ptySessionManager.js'),
      import('../../server/src/hostDirectory.js'),
    ]);
    const { adapter } = this.app.vault;
    if (!(adapter instanceof FileSystemAdapter)) {
      throw new Error('Pixel Agents needs a vault on the local file system.');
    }
    if (!this.manifest.dir) throw new Error('Obsidian did not say where the plugin is installed.');
    const vaultPath = adapter.getBasePath();
    // The plugin folder is laid out like the npm package: dist/assets,
    // dist/webview and dist/hooks next to main.js.
    const pluginDir = path.join(vaultPath, this.manifest.dir);
    const distRoot = path.join(pluginDir, 'dist');
    return startOffice({
      distRoot,
      packageRoot: pluginDir,
      staticDir: path.join(distRoot, 'webview'),
      namespace: SETTINGS_NAMESPACE,
      host: OFFICE_HOST,
      ptyManager: PtySessionManager.disabled(TERMINAL_UNAVAILABLE_REASON),
      allowedHosts: [],
      rotateToken: false,
      scanDir: vaultPath,
      hostDirectory: { name: directoryNameFor(vaultPath), path: vaultPath },
    });
  }
}
