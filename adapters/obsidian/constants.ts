// ── Obsidian adapter: IDs, names and user-facing text ───────

import type { ConfigNamespace } from '../../server/src/configPersistence.js';

/** The office view's type, registered with `Plugin.registerView`. */
export const OFFICE_VIEW_TYPE = 'pixel-agents-office';
export const OFFICE_VIEW_TITLE = 'Pixel Agents';
/** Lucide icon name (Obsidian's icon set) for the ribbon and the view tab. */
export const OFFICE_ICON = 'bot';

/** Obsidian prefixes command ids with the plugin id: `pixel-agents:open-office`. */
export const OPEN_OFFICE_COMMAND_ID = 'open-office';
export const OPEN_OFFICE_COMMAND_NAME = 'Open office';

/** Settings section in ~/.pixel-agents/config.json and the obsidian-state.json file. */
export const SETTINGS_NAMESPACE: ConfigNamespace = 'obsidian';
/** Loopback only: the office is for this machine's Obsidian, not the LAN. */
export const OFFICE_HOST = '127.0.0.1';

/** Why "+ Agent" is unavailable: the PTY module is native and does not load in
 *  Obsidian's Electron, and Obsidian has no terminal of its own. */
export const TERMINAL_UNAVAILABLE_REASON =
  'Obsidian has no terminal to launch agents in. Agents you start in your own terminal still appear in the office.';

export const OFFICE_STARTING_TEXT = 'Starting the office…';
export const OFFICE_FAILED_TEXT = 'The office could not start:';
export const OFFICE_RETRY_TEXT = 'Retry';
/** The office copies (and pastes) through the Clipboard API. */
export const OFFICE_IFRAME_ALLOW = 'clipboard-read; clipboard-write';
