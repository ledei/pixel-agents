// Assemble the Obsidian plugin folder, dist/obsidian/, from the build outputs.
//
// `npm run build:obsidian` runs it after bundling dist/obsidian/main.js
// (`node esbuild.js --obsidian`); it also needs the full build's dist/assets,
// dist/hooks (`node esbuild.js`) and dist/webview (the webview build). The
// plugin folder mirrors the npm package's layout under its own dist/, so the
// office finds assets, the SPA and the hook script the same way the CLI does:
//
//   dist/obsidian/{main.js, manifest.json, styles.css, dist/{assets, webview, hooks}}
//
// Copy the whole folder to <vault>/.obsidian/plugins/pixel-agents/.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');
const adapterDir = path.join(root, 'adapters', 'obsidian');
const pluginDir = path.join(dist, 'obsidian');
const pluginDist = path.join(pluginDir, 'dist');

// Every script the server installs into ~/.pixel-agents/hooks/ (the hook script
// and the usage bars' status line bridge): a missing one fails the toggle.
const hookScripts = ['claude-hook.js', 'claude-statusline.js'];

const required = [
  path.join(pluginDir, 'main.js'),
  path.join(dist, 'assets'),
  path.join(dist, 'webview', 'index.html'),
  path.join(dist, 'claude-plugin', '.claude-plugin', 'marketplace.json'),
  ...hookScripts.map((name) => path.join(dist, 'hooks', name)),
];
const missing = required.filter((p) => !fs.existsSync(p));
if (missing.length > 0) {
  console.error(
    `[obsidian] Missing build output (run \`node esbuild.js\` and \`npm run build:webview\` first):\n  ${missing
      .map((p) => path.relative(root, p))
      .join('\n  ')}`,
  );
  process.exit(1);
}

fs.rmSync(pluginDist, { recursive: true, force: true });
fs.cpSync(path.join(dist, 'assets'), path.join(pluginDist, 'assets'), { recursive: true });
fs.cpSync(path.join(dist, 'webview'), path.join(pluginDist, 'webview'), { recursive: true });
fs.cpSync(path.join(dist, 'claude-plugin'), path.join(pluginDist, 'claude-plugin'), {
  recursive: true,
});
fs.mkdirSync(path.join(pluginDist, 'hooks'), { recursive: true });
for (const name of hookScripts) {
  fs.copyFileSync(path.join(dist, 'hooks', name), path.join(pluginDist, 'hooks', name));
}
fs.copyFileSync(path.join(adapterDir, 'styles.css'), path.join(pluginDir, 'styles.css'));

// The plugin version is the package version, stamped here so it cannot drift.
const { version } = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf-8'));
const { id, name, ...rest } = JSON.parse(
  fs.readFileSync(path.join(adapterDir, 'manifest.json'), 'utf-8'),
);
fs.writeFileSync(
  path.join(pluginDir, 'manifest.json'),
  `${JSON.stringify({ id, name, version, ...rest }, null, 2)}\n`,
);

console.log(`✓ Assembled Obsidian plugin ${version} → dist/obsidian/`);
