// Offline-friendly, deterministic build of Vendetta-compatible JS expression.
// Uses TypeScript's single-file transpiler and a tiny module loader rather than Rollup.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const ts = require('typescript');
const root = __dirname;
const input = path.join(root, 'plugins/vc-follow');
const output = path.join(root, 'dist/vc-follow');
fs.mkdirSync(output, { recursive: true });
const sources = {
  './index': 'src/index.ts',
  './Settings': 'src/Settings.tsx',
};
const compiled = {};
for (const [name, relativePath] of Object.entries(sources)) {
  const file = path.join(input, relativePath);
  const result = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    fileName: file,
    compilerOptions: {
      target: ts.ScriptTarget.ES2020,
      module: ts.ModuleKind.CommonJS,
      jsx: ts.JsxEmit.React,
      isolatedModules: true,
    },
    reportDiagnostics: true,
  });
  if (result.diagnostics?.length) {
    throw new Error(ts.formatDiagnosticsWithColorAndContext(result.diagnostics, {
      getCurrentDirectory: () => process.cwd(),
      getCanonicalFileName: name => name,
      getNewLine: () => '\n',
    }));
  }
  compiled[name] = result.outputText;
}
const factories = Object.entries(compiled).map(([name, js]) => {
  return `${JSON.stringify(name)}: function(module, exports, require) {\n${js}\n}`;
}).join(',\n');
const expression = `(function(vendetta){
"use strict";
const external = {
  '@vendetta': vendetta,
  '@vendetta/metro': vendetta.metro,
  '@vendetta/metro/common': vendetta.metro.common,
  '@vendetta/commands': vendetta.commands,
  '@vendetta/plugin': vendetta.plugin,
  '@vendetta/patcher': vendetta.patcher,
  '@vendetta/storage': vendetta.storage,
};
const factories = { ${factories} };
const cache = Object.create(null);
function require(id) {
  if (Object.prototype.hasOwnProperty.call(external, id)) return external[id];
  if (!Object.prototype.hasOwnProperty.call(factories, id)) throw new Error('Unknown VC Follow module '+id);
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
console.log('Built dist/vc-follow/index.js and manifest.json; hash', manifest.hash);

const page = (title, heading, message) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="theme-color" content="#5865f2">
<title>${title}</title>
<style>
:root{color-scheme:dark;font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#111318;color:#f4f5f7}
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px}
main{width:min(100%,560px);padding:32px;border:1px solid #30333d;border-radius:20px;background:#191b22;box-shadow:0 18px 60px #0005}
h1{font-size:clamp(28px,6vw,40px);line-height:1.1;margin:0 0 14px}p{color:#c5c8d0;line-height:1.6}
.link{display:block;overflow-wrap:anywhere;background:#101116;border:1px solid #383b46;padding:14px;border-radius:10px;color:#aebaff;margin:20px 0}
button,a.button{border:0;border-radius:10px;background:#5865f2;color:white;padding:13px 18px;font:inherit;font-weight:650;text-decoration:none;cursor:pointer;display:inline-block}
.small{font-size:13px;color:#9da2b0}
</style>
</head>
<body><main><p class="small">LIFAWAZ · REVENGE PLUGIN</p><h1>${heading}</h1><p>${message}</p><div class="link" id="install-url">https://LiFawaz.github.io/follow-vc/vc-follow/</div><button id="copy">Copy install link</button><p class="small">Open Revenge → Plugins → Install from URL, then paste the link above.</p></main>
<script>document.getElementById('copy').addEventListener('click',async()=>{const b=document.getElementById('copy');try{await navigator.clipboard.writeText(document.getElementById('install-url').textContent);b.textContent='Copied!'}catch(e){const r=document.createRange();r.selectNodeContents(document.getElementById('install-url'));const s=getSelection();s.removeAllRanges();s.addRange(r);b.textContent='Select and copy the link above'}})</script>
</body></html>
`;
fs.writeFileSync(path.join(output, 'index.html'), page('VC Follow install', 'Paste this into Revenge!', 'To install VC Follow, copy this link and paste it into Revenge’s plugin installer.'));
fs.writeFileSync(path.join(root, 'dist', '404.html'), page('Page not found · VC Follow', 'Paste this into Revenge!', 'This page is not a normal website page. To install VC Follow, copy the plugin link below and paste it into Revenge.'));

