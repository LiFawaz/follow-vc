/**
 * VC Follow for the Vendetta-compatible Revenge plugin loader.
 * Replaces FakeDeafen's gateway mutation with safe voice-state observation.
 * No messages, tokens or credentials are accessed or sent anywhere.
 */
import { logger } from "@vendetta";
import { findByProps } from "@vendetta/metro";
import { registerCommand } from "@vendetta/commands";
import { storage } from "@vendetta/plugin";
import { after } from "@vendetta/patcher";
import Settings from "./Settings";

type VoiceState = {
    userId?: string; user_id?: string;
    channelId?: string | null; channel_id?: string | null;
    oldChannelId?: string | null; old_channel_id?: string | null;
    guildId?: string; guild_id?: string;
};

const CONNECT = 1048576n;
const MOVE_MEMBERS = 16777216n;
const UNSET = "";
const disposers: Array<() => void> = [];
const moduleCache = new Map<string, any>();
let running = false;
let lastSeenTargetChannel: string | null = null;
let lastAttemptChannel: string | null = null;
let lastAttemptAt = 0;

function log(message: string) {
    try { logger.log(`[VC Follow] ${message}`); } catch (_) { /* ignore logging issues */ }
}
function setStatus(message: string) { storage.status = message; log(message); }
function probe(label: string, options: string[][]): any {
    if (moduleCache.has(label)) return moduleCache.get(label);
    for (const keys of options) {
        try {
            const mod = findByProps(...keys);
            if (mod) { moduleCache.set(label, mod); log(`${label}: found [${keys.join(', ')}]`); return mod; }
        } catch (_) { /* Discord modules change across builds */ }
    }
    log(`${label}: unavailable`);
    return null;
}
function voiceStore(): any {
    return probe("VoiceStateStore", [
        ["getVoiceStateForUser", "getVoiceStatesForChannel"],
        ["getVoiceStateForUser"], ["getAllVoiceStates"],
    ]);
}
function selectedVoiceStore(): any {
    return probe("SelectedChannelStore", [
        ["getVoiceChannelId"], ["getCurrentVoiceChannelId"], ["getSelectedVoiceChannelId"],
    ]);
}
function channelStore(): any { return probe("ChannelStore", [["getChannel"]]); }
function userStore(): any { return probe("UserStore", [["getCurrentUser"]]); }
function permissionsStore(): any { return probe("PermissionStore", [["can"]]); }
function voiceActions(): any {
    return probe("Voice actions", [["selectVoiceChannel", "disconnect"], ["selectVoiceChannel"]]);
}
function getOwnVoiceChannel(): string | null {
    const store = selectedVoiceStore();
    try { return store?.getVoiceChannelId?.() ?? store?.getCurrentVoiceChannelId?.() ?? store?.getSelectedVoiceChannelId?.() ?? null; }
    catch (_) { return null; }
}
function getUserVoiceChannel(userId: string): string | null {
    const store = voiceStore();
    if (!store) return null;
    try {
        const direct = store.getVoiceStateForUser?.(userId);
        if (direct) return direct.channelId ?? direct.channel_id ?? null;
        const groups = store.getAllVoiceStates?.();
        if (groups && typeof groups === 'object') {
            for (const group of Object.values(groups) as any[]) {
                const state = group?.[userId];
                if (state) return state.channelId ?? state.channel_id ?? null;
            }
        }
    } catch (_) { /* ignore incomplete stores */ }
    return null;
}
function ownId(): string | null {
    try { return userStore()?.getCurrentUser?.()?.id ?? null; }
    catch (_) { return null; }
}
function normalizeUserId(value: unknown): string | null {
    const raw = String(value ?? '').trim();
    const match = /^(?:<@!?)?(\d{15,22})>?$/.exec(raw);
    return match?.[1] ?? null;
}
function can(channel: any, permission: bigint): boolean {
    const store = permissionsStore();
    if (!store || typeof store.can !== 'function') return false;
    try { return !!store.can(permission, channel); }
    catch (_) {
        try { return !!store.can(permission.toString(), channel); }
        catch (_) { return false; }
    }
}
function channelCapacityAvailable(channel: any, destId: string): boolean {
    const limit = Number(channel.userLimit ?? channel.user_limit ?? 0);
    if (!Number.isFinite(limit) || limit <= 0) return true;
    try {
        const states = voiceStore()?.getVoiceStatesForChannel?.(destId);
        if (!states || typeof states !== 'object') return true; // server enforces limits
        return Object.keys(states).length < limit || can(channel, MOVE_MEMBERS);
    } catch (_) { return true; }
}
function tryMoveTo(destinationId: string, source: string): void {
    if (!running || !storage.enabled || !storage.targetUserId || !destinationId) return;
    const myChannelId = getOwnVoiceChannel();
    if (!myChannelId) { setStatus('Not connected: join a VC first'); return; }
    if (destinationId === myChannelId) { setStatus('Already in the same VC'); return; }
    const channels = channelStore();
    const mine = channels?.getChannel?.(myChannelId);
    const dest = channels?.getChannel?.(destinationId);
    if (!mine?.guild_id || !dest?.guild_id || mine.guild_id !== dest.guild_id) {
        setStatus('Waiting: friend is in another server or unavailable'); return;
    }
    if (!can(dest, CONNECT)) { setStatus('Cannot join that voice channel (no Connect permission)'); return; }
    if (!channelCapacityAvailable(dest, destinationId)) { setStatus('Cannot join: destination VC is full'); return; }
    if (lastAttemptChannel === destinationId && Date.now() - lastAttemptAt < 2500) return;
    const actions = voiceActions();
    if (typeof actions?.selectVoiceChannel !== 'function') {
        setStatus('Voice switching action unavailable in this Discord build'); return;
    }
    lastAttemptChannel = destinationId;
    lastAttemptAt = Date.now();
    try {
        actions.selectVoiceChannel(destinationId);
        setStatus(`Following ${storage.targetUserId}: switched VC (${source})`);
    } catch (err) { setStatus(`VC switch failed: ${String(err)}`); }
}
function maybeFollowState(state: VoiceState, payloadGuildId?: string) {
    if (!running || !storage.enabled || !storage.targetUserId) return;
    const userId = String(state.userId ?? state.user_id ?? '');
    if (userId !== String(storage.targetUserId)) return;
    const destination = state.channelId ?? state.channel_id ?? null;
    const previous = state.oldChannelId ?? state.old_channel_id ?? lastSeenTargetChannel;
    if (destination === previous || destination === lastSeenTargetChannel) return;
    lastSeenTargetChannel = destination;
    if (!destination) { setStatus('Your friend left VC; following stays enabled'); return; }
    // Never disconnect you when they leave; only move for an actual destination.
    tryMoveTo(destination, 'voice update');
}
function onVoiceEvent(payload: any) {
    if (!running || !payload) return;
    const updates = payload.voiceStates ?? payload.voice_states ??
        (payload.voiceState ? [payload.voiceState] : [payload]);
    if (!Array.isArray(updates)) return;
    for (const state of updates) if (state) maybeFollowState(state, payload.guildId ?? payload.guild_id);
}
function onVoiceStoreChanged() {
    if (!running || !storage.enabled || !storage.targetUserId) return;
    const current = getUserVoiceChannel(storage.targetUserId);
    if (current === lastSeenTargetChannel) return;
    lastSeenTargetChannel = current;
    if (current) tryMoveTo(current, 'voice store');
}
function startListening(): void {
    const dispatcher = probe('Flux dispatcher', [['dispatch', 'subscribe', 'unsubscribe'], ['subscribe', 'unsubscribe']]);
    if (dispatcher && typeof dispatcher.subscribe === 'function') {
        for (const type of ['VOICE_STATE_UPDATES', 'VOICE_STATE_UPDATE']) {
            try {
                dispatcher.subscribe(type, onVoiceEvent);
                disposers.push(() => dispatcher.unsubscribe?.(type, onVoiceEvent));
                log(`Subscribed to ${type}`);
            } catch (err) { log(`Cannot subscribe ${type}: ${String(err)}`); }
        }
    }
    const store = voiceStore();
    if (typeof store?.addChangeListener === 'function') {
        try {
            const unregister = store.addChangeListener(onVoiceStoreChanged);
            disposers.push(typeof unregister === 'function' ? unregister : () => store.removeChangeListener?.(onVoiceStoreChanged));
            log('Subscribed to VoiceStateStore changes');
        } catch (_) { /* optional fallback */ }
    }
    if (disposers.length === 0) setStatus('Voice update listener unavailable on this build');
}
export function followUser(idOrMention: unknown): string {
    const id = normalizeUserId(idOrMention);
    if (!id) return 'Use /vcf @user or enter a valid Discord user ID in plugin settings.';
    if (id === ownId()) return 'You cannot follow yourself.';
    storage.targetUserId = id;
    storage.enabled = true;
    lastSeenTargetChannel = getUserVoiceChannel(id);
    lastAttemptChannel = null;
    setStatus(`Following ${id}; waiting for a VC move`);
    // Follow immediately if both people are already in the same server.
    if (lastSeenTargetChannel) tryMoveTo(lastSeenTargetChannel, 'start');
    return `VC Follow ON for ${id}`;
}
export function stopFollowing(): string {
    storage.enabled = false;
    storage.targetUserId = UNSET;
    lastSeenTargetChannel = null;
    lastAttemptChannel = null;
    setStatus('Not following');
    return 'VC Follow OFF';
}
function readCommandUser(args: any): unknown {
    const item = Array.isArray(args) ? (args.find(a => a?.name === 'user') ?? args[0]) : args;
    return item?.value?.id ?? item?.value ?? item?.user?.id ?? item?.id ?? item;
}
function registerCommands() {
    for (const [name, description, options, handler] of [
        ['vcf', 'Auto-follow a friend between voice channels', [{
            name: 'user', displayName: 'user', description: 'Friend to follow',
            displayDescription: 'Friend to follow', type: 6, required: true,
        }], (args: any) => followUser(readCommandUser(args))],
        ['vcunf', 'Stop automatically following VC', [], () => stopFollowing()],
    ] as const) {
        try {
            const unregister = registerCommand({
                name, displayName: name, description, displayDescription: description,
                options, applicationId: '-1', inputType: 1, type: 1,
                execute: (args: any) => ({ send: false, result: handler(args) }),
            } as any);
            if (typeof unregister === 'function') disposers.push(unregister);
            log(`Registered /${name}`);
        } catch (err) { log(`Could not register /${name}: ${String(err)}`); }
    }
}
function registerProfileButton() {
    // Optional, best-effort. Discord mobile profile action providers are private API.
    const profiles = probe('Profile actions', [
        ['getUserProfileActions'], ['getUserProfileActionItems'], ['getUserProfileMenuItems'],
    ]);
    if (!profiles) return;
    const key = ['getUserProfileActions', 'getUserProfileActionItems', 'getUserProfileMenuItems']
        .find(k => typeof profiles[k] === 'function');
    if (!key) return;
    try {
        const unpatch = after(key, profiles, (args: any[], items: any) => {
            if (!Array.isArray(items)) return items;
            const user = args?.[0]?.user ?? args?.[0];
            const id = normalizeUserId(user?.id ?? args?.[0]?.userId);
            if (!id || id === ownId() || items.some(a => a?.id === 'vc-follow-profile')) return items;
            const followed = storage.enabled && String(storage.targetUserId) === id;
            const action = () => followed ? stopFollowing() : followUser(id);
            return items.concat([{ id: 'vc-follow-profile', label: followed ? 'Unfollow VC' : 'Follow VC',
                text: followed ? 'Unfollow VC' : 'Follow VC', action, onPress: action }]);
        });
        if (typeof unpatch === 'function') disposers.push(unpatch);
        log('Profile actions hook installed (experimental)');
    } catch (err) { log(`Profile hook unavailable: ${String(err)}`); }
}
export default {
    onLoad() {
        storage.enabled ??= false;
        storage.targetUserId ??= UNSET;
        storage.status ??= 'Not following';
        running = true;
        moduleCache.clear();
        lastSeenTargetChannel = storage.enabled && storage.targetUserId
            ? getUserVoiceChannel(storage.targetUserId) : null;
        startListening();
        registerCommands();
        registerProfileButton();
        log('Loaded. VC Follow does not touch gateway mute/deafen packets.');
    },
    onUnload() {
        running = false;
        for (const dispose of disposers.splice(0).reverse()) {
            try { dispose(); } catch (err) { log(`Cleanup warning: ${String(err)}`); }
        }
        moduleCache.clear();
        log('Unloaded and listeners removed');
    },
    settings: Settings,
};
