const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '../dist/vc-follow/index.js'), 'utf8');

function environment() {
  const listeners = new Map();
  const storeCallbacks = new Set();
  const modules = [
    {
      getVoiceStateForUser: () => null,
      getVoiceStatesForChannel: () => ({}),
      addChangeListener: cb => { storeCallbacks.add(cb); return () => storeCallbacks.delete(cb); },
      removeChangeListener: cb => storeCallbacks.delete(cb),
    },
    { getVoiceChannelId: () => null },
    { getChannel: () => null },
    { getCurrentUser: () => ({ id: '987654321098765432' }) },
    { can: () => true },
    { selectVoiceChannel: () => {}, toggleSelfMute: () => {}, toggleSelfDeaf: () => {} },
    {
      subscribe: (name, cb) => {
        if (!listeners.has(name)) listeners.set(name, new Set());
        listeners.get(name).add(cb);
      },
      unsubscribe: (name, cb) => listeners.get(name)?.delete(cb),
      dispatch: () => {},
    },
  ];
  const storage = {};
  const vendetta = {
    logger: { log() {} },
    metro: {
      findByProps: (...props) => modules.find(mod => props.every(prop => typeof mod[prop] !== 'undefined')),
      findByName: () => null,
      common: { React: { createElement: () => null }, ReactNative: {} },
    },
    plugin: { storage },
    patcher: { after: () => () => {} },
    storage: { useProxy: () => {} },
  };
  const plugin = new Function('vendetta', 'return ' + source)(vendetta).default;
  return { plugin, storage, listeners, storeCallbacks };
}

test('loads with following disabled by default and exposes settings', () => {
  const m = environment();
  m.plugin.onLoad();
  assert.equal(m.storage.enabled, false);
  assert.equal(m.storage.monitorServerRestrictions, false);
  assert.equal(typeof m.plugin.settings, 'function');
  assert.ok(m.listeners.get('VOICE_STATE_UPDATES')?.size);
  m.plugin.onUnload();
  assert.equal(m.listeners.get('VOICE_STATE_UPDATES')?.size ?? 0, 0);
  assert.equal(m.storeCallbacks.size, 0);
});

test('unload cleans up listeners and leaves following disabled when unset', () => {
  const m = environment();
  m.plugin.onLoad();
  m.plugin.onUnload();
  assert.equal(m.listeners.get('VOICE_STATE_UPDATE')?.size ?? 0, 0);
  assert.equal(m.storeCallbacks.size, 0);
  assert.equal(m.storage.enabled, false);
});
