/**
 * VC Follow — Revenge plugin (Vendetta-compatible)
 * Follows a friend between voice channels, including across servers.
 * Adds "Follow this user" to the user context menu.
 *
 * Author: Li Fawaz
 */
import { logger }                            from "@vendetta";
import { findByProps, findByName }           from "@vendetta/metro";
import { React, ReactNative }                from "@vendetta/metro/common";
import { after }                             from "@vendetta/patcher";
import { registerCommand }                   from "@vendetta/commands";
import { storage }                           from "@vendetta/plugin";
import Settings                              from "./Settings";

type VoiceState = {
    userId?: string; user_id?: string;
    channelId?: string | null; channel_id?: string | null;
    oldChannelId?: string | null; old_channel_id?: string | null;
    guildId?: string; guild_id?: string;
    selfMute?: boolean; self_mute?: boolean;
    selfDeaf?: boolean; self_deaf?: boolean;
    mute?: boolean; deaf?: boolean;
    serverMute?: boolean; server_mute?: boolean;
    serverDeaf?: boolean; server_deaf?: boolean;
};

const CONNECT = 1048576n;
const MOVE_MEMBERS = 16777216n;
const MUTE_MEMBERS = 4194304n;
const DEAFEN_MEMBERS = 8388608n;
const UNSET = "";
let lastRecoveryKey = "";
const disposers: Array<() => void> = [];
const moduleCache: Map<string, any> = new Map();
let running = false;
let lastSeenTargetChannel: string | null = null;
let lastAttemptChannel: string | null = null;
let lastAttemptAt = 0;
let pendingFollowDest: string | null = null;
let followHold = false;
let manualDisconnect = false;

function log(msg: string): void { try { logger.log(`[VC Follow] ${msg}`); } catch (_) {} }
function setStatus(msg: string): void { storage.status = msg; log(msg); }

