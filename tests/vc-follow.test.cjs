const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const source = fs.readFileSync(path.join(root, "plugins/vc-follow/src/index.ts"), "utf8");
const manifest = JSON.parse(fs.readFileSync(path.join(root, "plugins/vc-follow/manifest.json"), "utf8"));
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));

test("uses the official Revenge Next build toolchain", () => {
  assert.equal(pkg.scripts.build, "revenge-plugin build");
  assert.ok(pkg.dependencies["@revenge-mod/plugin-cli"]);
  assert.ok(pkg.dependencies["@revenge-mod/types"]);
  assert.doesNotMatch(source, /@vendetta\//);
  assert.doesNotMatch(source, /@revenge-mod\/metro/);
  assert.match(source, /@revenge-mod\/modules\/finders/);
});

test("exports a Revenge plugin with persistent settings", () => {
  assert.match(source, /export default plugin</);
  assert.match(source, /jsonStorage:\s*\{/);
  assert.match(source, /SettingsComponent/);
  assert.equal(manifest.format, 1);
  assert.equal(manifest.dist.script, "index.js");
  assert.ok(manifest.dependencies["revenge.api"]);
});

test("retains user-facing VC Follow features", () => {
  for (const feature of [
    'name: "vcf"',
    'name: "vcunf"',
    "function followUser(",
    "function stopFollowing(",
    "function onVoiceUpdate(",
    "function patchMenu(",
    'id: "vc-follow-profile"',
    "selectVoiceChannel",
  ]) {
    assert.ok(source.includes(feature), `Missing feature marker: ${feature}`);
  }
});

test("validates Discord user IDs and registers cleanup", () => {
  assert.match(source, /\\d\{15,22\}/);
  assert.match(source, /unpatches\.splice\(0\)\.reverse\(\)/);
  assert.match(source, /return stopPlugin/);
});
