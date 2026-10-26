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

test("provides follow and unfollow commands without a profile-menu patch", () => {
  assert.match(source, /\["vcf",\s*"Follow a user voice channel by Discord user ID"/);
  assert.match(source, /\["vcunf",\s*"Stop following the current user"/);
  assert.match(source, /function registerCommands\(/);
  assert.match(source, /function followUser\(/);
  assert.match(source, /function stopFollowing\(/);
  assert.match(source, /function onVoiceUpdate\(/);
  assert.doesNotMatch(source, /function patchMenu\(/);
  assert.doesNotMatch(source, /vc-follow-profile/);
  assert.match(source, /selectVoiceChannel/);
});

test("validates Discord user IDs and registers cleanup", () => {
  assert.match(source, /\\d\{15,22\}/);
  assert.match(source, /unpatches\.splice\(0\)\.reverse\(\)/);
  assert.match(source, /return stopPlugin/);
});
