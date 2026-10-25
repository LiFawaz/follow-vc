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
 
// ── Types ─────────────────────────────────────────────────────────────────────
 
type VoiceState = {
    userId?: string;        user_id?: string;
    channelId?: string | null;  channel_id?: string | null;
    oldChannelId?: string | null; old_channel_id?: string | null;
    guildId?: string;       guild_id?: string;
};
 
// ── Constants & state ─────────────────────────────────────────────────────────
 
const CONNECT      = 1048576n;
const MOVE_MEMBERS = 16777216n;
const UNSET        = "";
 
const disposers:   Array<() => void> = [];
const moduleCache: Map<string, any>  = new Map();
 
let running              = false;
let lastSeenTargetChannel: string | null = null;
let lastAttemptChannel:    string | null = null;
let lastAttemptAt        = 0;
 
/**
 * Channel we want to join but couldn't because it was full.
 * Re-attempted on every voice state event until someone leaves or the
 * target moves to a different channel.
 */
let pendingFollowDest: string | null = null;
 
// ── Logging ───────────────────────────────────────────────────────────────────
 
function log(msg: string): void {
    try { logger.log(`[VC Follow] ${msg}`); } catch (_) {}
}
 
function setStatus(msg: string): void {
    storage.status = msg;
    log(msg);
}
 
// ── Module resolution ─────────────────────────────────────────────────────────
// Discord's internal module identifiers shift between builds. We try several
// prop sets per module and memoize the first hit.
 
function probe(label: string, options: string[][]): any {
    if (moduleCache.has(label)) return moduleCache.get(label);
    for (const keys of options) {
        try {
            const m = findByProps(...keys);
            if (m) { moduleCache.set(label, m); return m; }
        } catch (_) {}
    }
    log(`${label}: not found on this build`);
    return null;
}
 
function probeByName(name: string): any {
    if (moduleCache.has(name)) return moduleCache.get(name);
    try {
        // false = return the module (not just the default export)
        const m = findByName(name, false);
        if (m) { moduleCache.set(name, m); return m; }
    } catch (_) {}
    return null;
}
 
// ── Store accessors ───────────────────────────────────────────────────────────
 
function voiceStore(): any {
    return probe("VoiceStateStore", [
        ["getVoiceStateForUser", "getVoiceStatesForChannel"],
        ["getVoiceStateForUser"],
        ["getAllVoiceStates"],
    ]);
}
 
function channelStore(): any {
    return probe("ChannelStore", [["getChannel"]]);
}
 
function userStore(): any {
    return probe("UserStore", [["getCurrentUser"]]);
}
 
function permStore(): any {
    return probe("PermissionStore", [["can"]]);
}
 
function voiceActions(): any {
    return probe("VoiceActions", [
        ["selectVoiceChannel", "disconnect"],
        ["selectVoiceChannel"],
    ]);
}
 
function getOwnVoiceChannel(): string | null {
    const s = probe("SelectedChannelStore", [
        ["getVoiceChannelId"],
        ["getCurrentVoiceChannelId"],
        ["getSelectedVoiceChannelId"],
    ]);
    try {
        return s?.getVoiceChannelId?.()
            ?? s?.getCurrentVoiceChannelId?.()
            ?? s?.getSelectedVoiceChannelId?.()
            ?? null;
    } catch (_) { return null; }
}
 
