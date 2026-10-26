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
  assert.doesNotMatch(source, /@vendetta\\//);
  assert.match(source, /@revenge-mod\\/modules\\/finders/);
});

test("has a valid native Revenge Next manifest", () => {
  assert.equal(manifest.format, 1);
  assert.equal(manifest.dist.script, "index.js");
  assert.match(manifest.version, /^\\d+(\\.\\d+)*(?:-[a-z0-9]+)?$/);
  assert.ok(manifest.dependencies["revenge.api"]);
  assert.ok(manifest.dependencies.discord);
});

test("implements profile follow toggle and removes slash-command registration", () => {
  assert.match(source, /function patchProfileMenus\\(/);
  assert.match(source, /function profileButton\\(/);
  assert.match(source, /Follow this user/);
  assert.match(source, /Stop following \\u?\\$\\{username/);
  assert.match(source, /apiRef\\?\\.unscoped\\?\\.patcher/);
  assert.doesNotMatch(source, /function registerCommands\\(/);
  assert.doesNotMatch(source, /registerCommand/);
});

test("follows target voice changes and retries pending full channels", () => {
  assert.match(source, /function onVoiceUpdate\\(/);
  assert.match(source, /function onVoiceStoreChanged\\(/);
  assert.match(source, /pendingChannel/);
  assert.match(source, /capacity freed/);
  assert.match(source, /selectVoiceChannel/);
  assert.match(source, /lastAttemptChannel = null/);
  assert.match(source, /function stopFollowing\\(/);
});

test("persists follow state and documents fallback behavior", () => {
  assert.match(source, /jsonStorage/);
  assert.match(source, /targetUserId/);
  assert.match(readme, /Stop following username/);
  assert.match(readme, /settings fallback/);
  assert.match(deploy, /pnpm run build/);
  assert.match(deploy, /revenge-plugin generate-index/);
});
