// A fake Obsidian host: the smallest stand-in for the Obsidian app that can run
// the built Pixel Agents plugin. Runs as its own Node process so the plugin is
// loaded, started and stopped across a real process boundary, like standalone's
// spawned CLI. It stubs only the `obsidian` module (Plugin, ItemView,
// FileSystemAdapter) and a DOM just rich enough to read the iframe URL.
//
// Usage: node obsidian-host.cjs <vaultDir>   (HOME/USERPROFILE set by the caller)
// stdout: "OBSIDIAN_VIEW_URL <url>" once the open view shows its office iframe.
// stdin lines: "close-view" -> close the open view (the last one stops the
//   office); "unload" (or SIGTERM, or stdin closing) -> unload the plugin and exit.
// Either answers with "OBSIDIAN_VIEW_CLOSED" / exits 0.
'use strict';

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const Module = require('module');

const vault = process.argv[2];
const pluginRel = path.join('.obsidian', 'plugins', 'pixel-agents');

function fakeEl(created) {
  const el = {
    empty() {},
    addClass() {},
    createDiv(opts) {
      return el.createEl('div', opts);
    },
    createEl(tag, opts = {}) {
      const child = Object.assign(fakeEl(created), { tag }, opts);
      created.push(child);
      return child;
    },
  };
  return el;
}

const views = {};
class Plugin {
  constructor(app, manifest) {
    this.app = app;
    this.manifest = manifest;
  }
  registerView(type, factory) {
    views[type] = factory;
  }
  addRibbonIcon() {}
  addCommand() {}
}
class ItemView {
  constructor(leaf) {
    this.leaf = leaf;
    this.created = [];
    this.contentEl = fakeEl(this.created);
  }
  registerDomEvent() {}
}
class FileSystemAdapter {
  constructor(base) {
    this.base = base;
  }
  getBasePath() {
    return this.base;
  }
}
const stub = { Plugin, ItemView, FileSystemAdapter };
const load = Module._load;
Module._load = function (request, ...rest) {
  return request === 'obsidian' ? stub : load.call(this, request, ...rest);
};

async function waitFor(find, what) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const found = find();
    if (found) return found;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for ${what}`);
}

/** Load the plugin as a fresh module, run onload and open one office view. */
async function openPlugin() {
  const mainPath = path.join(vault, pluginRel, 'main.js');
  // A fresh module per load, like a fresh renderer after Obsidian's reload.
  delete require.cache[mainPath];
  const Pixel = require(mainPath).default;
  const manifest = JSON.parse(
    fs.readFileSync(path.join(vault, pluginRel, 'manifest.json'), 'utf8'),
  );
  // Obsidian sets the vault-relative install folder on the manifest.
  manifest.dir = pluginRel;
  const app = { vault: { adapter: new FileSystemAdapter(vault) }, workspace: {} };
  const plugin = new Pixel(app, manifest);
  await plugin.onload();

  const view = Object.values(views)[0]({});
  await view.onOpen();
  const iframe = await waitFor(() => {
    const failed = view.created.find((c) => /could not start/.test(c.text ?? ''));
    if (failed) throw new Error(failed.text);
    return view.created.find((c) => c.tag === 'iframe');
  }, 'the office iframe');
  console.log(`OBSIDIAN_VIEW_URL ${iframe.attr.src}`);
  return { plugin, view };
}

async function main() {
  let current = await openPlugin();

  let unloading = false;
  async function unload() {
    if (unloading) return;
    unloading = true;
    await current.plugin.onunload();
    process.exit(0);
  }
  process.on('SIGTERM', () => void unload());
  const lines = readline.createInterface({ input: process.stdin });
  lines.on('line', (line) => {
    if (line.trim() === 'close-view') {
      void current.view.onClose().then(() => console.log('OBSIDIAN_VIEW_CLOSED'));
    } else if (line.trim() === 'reload') {
      // Obsidian's window reload: onunload is not awaited, and the next plugin
      // instance loads in the same process (same PID) right away.
      void current.plugin.onunload();
      void openPlugin().then((next) => {
        current = next;
      });
    } else if (line.trim() === 'unload') {
      void unload();
    }
  });
  lines.on('close', () => void unload());
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
