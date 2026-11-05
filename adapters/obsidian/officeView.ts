/**
 * The office as an Obsidian view: a status line while the office starts, then
 * the office itself in an iframe on its tokened URL (the token is what makes
 * the session privileged, not read-only).
 */

import type { WorkspaceLeaf } from 'obsidian';
import { ItemView } from 'obsidian';

import {
  OFFICE_FAILED_TEXT,
  OFFICE_ICON,
  OFFICE_IFRAME_ALLOW,
  OFFICE_RETRY_TEXT,
  OFFICE_STARTING_TEXT,
  OFFICE_VIEW_TITLE,
  OFFICE_VIEW_TYPE,
} from './constants.js';
import type { OfficeLifecycle } from './officeLifecycle.js';

export class OfficeView extends ItemView {
  private isOpen = false;

  constructor(
    leaf: WorkspaceLeaf,
    private readonly lifecycle: OfficeLifecycle,
  ) {
    super(leaf);
  }

  getViewType(): string {
    return OFFICE_VIEW_TYPE;
  }

  getDisplayText(): string {
    return OFFICE_VIEW_TITLE;
  }

  getIcon(): string {
    return OFFICE_ICON;
  }

  async onOpen(): Promise<void> {
    this.isOpen = true;
    this.contentEl.addClass('pixel-agents-office');
    // Not awaited: Obsidian waits for onOpen, and the status line should show
    // while the office starts.
    void this.show();
  }

  async onClose(): Promise<void> {
    this.isOpen = false;
    await this.lifecycle.release();
  }

  private async show(): Promise<void> {
    const el = this.contentEl;
    el.empty();
    el.createDiv({ cls: 'pixel-agents-status', text: OFFICE_STARTING_TEXT });
    try {
      const url = await this.lifecycle.acquire();
      if (!this.isOpen) return;
      el.empty();
      el.createEl('iframe', {
        cls: 'pixel-agents-frame',
        attr: { src: url, allow: OFFICE_IFRAME_ALLOW },
      });
    } catch (err) {
      console.error('[Pixel Agents] Office failed to start:', err);
      if (!this.isOpen) return;
      el.empty();
      const status = el.createDiv({ cls: 'pixel-agents-status' });
      status.createDiv({
        text: `${OFFICE_FAILED_TEXT} ${err instanceof Error ? err.message : String(err)}`,
      });
      const retry = status.createEl('button', { text: OFFICE_RETRY_TEXT });
      this.registerDomEvent(retry, 'click', () => void this.retry());
    }
  }

  /** This view's failed acquire still counts as an open view: give it back first. */
  private async retry(): Promise<void> {
    await this.lifecycle.release();
    await this.show();
  }
}
