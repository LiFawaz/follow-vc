// Deterministic TypeScript build for the Revenge-compatible plugins in this repository.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const ts = require('typescript');
const root = __dirname;

function compilePlugin(pluginName) {
  const input = path.join(root, 'plugins', pluginName);
  const output = path.join(root, 'dist', pluginName);
  fs.mkdirSync(output, { recursive: true });
  const sources = { './index': 'src/index.ts', './Settings': 'src/Settings.tsx' };
  const compiled = {};
  for (const [name, relativePath] of Object.entries(sources)) {
    const file = path.join(input, relativePath);
    const result = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
      fileName: file,
      compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React, isolatedModules: true },
      reportDiagnostics: true,
    });
    if (result.diagnostics?.length) throw new Error(ts.formatDiagnosticsWithColorAndContext(result.diagnostics, {
      getCurrentDirectory: () => process.cwd(), getCanonicalFileName: name => name, getNewLine: () => '\n',
    }));
    compiled[name] = result.outputText;
  }
  const factories = Object.entries(compiled).map(([name, js]) => `${JSON.stringify(name)}: function(module, exports, require) {\n${js}\n}`).join(',\n');
  const expression = `(function(vendetta){\n"use strict";\nconst external = {
  '@vendetta': vendetta, '@vendetta/metro': vendetta.metro, '@vendetta/metro/common': vendetta.metro.common,
  '@vendetta/commands': vendetta.commands, '@vendetta/plugin': vendetta.plugin, '@vendetta/patcher': vendetta.patcher,
  '@vendetta/storage': vendetta.storage, '@vendetta/ui/components': vendetta.ui?.components,
  '@vendetta/ui/toasts': vendetta.ui?.toasts,
};
const factories = { ${factories} };
const cache = Object.create(null);
function require(id) {
  if (Object.prototype.hasOwnProperty.call(external, id)) return external[id];
  if (!Object.prototype.hasOwnProperty.call(factories, id)) throw new Error('Unknown plugin module '+id);
  if (cache[id]) return cache[id].exports;
  const module = cache[id] = {exports:{}};
  factories[id](module, module.exports, require);
  return module.exports;
}
return require('./index');
})(vendetta)`;
  fs.writeFileSync(path.join(output, 'index.js'), expression + '\n');
  const manifest = JSON.parse(fs.readFileSync(path.join(input, 'manifest.json'), 'utf8'));
  manifest.main = 'index.js';
  manifest.hash = crypto.createHash('sha256').update(expression + '\n').digest('hex');
  fs.writeFileSync(path.join(output, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  console.log('Built dist/' + pluginName + '/index.js');
  const url = 'https://LiFawaz.github.io/follow-vc/' + pluginName + '/';
  const page = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${manifest.name} · Install in Revenge</title><style>:root{color-scheme:light;font-family:system-ui,sans-serif;color:#18181b;background:#fff}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px}main{width:min(100%,560px)}h1{font-size:clamp(30px,7vw,44px);line-height:1.1}p{color:#71717a;line-height:1.6}.url{padding:15px;border:1px solid #e4e4e7;border-radius:14px;background:#fafafa;overflow-wrap:anywhere;font:14px/1.5 ui-monospace,monospace}button{margin-top:12px;width:100%;padding:13px;border:0;border-radius:12px;background:#5865f2;color:white;font:600 15px system-ui}</style></head><body><main><p>LIFAWAZ · REVENGE PLUGIN</p><h1>Put this into Revenge</h1><p>Copy this plugin URL and paste it into Revenge → Plugins → Install from URL.</p><div class="url" id="url">${url}</div><button id="copy">Copy plugin URL</button><p id="status">If copying fails, select the URL and copy it manually.</p></main><script>document.getElementById('copy').onclick=async()=>{try{await navigator.clipboard.writeText(document.getElementById('url').textContent);document.getElementById('status').textContent='Copied. Paste it into Revenge → Plugins.'}catch(e){document.getElementById('status').textContent='Select and copy the URL above manually.'}}</script></body></html>`;
  fs.writeFileSync(path.join(output, 'index.html'), page);
}
for (const name of ['vc-follow', 'fake-deafen']) compilePlugin(name);
fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
fs.writeFileSync(path.join(root, 'dist', '404.html'), '<!doctype html><html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Plugin not found</title><body><h1>Revenge plugins</h1><p>Install VC Follow: <a href="/follow-vc/vc-follow/">vc-follow</a></p><p>Install Fake-deaf: <a href="/follow-vc/fake-deafen/">fake-deafen</a></p></body></html>\n');
