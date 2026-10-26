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
  assert.ok(!source.includes("@vendetta/"));
  assert.ok(source.includes("@revenge-mod/modules/finders"));
});

test("has a valid native Revenge Next manifest", () => {
  assert.equal(manifest.format, 1);
  assert.equal(manifest.dist.script, "index.js");
  assert.match(manifest.version, /^\d+(\.\d+)*(?:-[a-z0-9]+)?$/);
  assert.ok(manifest.dependencies["revenge.api"]);
  assert.ok(manifest.dependencies.discord);
});

test("implements profile follow toggle and removes slash-command registration", () => {
  assert.ok(source.includes("function patchProfileMenus("));
  assert.ok(source.includes("function profileButton("));
  assert.ok(source.includes("Follow this user"));
  assert.ok(source.includes("Stop following"));
  assert.ok(source.includes("apiRef?.unscoped?.patcher"));
  assert.ok(!source.includes("function registerCommands("));
  assert.ok(!source.includes("registerCommand"));
});

test("follows target voice changes and retries pending full channels", () => {
  assert.ok(source.includes("function onVoiceUpdate("));
  assert.ok(source.includes("function onVoiceStoreChanged("));
  assert.ok(source.includes("pendingChannel"));
  assert.ok(source.includes("capacity freed"));
  assert.ok(source.includes("selectVoiceChannel"));
  assert.ok(source.includes("lastAttemptChannel = null"));
  assert.ok(source.includes("function stopFollowing("));
});

test("persists follow state and documents fallback behavior", () => {
  assert.ok(source.includes("jsonStorage"));
  assert.ok(source.includes("targetUserId"));
  assert.ok(readme.includes("Stop following username"));
  assert.ok(readme.includes("settings fallback"));
  assert.ok(deploy.includes("pnpm run build"));
  assert.ok(deploy.includes("revenge-plugin generate-index"));
});