function getUserVoiceChannel(userId: string): string | null {
    const s = voiceStore();
    if (!s) return null;
    try {
        // Fast path: direct lookup by user ID.
        const direct = s.getVoiceStateForUser?.(userId);
        if (direct) return direct.channelId ?? direct.channel_id ?? null;
 
        // Slow path: iterate every guild's voice states (cross-server).
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
 
function ownId(): string | null {
    try { return userStore()?.getCurrentUser?.()?.id ?? null; } catch (_) { return null; }
}
 
function normalizeUserId(raw: unknown): string | null {
    const s = String(raw ?? "").trim();
    const m = /^(?:<@!?)?(\d{15,22})>?$/.exec(s);
    return m?.[1] ?? null;
}
 
// ── Permission / capacity helpers ─────────────────────────────────────────────
 
function can(channel: any, permission: bigint): boolean {
    const s = permStore();
    if (!s || typeof s.can !== "function") return false;
    try { return !!s.can(permission, channel); }
    catch (_) {
        try { return !!s.can(permission.toString(), channel); }
        catch (_) { return false; }
    }
}
 
function channelHasSpace(channel: any, channelId: string): boolean {
    const limit = Number(channel.userLimit ?? channel.user_limit ?? 0);
    if (!Number.isFinite(limit) || limit <= 0) return true; // unlimited
    try {
        const states = voiceStore()?.getVoiceStatesForChannel?.(channelId);
        if (!states || typeof states !== "object") return true;
        return Object.keys(states).length < limit || can(channel, MOVE_MEMBERS);
    } catch (_) { return true; }
}
 
// ── Core join logic ───────────────────────────────────────────────────────────
 
function tryMoveTo(destinationId: string, source: string): void {
    if (!running || !storage.enabled || !storage.targetUserId || !destinationId) return;
 
    const myChannelId = getOwnVoiceChannel();
    if (myChannelId && destinationId === myChannelId) {
        pendingFollowDest = null;
        setStatus("Already in the same VC");
        return;
    }
 
    // Throttle repeated attempts to the same channel within 2.5 s.
    if (lastAttemptChannel === destinationId && Date.now() - lastAttemptAt < 2_500) return;
 
    const dest = channelStore()?.getChannel?.(destinationId);
 
    // Only gate on local permission/capacity data when we have it cached.
    // For cross-server channels the cache may be cold on first follow — attempt
    // the join directly and let Discord's server-side logic respond.
    if (dest) {
        if (!can(dest, CONNECT)) {
            pendingFollowDest = null;
            setStatus("Can't follow: no permission to join that voice channel");
            return;
        }
        if (!channelHasSpace(dest, destinationId)) {
            // Park the destination; onVoiceEvent will retry whenever someone
            // leaves that channel or the target moves somewhere else.
            pendingFollowDest = destinationId;
            setStatus(
                `Voice channel is full — waiting for a slot or for ${storage.targetUserId} to move`
            );
            return;
        }
    }
 
    const actions = voiceActions();
    if (typeof actions?.selectVoiceChannel !== "function") {
        setStatus("Voice switching unavailable on this Discord build");
        return;
    }
 
    pendingFollowDest  = null;
    lastAttemptChannel = destinationId;
    lastAttemptAt      = Date.now();
    try {
        actions.selectVoiceChannel(destinationId);
        const guild = dest?.guild_id ?? "cross-server";
        setStatus(`Following ${storage.targetUserId}: joined VC (${source}) [${guild}]`);
    } catch (err) { setStatus(`VC join failed: ${String(err)}`); }
}
 
// ── Event handlers ────────────────────────────────────────────────────────────
 
function maybeFollowState(state: VoiceState): void {
    if (!running || !storage.enabled || !storage.targetUserId) return;
 
    const userId = String(state.userId ?? state.user_id ?? "");
    if (userId !== String(storage.targetUserId)) return;
 
    const destination = state.channelId ?? state.channel_id ?? null;
    const previous    = state.oldChannelId ?? state.old_channel_id ?? lastSeenTargetChannel;
    if (destination === previous || destination === lastSeenTargetChannel) return;
 
    lastSeenTargetChannel = destination;
    if (!destination) {
        setStatus("Friend left voice — will follow when they rejoin a VC");
        return;
    }
    tryMoveTo(destination, "voice event");
}
 
function onVoiceEvent(payload: any): void {
    if (!running || !payload) return;
 
    const updates: any[] = payload.voiceStates ?? payload.voice_states
        ?? (payload.voiceState ? [payload.voiceState] : [payload]);
    if (!Array.isArray(updates)) return;
 
    // Process target's own movement first.
    for (const state of updates) if (state) maybeFollowState(state);
 
    // If we're queued on a full channel, check whether any of these updates
    // freed a slot (someone left that channel).
    if (pendingFollowDest && running && storage.enabled) {
        const dest = channelStore()?.getChannel?.(pendingFollowDest);
        if (dest && channelHasSpace(dest, pendingFollowDest)) {
            tryMoveTo(pendingFollowDest, "capacity freed");
        }
    }
}
 
function onVoiceStoreChanged(): void {
    if (!running || !storage.enabled || !storage.targetUserId) return;
    const current = getUserVoiceChannel(storage.targetUserId);
    if (current === lastSeenTargetChannel) return;
    lastSeenTargetChannel = current;
    if (current) tryMoveTo(current, "store change");
}
 
// ── Public API ────────────────────────────────────────────────────────────────
 
export function followUser(idOrMention: unknown): string {
    const id = normalizeUserId(idOrMention);
    if (!id) return "Provide a valid Discord user ID (17–22 digits).";
    if (id === ownId()) return "You can't follow yourself.";
 
    storage.targetUserId  = id;
    storage.enabled       = true;
    pendingFollowDest     = null;
    lastSeenTargetChannel = getUserVoiceChannel(id);
    lastAttemptChannel    = null;
    setStatus(`Following ${id} — waiting for a VC move`);
 
    // Follow immediately if they're already in a VC.
    if (lastSeenTargetChannel) tryMoveTo(lastSeenTargetChannel, "start");
    return `VC Follow ON for ${id}`;
}
 
export function stopFollowing(): string {
    storage.enabled      = false;
    storage.targetUserId = UNSET;
    pendingFollowDest    = null;
    lastSeenTargetChannel = null;
    lastAttemptChannel   = null;
    setStatus("Not following");
    return "VC Follow OFF";
}
 
// ── Listener setup ────────────────────────────────────────────────────────────
 
function startListening(): void {
    const flux = probe("Flux", [
        ["dispatch", "subscribe", "unsubscribe"],
        ["subscribe", "unsubscribe"],
    ]);
    if (flux && typeof flux.subscribe === "function") {
        for (const event of ["VOICE_STATE_UPDATES", "VOICE_STATE_UPDATE"]) {
            try {
                flux.subscribe(event, onVoiceEvent);
                disposers.push(() => flux.unsubscribe?.(event, onVoiceEvent));
                log(`Subscribed to ${event}`);
            } catch (err) { log(`Subscribe ${event} failed: ${String(err)}`); }
        }
    }
    const store = voiceStore();
    if (typeof store?.addChangeListener === "function") {
        try {
            const unreg = store.addChangeListener(onVoiceStoreChanged);
            disposers.push(
                typeof unreg === "function"
                    ? unreg
                    : () => store.removeChangeListener?.(onVoiceStoreChanged)
            );
            log("Subscribed to VoiceStateStore changes");
        } catch (_) {}
    }
    if (disposers.length === 0) setStatus("Voice listeners unavailable on this build");
}
 
// ── Profile context-menu button ───────────────────────────────────────────────
// Injects a "Follow this user" entry into the user context menu that
// Discord shows when you long-press on a username in chat or the member list.
 
function buildFollowEntry(userId: string): any {
    const onPress = () => {
        const result = followUser(userId);
        log(`Profile btn: ${result}`);
    };
 
    // Prefer Discord's native ActionSheetRow for consistent styling.
    const rowMod = probe("ActionSheetRow", [
        ["ActionSheetRow", "ActionSheetSection"],
        ["ActionSheetRow"],
    ]);
    const ActionSheetRow =
        rowMod?.ActionSheetRow
        ?? (typeof rowMod?.default === "function" ? rowMod.default : null);
 
    const R  = React        as any;
    const RN = ReactNative  as any;
 
    if (typeof ActionSheetRow === "function") {
        return R.createElement(ActionSheetRow, {
            key:     "vcf-follow",
            label:   "Follow this user",
            onPress,
        });
    }
 
    // Fallback: plain styled row that matches Discord's dark theme.
    return R.createElement(
        RN.TouchableOpacity,
        {
            key:   "vcf-follow",
            onPress,
            style: { paddingHorizontal: 16, paddingVertical: 14 },
        },
        R.createElement(
            RN.Text,
            { style: { color: "#FFFFFF", fontSize: 16, fontWeight: "600" } },
            "🔔  Follow this user",
        ),
    );
}
 
function injectProfileButton(): void {
    // Discord Android component names used for user context menus across
    // builds that Revenge targets. We probe all of them; whichever exist
    // on this build get patched.
    const names = [
        "GuildMemberUserContextMenu",
        "UserContextMenu",
        "NativeUserContextMenu",
        "UserProfileBottomSheetContextMenu",
    ];
 
    let patched = 0;
    for (const name of names) {
        const mod = probeByName(name);
        if (!mod) continue;
 
        // Find the callable export — prefer .default, fall back to the first function.
        const key = typeof mod.default === "function"
            ? "default"
            : (Object.keys(mod).find(k => typeof mod[k] === "function") ?? "default");
 
        try {
            const unpatch = after(key, mod, (args: any[], res: any) => {
                if (!res?.props) return;
 
                const userId: string | undefined =
                    args[0]?.userId   ??
                    args[0]?.user?.id ??
                    args[0]?.member?.userId;
                if (!userId || userId === ownId()) return;
 
                const entry = buildFollowEntry(userId);
                const ch    = res.props.children;
                // Spread into a new array so we never mutate a frozen tree.
                res.props.children = Array.isArray(ch)
                    ? [...ch, entry]
                    : ch != null ? [ch, entry] : [entry];
            });
            if (typeof unpatch === "function") disposers.push(unpatch);
            log(`Profile button: patched ${name}`);
            patched++;
        } catch (err) { log(`Profile button: patch failed for ${name}: ${String(err)}`); }
    }
    if (patched === 0) log("Profile button: no context menu component found on this build");
}
 
// ── Slash commands ────────────────────────────────────────────────────────────
 
function readCommandUser(args: any): unknown {
    const item = Array.isArray(args)
        ? (args.find((a: any) => a?.name === "userid") ?? args[0])
        : args;
    return item?.value?.id ?? item?.value ?? item?.user?.id ?? item?.id ?? item;
}
 
function registerCommands(): void {
    const commands: Array<[string, string, any[], (args: any) => string]> = [
        [
            "vcf",
            "Follow a friend to their voice channel (works cross-server)",
            [{
                name:                "userid",
                displayName:         "userid",
                description:         "User ID to follow (17–22 digit number)",
                displayDescription:  "User ID to follow (17–22 digit number)",
                type:                3,      // STRING — paste the user ID directly
                required:            true,
            }],
            (args) => String(followUser(readCommandUser(args))),
        ],
        [
            "vcunf",
            "Stop following voice channels",
            [],
            () => stopFollowing(),
        ],
    ];
 
    for (const [name, description, options, handler] of commands) {
        try {
            const unreg = registerCommand({
                name,             displayName:        name,
                description,      displayDescription:  description,
                options,
                applicationId: "-1",
                inputType:      1,
                type:           1,
                execute: (args: any) => ({ send: false, result: handler(args) }),
            } as any);
            if (typeof unreg === "function") disposers.push(unreg);
            log(`Registered /${name}`);
        } catch (err) { log(`Register /${name} failed: ${String(err)}`); }
    }
}
 
// ── Plugin lifecycle ──────────────────────────────────────────────────────────
 
export default {
    onLoad() {
        storage.enabled      ??= false;
        storage.targetUserId ??= UNSET;
        storage.status       ??= "Not following";
 
        running           = true;
        pendingFollowDest = null;
        moduleCache.clear();
 
        lastSeenTargetChannel = storage.enabled && storage.targetUserId
            ? getUserVoiceChannel(storage.targetUserId) : null;
 
        startListening();
        injectProfileButton();
        registerCommands();
 
        log("Loaded.");
    },
 
    onUnload() {
        running           = false;
        pendingFollowDest = null;
 
        for (const dispose of disposers.splice(0).reverse()) {
            try { dispose(); } catch (err) { log(`Cleanup: ${String(err)}`); }
        }
        moduleCache.clear();
        log("Unloaded.");
    },
 
    settings: Settings,
};
 