function probe(label: string, options: string[][]): any {
    if (moduleCache.has(label)) return moduleCache.get(label);
    for (const keys of options) {
        try { const m = findByProps(...keys); if (m) { moduleCache.set(label, m); return m; } } catch (_) {}
    }
    log(`${label}: not found on this build`);
    return null;
}
function probeByName(name: string): any {
    if (moduleCache.has(name)) return moduleCache.get(name);
    try { const m = findByName(name, false); if (m) { moduleCache.set(name, m); return m; } } catch (_) {}
    return null;
}
function voiceStore(): any {
    return probe("VoiceStateStore", [["getVoiceStateForUser", "getVoiceStatesForChannel"], ["getVoiceStateForUser"], ["getAllVoiceStates"]]);
}
function channelStore(): any { return probe("ChannelStore", [["getChannel"]]); }
function userStore(): any { return probe("UserStore", [["getCurrentUser"]]); }
function permStore(): any { return probe("PermissionStore", [["can"]]); }
function voiceActions(): any { return probe("VoiceActions", [["selectVoiceChannel", "disconnect"], ["selectVoiceChannel"]]); }
function recoverOwnServerRestrictions(state: VoiceState): void {
    if (!running || storage.monitorServerRestrictions !== true) return;
    const id = ownId();
    if (!id || String(state.userId ?? state.user_id ?? state.user?.id ?? "") !== id) return;
    const channelId = state.channelId ?? state.channel_id ?? getOwnVoiceChannel();
    if (!channelId) return;

    const serverMuted = !!(state.serverMute ?? state.server_mute ?? state.mute);
    const serverDeafened = !!(state.serverDeaf ?? state.server_deaf ?? state.deaf);
    if (!serverMuted && !serverDeafened) {
        lastRecoveryKey = "";
        return;
    }

    const channel = channelStore()?.getChannel?.(channelId);
    if (!channel) {
        setStatus("Restriction monitor: server mute/deafen detected; channel permissions could not be verified");
        return;
    }
    const allowedMute = !serverMuted || can(channel, MUTE_MEMBERS);
    const allowedDeaf = !serverDeafened || can(channel, DEAFEN_MEMBERS);
    const key = [channelId, serverMuted ? "m" : "", serverDeafened ? "d" : "", allowedMute ? "M" : "", allowedDeaf ? "D" : ""].join(":");
    if (key === lastRecoveryKey) return;
    lastRecoveryKey = key;

    const detected = [serverMuted ? "server-muted" : "", serverDeafened ? "server-deafened" : ""].filter(Boolean).join(" and ");
    const permissions = [
        serverMuted ? (allowedMute ? "Mute Members permission present" : "Mute Members permission missing") : "",
        serverDeafened ? (allowedDeaf ? "Deafen Members permission present" : "Deafen Members permission missing") : "",
    ].filter(Boolean).join("; ");
    setStatus(`Restriction monitor: detected ${detected}. ${permissions}. No moderation action was sent.`);
}
function getOwnVoiceChannel(): string | null {
    const s = probe("SelectedChannelStore", [["getVoiceChannelId"], ["getCurrentVoiceChannelId"], ["getSelectedVoiceChannelId"]]);
    try { return s?.getVoiceChannelId?.() ?? s?.getCurrentVoiceChannelId?.() ?? s?.getSelectedVoiceChannelId?.() ?? null; } catch (_) { return null; }
}
function getUserVoiceChannel(userId: string): string | null {
    const s = voiceStore();
    if (!s) return null;
    try {
        const direct = s.getVoiceStateForUser?.(userId);
        if (direct) return direct.channelId ?? direct.channel_id ?? null;
        const all = s.getAllVoiceStates?.();
        if (all && typeof all === "object") {
            for (const group of Object.values(all) as any[]) {
                const state = group?.[userId];
                if (state) return state.channelId ?? state.channel_id ?? null;
            }
        }
    } catch (_) {}
    return null;
}
function ownId(): string | null { try { return userStore()?.getCurrentUser?.()?.id ?? null; } catch (_) { return null; } }
function normalizeUserId(raw: unknown): string | null {
    const s = String(raw ?? "").trim();
    const m = /^(?:<@!?)?(\d{15,22})>?$/.exec(s);
    return m?.[1] ?? null;
}
function can(channel: any, permission: bigint): boolean {
    const s = permStore();
    if (!s || typeof s.can !== "function") return false;
    try { return !!s.can(permission, channel); } catch (_) { try { return !!s.can(permission.toString(), channel); } catch (_) { return false; } }
}
function channelHasSpace(channel: any, channelId: string): boolean {
    const limit = Number(channel.userLimit ?? channel.user_limit ?? 0);
    if (!Number.isFinite(limit) || limit <= 0) return true;
    try {
        const states = voiceStore()?.getVoiceStatesForChannel?.(channelId);
        if (!states || typeof states !== "object") return true;
        return Object.keys(states).length < limit || can(channel, MOVE_MEMBERS);
    } catch (_) { return true; }
}
function tryMoveTo(destinationId: string, source: string): void {
    if (!running || !storage.enabled || !storage.targetUserId || !destinationId) return;
    const myChannelId = getOwnVoiceChannel();
    if (myChannelId && destinationId === myChannelId) { pendingFollowDest = null; setStatus("Already in the same VC"); return; }
    if (lastAttemptChannel === destinationId && Date.now() - lastAttemptAt < 2500) return;
    const dest = channelStore()?.getChannel?.(destinationId);
    if (dest) {
        if (!can(dest, CONNECT)) { pendingFollowDest = null; setStatus("Can't follow: no permission to join that voice channel"); return; }
        if (!channelHasSpace(dest, destinationId)) {
            pendingFollowDest = destinationId;
            setStatus(`Voice channel is full — waiting for a slot or for ${storage.targetUserId} to move`);
            return;
        }
    }
    const actions = voiceActions();
    if (typeof actions?.selectVoiceChannel !== "function") { setStatus("Voice switching unavailable on this Discord build"); return; }
    pendingFollowDest = null; lastAttemptChannel = destinationId; lastAttemptAt = Date.now();
    try { actions.selectVoiceChannel(destinationId); setStatus(`Following ${storage.targetUserId}: joined VC (${source}) [${dest?.guild_id ?? "cross-server"}]`); }
    catch (err) { setStatus(`VC join failed: ${String(err)}`); }
}
function maybeFollowState(state: VoiceState): void {
    if (!running || !storage.enabled || !storage.targetUserId) return;
    const userId = String(state.userId ?? state.user_id ?? "");
    if (userId !== String(storage.targetUserId)) return;
    const destination = state.channelId ?? state.channel_id ?? null;
    const previous = state.oldChannelId ?? state.old_channel_id ?? lastSeenTargetChannel;
    if (destination === previous || destination === lastSeenTargetChannel) return;
    lastSeenTargetChannel = destination;
    if (!destination) { setStatus("Friend left voice — will follow when they rejoin a VC"); return; }
    tryMoveTo(destination, "voice event");
}
function onVoiceEvent(payload: any): void {
    if (!running || !payload) return;
    const updates: any[] = payload.voiceStates ?? payload.voice_states ?? (payload.voiceState ? [payload.voiceState] : [payload]);
    if (!Array.isArray(updates)) return;
    for (const state of updates) {
        if (!state) continue;
        const userId = String(state.userId ?? state.user_id ?? state.user?.id ?? "");
        if (userId && userId === ownId()) {
            recoverOwnServerRestrictions(state);
            const channel = state.channelId ?? state.channel_id ?? null;
            if (!channel && storage.enabled && storage.targetUserId) {
                if (manualDisconnect) {
                    followHold = true;
                    setStatus("Follow on hold — manual disconnect");
                } else {
                    const target = getUserVoiceChannel(String(storage.targetUserId));
                    if (target) tryMoveTo(target, "reconnect after external disconnect");
                }
            } else if (channel && followHold) {
                followHold = false;
                manualDisconnect = false;
                const target = getUserVoiceChannel(String(storage.targetUserId ?? ""));
                if (storage.enabled && target && channel !== target) tryMoveTo(target, "resume after manual VC join");
            }
        }
        maybeFollowState(state);
    }
    if (pendingFollowDest && running && storage.enabled) {
        const dest = channelStore()?.getChannel?.(pendingFollowDest);
        if (dest && channelHasSpace(dest, pendingFollowDest)) tryMoveTo(pendingFollowDest, "capacity freed");
    }
}
function onVoiceStoreChanged(): void {
    if (!running || !storage.enabled || !storage.targetUserId) return;
    if (followHold) {
        const mine = getOwnVoiceChannel();
        if (!mine) return;
        followHold = false;
        manualDisconnect = false;
    }
    const current = getUserVoiceChannel(storage.targetUserId);
    if (current !== lastSeenTargetChannel) {
        lastSeenTargetChannel = current;
        if (current) tryMoveTo(current, "store change");
        return;
    }
    // The target may not have moved at all: the user can disconnect or manually
    // enter another VC. Keep follow mode active and bring them back to the target.
    if (current) {
        const mine = getOwnVoiceChannel();
        if (mine !== current) {
            // A previous join attempt may have targeted this same channel; a new
            // user-initiated move is a fresh reason to retry immediately.
            lastAttemptChannel = null;
            tryMoveTo(current, "re-follow after own VC change");
        }
    }
}
export function followUser(idOrMention: unknown): string {
    const id = normalizeUserId(idOrMention);
    if (!id) return "Provide a valid Discord user ID (17–22 digits).";
    if (id === ownId()) return "You can't follow yourself.";
    storage.targetUserId = id; storage.enabled = true; followHold = false; manualDisconnect = false; pendingFollowDest = null;
    lastSeenTargetChannel = getUserVoiceChannel(id); lastAttemptChannel = null;
    setStatus(`Following ${id} — waiting for a VC move`);
    if (lastSeenTargetChannel) tryMoveTo(lastSeenTargetChannel, "start");
    return `VC Follow ON for ${id}`;
}
export function stopFollowing(): string {
    storage.enabled = false; storage.targetUserId = UNSET; followHold = false; manualDisconnect = false; pendingFollowDest = null;
    lastSeenTargetChannel = null; lastAttemptChannel = null; setStatus("Not following");
    return "VC Follow OFF";
}
function watchManualDisconnect(): void {
    const actions = voiceActions();
    if (!actions) return;
    // Discord clients commonly disconnect by calling selectVoiceChannel(null),
    // not a dedicated disconnect() action. Watch both API shapes.
    for (const name of ["disconnect", "selectVoiceChannel"]) {
        const original = actions[name];
        if (typeof original !== "function") continue;
        const wrapped = function(this: any, ...args: any[]) {
            const isDisconnect = name === "disconnect" || (name === "selectVoiceChannel" && (args[0] == null || args[0] === ""));
            if (isDisconnect && running && storage.enabled && storage.targetUserId) {
                manualDisconnect = true;
                followHold = true;
                setStatus("Follow on hold — manual disconnect");
            }
            return original.apply(this, args);
        };
        try {
            actions[name] = wrapped;
            disposers.push(() => { if (actions[name] === wrapped) actions[name] = original; });
        } catch (_) {}
    }
}
function startListening(): void {
    watchManualDisconnect();
    const flux = probe("Flux", [["dispatch", "subscribe", "unsubscribe"], ["subscribe", "unsubscribe"]]);
    if (flux && typeof flux.subscribe === "function") {
        for (const event of ["VOICE_STATE_UPDATES", "VOICE_STATE_UPDATE"]) {
            try { flux.subscribe(event, onVoiceEvent); disposers.push(() => flux.unsubscribe?.(event, onVoiceEvent)); log(`Subscribed to ${event}`); }
            catch (err) { log(`Subscribe ${event} failed: ${String(err)}`); }
        }
    }
    const store = voiceStore();
    if (typeof store?.addChangeListener === "function") {
        try {
            const unreg = store.addChangeListener(onVoiceStoreChanged);
            disposers.push(typeof unreg === "function" ? unreg : () => store.removeChangeListener?.(onVoiceStoreChanged));
            log("Subscribed to VoiceStateStore changes");
        } catch (_) {}
    }
    if (disposers.length === 0) setStatus("Voice listeners unavailable on this build");
}
function buildFollowEntry(userId: string): any {
    const onPress = () => { const result = followUser(userId); log(`Profile btn: ${result}`); };
    const rowMod = probe("ActionSheetRow", [["ActionSheetRow", "ActionSheetSection"], ["ActionSheetRow"]]);
    const ActionSheetRow = rowMod?.ActionSheetRow ?? (typeof rowMod?.default === "function" ? rowMod.default : null);
    const R = React as any; const RN = ReactNative as any;
    if (typeof ActionSheetRow === "function") return R.createElement(ActionSheetRow, { key: "vcf-follow", label: "Follow this user", onPress });
    return R.createElement(RN.TouchableOpacity, { key: "vcf-follow", onPress, style: { paddingHorizontal: 16, paddingVertical: 14 } },
        R.createElement(RN.Text, { style: { color: "#FFFFFF", fontSize: 16, fontWeight: "600" } }, "Follow this user"));
}
function injectProfileButton(): void {
    const names = ["GuildMemberUserContextMenu", "UserContextMenu", "NativeUserContextMenu", "UserProfileBottomSheetContextMenu"];
    let patched = 0;
    for (const name of names) {
        const mod = probeByName(name); if (!mod) continue;
        const key = typeof mod.default === "function" ? "default" : (Object.keys(mod).find(k => typeof mod[k] === "function") ?? "default");
        try {
            const unpatch = after(key, mod, (args: any[], res: any) => {
                if (!res?.props) return;
                const userId: string | undefined = args[0]?.userId ?? args[0]?.user?.id ?? args[0]?.member?.userId;
                if (!userId || userId === ownId()) return;
                const entry = buildFollowEntry(userId); const ch = res.props.children;
                res.props.children = Array.isArray(ch) ? [...ch, entry] : ch != null ? [ch, entry] : [entry];
            });
            if (typeof unpatch === "function") disposers.push(unpatch);
            log(`Profile button: patched ${name}`); patched++;
        } catch (err) { log(`Profile button: patch failed for ${name}: ${String(err)}`); }
    }
    if (patched === 0) log("Profile button: no context menu component found on this build");
}
function readCommandUser(args: any): unknown {
    const item = Array.isArray(args) ? (args.find((a: any) => a?.name === "userid") ?? args[0]) : args;
    return item?.value?.id ?? item?.value ?? item?.user?.id ?? item?.id ?? item;
}
function registerCommands(): void {
    const commands: Array<[string, string, any[], (args: any) => string]> = [
        ["vcf", "Follow a friend to their voice channel (works cross-server)", [{ name: "userid", displayName: "userid", description: "User ID to follow (17–22 digit number)", displayDescription: "User ID to follow (17–22 digit number)", type: 3, required: true }], args => String(followUser(readCommandUser(args)))],
        ["vcunf", "Stop following voice channels", [], () => stopFollowing()],
    ];
    for (const [name, description, options, handler] of commands) {
        try {
            const unreg = registerCommand({ name, displayName: name, description, displayDescription: description, options, applicationId: "-1", inputType: 1, type: 1, execute: (args: any) => ({ send: false, result: handler(args) }) } as any);
            if (typeof unreg === "function") disposers.push(unreg);
            log(`Registered /${name}`);
        } catch (err) { log(`Register /${name} failed: ${String(err)}`); }
    }
}
export default {
    onLoad() {
        storage.enabled ??= false; storage.targetUserId ??= UNSET; storage.status ??= "Not following";
        storage.monitorServerRestrictions ??= false;
        lastRecoveryKey = "";
        running = true; pendingFollowDest = null; followHold = false; manualDisconnect = false; moduleCache.clear();
        lastSeenTargetChannel = storage.enabled && storage.targetUserId ? getUserVoiceChannel(storage.targetUserId) : null;
        startListening(); injectProfileButton(); registerCommands(); log("Loaded.");
    },
    onUnload() {
        running = false; pendingFollowDest = null; followHold = false; manualDisconnect = false;
        for (const dispose of disposers.splice(0).reverse()) { try { dispose(); } catch (err) { log(`Cleanup: ${String(err)}`); } }
        moduleCache.clear(); log("Unloaded.");
    },
    settings: Settings,
};
