const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../dist/vc-follow/index.js'), 'utf8');
const TARGET = '123456789012345678';
const ME = '987654321098765432';
const OTHER = '111111111111111111';

function environment() {
  const channels = {
    origin: {id:'origin', guild_id:'g1'},
    next: {id:'next', guild_id:'g1'},
    next2: {id:'next2',guild_id:'g1'},
    locked: {id:'locked',guild_id:'g1', locked:true},
    outside: {id:'outside',guild_id:'g2'},
  };
  const moves = []; const commands = {}; const events = new Map();
  const state = {}; let currentChannel = 'origin';
  const storeCallbacks = new Set(); const patches=[];
  const voiceStore = {
    getVoiceStateForUser: id => state[id],
    getVoiceStatesForChannel: id => ({}),
    addChangeListener: cb => {storeCallbacks.add(cb); return () => storeCallbacks.delete(cb);},
    removeChangeListener: cb => storeCallbacks.delete(cb),
  };
  const selectedStore = {getVoiceChannelId:()=>currentChannel};
  const channelStore = {getChannel:id => channels[id]};
  const userStore = {getCurrentUser:()=>({id:ME})};
  const permissionStore = {can:(permission, channel) => !channel.locked};
  const actions = {selectVoiceChannel:id => {moves.push(id); currentChannel=id}};
  const dispatcher = {
    subscribe: (name,cb) => { if (!events.has(name)) events.set(name,new Set()); events.get(name).add(cb); },
    unsubscribe: (name,cb) => events.get(name)?.delete(cb),
    dispatch: (payload) => { for (const cb of events.get(payload.type)??[]) cb(payload); },
  };
  const profileActions = { getUserProfileActions(user) { return [{id:'unrelated'}]; } };
  const modules = [voiceStore,selectedStore,channelStore,userStore,permissionStore,actions,dispatcher,profileActions];
  const storage = {};
  const vendetta = {
    logger: {log() {}},
    metro: {
      findByProps: (...props) => modules.find(mod => props.every(prop => typeof mod[prop] !== 'undefined')),
      findByName: () => null,
      common: {React: {createElement: () => null, useState: init => [init,()=>{}]},ReactNative: {}},
    },
    commands: {registerCommand: command => {commands[command.name]=command;return()=>delete commands[command.name];}},
    plugin: {storage},
    patcher: {after: (key, module, callback) => {
      const old = module[key];
      module[key] = (...args) => callback(args,old(...args));
      patches.push(()=>{module[key] = old;});
      return patches.at(-1);
    }},
    storage: {useProxy: () => {}},
  };
  const result = new Function('vendetta','return ' + source)(vendetta);
  const plugin = result.default;
  return {plugin,storage,commands,moves,events,storeCallbacks,
    emit: (userId, channelId, oldChannelId) => {
      state[userId] = {userId,channelId,oldChannelId};
      dispatcher.dispatch({type:'VOICE_STATE_UPDATES', voiceStates:[{userId,channelId,oldChannelId}]});
      for (const cb of [...storeCallbacks]) cb();
    },
    setCurrentChannel: id => {currentChannel=id;},
    patchCount: ()=>patches.length,
  };
}
test('registers /vcf and /vcunf; follows transitions in same guild', () => {
  const m = environment(); m.plugin.onLoad();
  assert.ok(m.commands.vcf); assert.ok(m.commands.vcunf);
  assert.equal(m.commands.vcf.execute([{name:'userid',value:TARGET}]).send,false);
  assert.equal(m.storage.targetUserId,TARGET);
  m.emit(TARGET,'next','origin');
  assert.deepEqual(m.moves,['next']);
  m.emit(TARGET,'next','next');
  assert.deepEqual(m.moves,['next']);
  m.emit(TARGET,'next2','next');
  assert.deepEqual(m.moves,['next','next2']);
  m.commands.vcunf.execute([]);
  assert.equal(m.storage.enabled,false);
  m.emit(TARGET,'origin','next2');
  assert.deepEqual(m.moves,['next','next2']);
  m.plugin.onUnload();
  assert.equal(m.commands.vcf,undefined);
  assert.equal(m.events.get('VOICE_STATE_UPDATES').size,0);
  assert.equal(m.storeCallbacks.size,0);
});
test('ignores other users and locked channels, but follows across servers', () => {
  const m=environment();m.plugin.onLoad();
  m.commands.vcf.execute([{name:'userid',value:TARGET}]);
  m.emit(OTHER,'next','origin');
  m.emit(TARGET,'locked','origin');
  m.emit(TARGET,'outside','locked');
  assert.deepEqual(m.moves,['outside']);
  m.plugin.onUnload();
});
test('friend leaving voice does not disconnect us; following stays enabled', () => {
  const m=environment();m.plugin.onLoad();
  m.commands.vcf.execute([{name:'userid',value:TARGET}]);
  m.emit(TARGET,'next','origin');
  assert.deepEqual(m.moves,['next']);
  m.emit(TARGET,null,'next');
  assert.deepEqual(m.moves,['next']);
  assert.equal(m.storage.enabled,true);
  m.emit(TARGET,'next2',null);
  assert.deepEqual(m.moves,['next','next2']);
  m.plugin.onUnload();
});
test('rejects invalid targets and can follow when not already in voice', () => {
  const m=environment();m.plugin.onLoad();
  const invalid=m.commands.vcf.execute([{name:'userid',value:'oops'}]);
  assert.match(invalid.result,/valid Discord user ID/);
  m.commands.vcf.execute([{name:'userid',value:TARGET}]);
  m.setCurrentChannel(null);
  m.emit(TARGET,'next','origin');
  assert.deepEqual(m.moves,['next']);
  m.plugin.onUnload();
});

test('re-follows target when user manually leaves or switches VC', () => {
  const m=environment();m.plugin.onLoad();
  m.commands.vcf.execute([{name:'userid',value:TARGET}]);
  m.emit(TARGET,'next','origin');
  assert.deepEqual(m.moves,['next']);

  // The target stays in "next", while the user leaves for "next2".
  m.setCurrentChannel('next2');
  for (const cb of [...m.storeCallbacks]) cb();
  assert.deepEqual(m.moves,['next','next']);

  // Explicit unfollow must stop automatic re-following.
  m.commands.vcunf.execute([]);
  m.setCurrentChannel('next2');
  for (const cb of [...m.storeCallbacks]) cb();
  assert.deepEqual(m.moves,['next','next']);
  m.plugin.onUnload();
});
