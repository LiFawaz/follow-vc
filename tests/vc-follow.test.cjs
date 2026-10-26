const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const source = fs.readFileSync(path.join(root, "plugins/vc-follow/src/index.ts"), "utf8");
const manifest = JSON.parse(fs.readFileSync(path.join(root, "plugins/vc-follow/manifest.json"), "utf8"));
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const deploy = fs.readFileSync(path.join(root, ".github/workflows/deploy.yml"), "utf8");
const readme = fs.readFileSync(path.join(root, "README.md"), "utf8");

test("uses the official Revenge Next build toolchain", () => {
  assert.equal(pkg.scripts.build, "revenge-plugin build");
  assert.ok(pkg.dependencies["@revenge-mod/plugin-cli"]);
  assert.ok(pkg.dependencies["@revenge-mod/types"]);
  assert.doesNotMatch(source, /@vendetta\//);
  assert.doesNotMatch(source, /@revenge-mod\/metro/);
  assert.match(source, /@revenge-mod\/modules\/finders/);
});

test("has a valid native Revenge Next manifest", () => {
  assert.equal(manifest.format, 1);
  assert.equal(manifest.dist.script, "index.js");
  assert.match(manifest.version, /^\d+(\.\d+)*(?:-[a-z0-9]+)?$/);
  assert.ok(manifest.dependencies["revenge.api"]);
  assert.ok(manifest.dependencies.discord);
});

test("exports a plugin with settings and lifecycle cleanup", () => {
  assert.match(source, /export default plugin</);
  assert.match(source, /jsonStorage:\s*\{/);
  assert.match(source, /SettingsComponent/);
  assert.match(source, /return stopPlugin/);
  assert.match(source, /unpatches\.splice\(0\)\.reverse\(\)/);
});

test("provides follow and unfollow actions without profile-menu patches", () => {
  assert.match(source, /\["vcf",\s*"Follow a user voice channel by Discord user ID"/);
  assert.match(source, /\["vcunf",\s*"Stop following the current user"/);
  assert.match(source, /function registerCommands\(/);
  assert.match(source, /function followUser\(/);
  assert.match(source, /function stopFollowing\(/);
  assert.match(source, /function onVoiceUpdate\(/);
  assert.doesNotMatch(source, /function patchMenu\(/);
  assert.doesNotMatch(source, /vc-follow-profile/);
  assert.match(source, /selectVoiceChannel/);
  assert.match(source, /\d\{15,22\}/);
});

test("deployment builds the actual CLI output and packages a Next repository", () => {
  assert.match(deploy, /pnpm run build/);
  assert.match(deploy, /plugins\/vc-follow\/build\/js\/index\.js/);
  assert.match(deploy, /revenge-plugin generate-index/);
  assert.match(deploy, /dist\/index\.json/);
  assert.doesNotMatch(deploy, /node build\.cjs/);
  assert.match(readme, /native Revenge Next plugin system/);
  assert.match(readme, /index\.json/);
});
