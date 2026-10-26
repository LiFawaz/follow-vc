/**
 * VC Follow — Revenge plugin (Vendetta-compatible)
 * Follows a friend between voice channels — including across different servers.
 * Adds a dynamic "Follow / Following" entry to every user's profile overflow menu.
 *
 * Author: Li Fawaz
 */
import { logger }                  from "@vendetta";
import { findByProps, findByName } from "@vendetta/metro";
import { React, ReactNative }      from "@vendetta/metro/common";
import { after }                   from "@vendetta/patcher";
import { storage }                 from "@vendetta/plugin";
import Settings                    from "./Settings";

// ── Permission bitmasks (Discord channel permission flags) ────────────────────
const PERM_CONNECT      = 1n << 20n;  // USER_LIMIT gate
const PERM_MOVE_MEMBERS = 1n << 24n;  // can always bypass user-limit

// ── Global state ──────────────────────────────────────────────────────────────
const disposers:   Array<() => void> = [];
const moduleCache: Map<string, any>  = new Map();

let running              = false;

/** Last channel ID we saw the target occupying. */
let lastSeenTargetChannel: string | null = null;

/** Debounce: last channel ID we called selectVoiceChannel for. */
let lastAttemptChannel: string | null = null;

/** Debounce: epoch-ms of the last selectVoiceChannel call. */
let lastAttemptAt = 0;

/**
 * When the target's channel is full we park the destination here.
 * Every subsequent voice-state-store change (anyone moving in/out of any VC)
 * retries this until a slot opens or the target moves on their own.
 */
let pendingFollowDest: string | null = null;

const DEBOUNCE_MS = 2_500;

// ── Logging ───────────────────────────────────────────────────────────────────

function log(msg: string): void {
    try { logger.log(`[VC Follow] ${msg}`); } catch (_) {}
}

function setStatus(msg: string): void {
    storage.status = msg;
    log(msg);
}

// ── Module resolution (memoised) ──────────────────────────────────────────────
// Discord's internal prop names shift between builds; we probe multiple
// candidate key sets per module and cache the first hit.

function probe(label: string, options: string[][]): any {
    if (moduleCache.has(label)) return moduleCache.get(label);
    for (const keys of options) {
        try {
            const m = findByProps(...keys);
            if (m) { moduleCache.set(label, m); return m; }
        } catch (_) {}
    }
    return null;
}

function probeByName(name: string): any {
    if (moduleCache.has(name)) return moduleCache.get(name);
    try {
        const m = findByName(name, false); // false → return the module, not just .default
        if (m) { moduleCache.set(name, m); return m; }
    } catch (_) {}
    return null;
}

// ── Store accessors ───────────────────────────────────────────────────────────

const voiceStore = (): any => probe("VoiceStateStore", [
    ["getVoiceStateForUser", "getVoiceStatesForChannel"],
    ["getVoiceStateForUser"],
    ["getAllVoiceStates"],
]);

const channelStore = (): any => probe("ChannelStore", [
    ["getChannel", "getDMFromUserId"],
    ["getChannel"],
]);

const userStore = (): any => probe("UserStore", [
    ["getCurrentUser", "getUser"],
    ["getCurrentUser"],
]);

const permStore = (): any => probe("PermissionStore", [
    ["can", "canWithPartialContext"],
    ["can"],
]);

const voiceActions = (): any => probe("VoiceActions", [
    ["selectVoiceChannel", "disconnect"],
    ["selectVoiceChannel"],
]);

// ── Utilities ─────────────────────────────────────────────────────────────────

function ownId(): string | null {
    try { return userStore()?.getCurrentUser?.()?.id ?? null; } catch (_) { return null; }
}

/** Resolve a user's display name from the user store. */
function getUsername(userId: string): string {
    try {
        const u = userStore()?.getUser?.(userId);
        if (!u) return userId;
        // Discord's new username system uses globalName; fall back to legacy username.
        return (u.globalName ?? u.displayName ?? u.username ?? userId) as string;
    } catch (_) { return userId; }
}

/** Accept raw snowflakes or <@12345> / <@!12345> mention syntax. */
function normalizeUserId(raw: unknown): string | null {
    const s = String(raw ?? "").trim();
    const m = /^(?:<@!?)?(\d{15,22})>?$/.exec(s);
    return m?.[1] ?? null;
}

/** Channel ID of the VC the target user is currently in, or null. */
function getUserVoiceChannel(userId: string): string | null {
    const vs = voiceStore();
    if (!vs) return null;
    try {
        // Fast path: direct per-user lookup (most builds).
        const state = vs.getVoiceStateForUser?.(userId);
        if (state) return state.channelId ?? state.channel_id ?? null;

        // Slow path: iterate all guilds (cross-server safety net).
        const all = vs.getAllVoiceStates?.();
        if (all && typeof all === "object") {
            for (const group of Object.values(all) as any[]) {
                const s = (group as any)?.[userId];
                if (s) return s.channelId ?? s.channel_id ?? null;
            }
        }
    } catch (_) {}
    return null;
}

/** Channel ID we are currently in, or null. */
function getOwnVoiceChannel(): string | null {
    const selected = probe("SelectedChannelStore", [
        ["getVoiceChannelId"],
        ["getCurrentVoiceChannelId"],
    ]);
    try {
        return selected?.getVoiceChannelId?.()
            ?? selected?.getCurrentVoiceChannelId?.()
            ?? null;
    } catch (_) { return null; }
}

// ── Permission / capacity checks ──────────────────────────────────────────────

function can(channel: any, perm: bigint): boolean {
    const ps = permStore();
    if (!ps || typeof ps.can !== "function") return false;
    try { return !!ps.can(perm, channel); } catch (_) { return false; }
}

function channelHasSpace(channel: any, channelId: string): boolean {
    const limit = Number(channel.userLimit ?? channel.user_limit ?? 0);
    if (!limit || !Number.isFinite(limit)) return true; // unlimited

    // MOVE_MEMBERS holders bypass the user limit.
    if (can(channel, PERM_MOVE_MEMBERS)) return true;

    try {
        const states = voiceStore()?.getVoiceStatesForChannel?.(channelId);
        if (!states) return true;
        const count =
            typeof states.size === "number" ? states.size       // Map
            : Array.isArray(states)          ? states.length    // Array
            : typeof states === "object"     ? Object.keys(states).length
            : 0;
        return count < limit;
    } catch (_) { return true; }
}

// ── Core join logic ───────────────────────────────────────────────────────────

function tryMoveTo(destinationId: string, source: string): void {
    if (!running || !storage.enabled || !storage.targetUserId || !destinationId) return;

    // Already there — nothing to do.
    if (getOwnVoiceChannel() === destinationId) {
        pendingFollowDest = null;
        setStatus(`Already in ${storage.targetUserId}'s channel`);
        return;
    }

    // Debounce — never hammer the same channel within the debounce window.
    if (lastAttemptChannel === destinationId && Date.now() - lastAttemptAt < DEBOUNCE_MS) return;

    const dest = channelStore()?.getChannel?.(destinationId);

    if (dest) {
        // No connect permission — don't wait, just bail.
        if (!can(dest, PERM_CONNECT)) {
            pendingFollowDest = null;
            setStatus("Can't follow: no permission to connect to that voice channel");
            return;
        }
        // Channel is full — queue for when a slot opens.
        if (!channelHasSpace(dest, destinationId)) {
            pendingFollowDest = destinationId;
            setStatus(
                `Voice channel is full — waiting for a slot or for ` +
                `${storage.targetUserId} to move`
            );
            return;
        }
    }

    // For cross-server channels the store may be cold (channel not cached yet).
    // We still attempt the join; Discord's own routing handles the rest.

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
        const chName  = dest?.name ?? destinationId;
        const guildId = dest?.guild_id ?? "cross-server";
        setStatus(`Following ${storage.targetUserId} → #${chName} [${guildId}] (${source})`);
    } catch (err) {
        setStatus(`VC join failed: ${String(err)}`);
    }
}

// ── Pending-channel retry helper ──────────────────────────────────────────────
// Called from both event handlers so the retry works regardless of which
// fires first (Flux event vs. store change).

function retryPending(): void {
    if (!pendingFollowDest || !running || !storage.enabled) return;
    const dest = channelStore()?.getChannel?.(pendingFollowDest);
    if (dest && channelHasSpace(dest, pendingFollowDest)) {
        tryMoveTo(pendingFollowDest, "capacity freed");
    }
}

// ── Flux event handler ────────────────────────────────────────────────────────

function onVoiceEvent(payload: any): void {
    if (!running || !payload) return;

    const updates: any[] = (
        Array.isArray(payload.voiceStates)   ? payload.voiceStates   :
        Array.isArray(payload.voice_states)  ? payload.voice_states  :
        payload.voiceState                   ? [payload.voiceState]  :
        [payload]
    );

    for (const state of updates) {
        if (!state) continue;
        const userId     = String(state.userId ?? state.user_id ?? "");
        const channelId  = state.channelId ?? state.channel_id ?? null;

        if (userId === String(storage.targetUserId)) {
            const prev = lastSeenTargetChannel;
            lastSeenTargetChannel = channelId;

            if (!channelId) {
                // Target disconnected. Keep following — we resume when they rejoin.
                setStatus("Friend left voice — will follow when they rejoin a VC");
            } else if (channelId !== prev) {
                tryMoveTo(channelId, "voice event");
            }
        }
    }

    // NOTE: Flux fires before the store updates, so channelHasSpace may read
    // stale data here. The definitive capacity retry happens in onVoiceStoreChanged
    // (below) which fires after the store has processed the same event.
    retryPending();
}

// ── Voice-state store change handler ─────────────────────────────────────────
// This fires AFTER the VoiceStateStore has applied the latest batch, so its
// data is always fresh. It's the reliable path for detecting freed capacity.

function onVoiceStoreChanged(): void {
    if (!running || !storage.enabled || !storage.targetUserId) return;

    const current = getUserVoiceChannel(storage.targetUserId);

    if (current !== lastSeenTargetChannel) {
        lastSeenTargetChannel = current;
        if (current) {
            tryMoveTo(current, "store change");
        } else {
            setStatus("Friend left voice — will follow when they rejoin a VC");
        }
    }

    // !! This is the critical fix for the full-channel waiting bug:
    // We retry the pending destination on EVERY store change (not only when
    // the target moved). When someone leaves the full channel, the store
    // updates their departure, this fires, and we finally see free capacity.
    retryPending();
}

// ── Public API (used by Settings.tsx and the profile button) ──────────────────

export function followUser(rawId: unknown): string {
    const id = normalizeUserId(rawId);
    if (!id) return "Invalid user ID — needs to be a 15-22 digit Discord snowflake.";
    if (id === ownId()) return "You can't follow yourself.";

    const wasFollowing = storage.enabled && storage.targetUserId;
    storage.targetUserId  = id;
    storage.enabled       = true;
    pendingFollowDest     = null;
    lastAttemptChannel    = null;
    lastSeenTargetChannel = getUserVoiceChannel(id);

    const prefix = wasFollowing && wasFollowing !== id
        ? `Switched from ${wasFollowing} → ${id}`
        : `Following ${id}`;

    if (lastSeenTargetChannel) {
        tryMoveTo(lastSeenTargetChannel, "follow start");
        return `${prefix} — joining their channel now`;
    }
    setStatus(`Waiting for ${id} to enter a voice channel…`);
    return `${prefix} — will join when they enter a VC`;
}

export function stopFollowing(): string {
    const was = storage.targetUserId;
    storage.enabled      = false;
    storage.targetUserId = null;
    pendingFollowDest    = null;
    lastSeenTargetChannel = null;
    lastAttemptChannel   = null;
    const msg = was ? `Stopped following ${was}` : "Not following anyone";
    setStatus(msg);
    return msg;
}

// ── Listener setup ────────────────────────────────────────────────────────────

function startListening(): void {
    // Flux dispatcher — VOICE_STATE_UPDATES fires for every VC state change.
    const flux = probe("Flux", [
        ["dispatch", "subscribe", "unsubscribe"],
        ["subscribe", "unsubscribe"],
    ]);
    if (flux?.subscribe) {
        for (const ev of ["VOICE_STATE_UPDATES", "VOICE_STATE_UPDATE"]) {
            try {
                flux.subscribe(ev, onVoiceEvent);
                disposers.push(() => { try { flux.unsubscribe(ev, onVoiceEvent); } catch (_) {} });
                log(`Subscribed to Flux: ${ev}`);
            } catch (err) { log(`Flux subscribe ${ev} failed: ${err}`); }
        }
    } else {
        log("Flux dispatcher not found — voice events won't fire");
    }

    // VoiceStateStore change listener — fires AFTER the store applies updates.
    const vss = voiceStore();
    if (vss?.addChangeListener) {
        try {
            const unreg = vss.addChangeListener(onVoiceStoreChanged);
            disposers.push(typeof unreg === "function"
                ? unreg
                : () => { try { vss.removeChangeListener?.(onVoiceStoreChanged); } catch (_) {} }
            );
            log("VoiceStateStore listener attached");
        } catch (err) { log(`VoiceStateStore listener failed: ${err}`); }
    }

    // Resume following if storage says we were active before the reload.
    if (storage.enabled && storage.targetUserId) {
        lastSeenTargetChannel = getUserVoiceChannel(storage.targetUserId);
        log(`Resuming follow of ${storage.targetUserId}`);
        if (lastSeenTargetChannel) tryMoveTo(lastSeenTargetChannel, "resume");
    }
}

// ── Profile overflow button ───────────────────────────────────────────────────
// Injects a "Follow / Following" entry into the "..." overflow action sheet
// that Discord shows when you press "..." on a user's profile page.

/**
 * Walk the React element tree and inject `entry` adjacent to existing
 * action-sheet rows (elements with an onPress prop). Falls back to
 * appending at the root level if no row array is found.
 */
function injectEntry(root: any, entry: any): void {
    function walk(node: any, depth: number): boolean {
        if (!node?.props || depth > 5) return false;
        const ch = node.props.children;

        if (Array.isArray(ch) && ch.length > 0) {
            // An array whose members have onPress is an action-sheet row group.
            const isRowGroup = ch.some(
                (c: any) => c?.props && typeof c.props.onPress === "function"
            );
            if (isRowGroup) {
                node.props.children = [...ch, entry];
                return true;
            }
            for (const child of ch) {
                if (walk(child, depth + 1)) return true;
            }
        } else if (ch && !Array.isArray(ch)) {
            return walk(ch, depth + 1);
        }
        return false;
    }

    if (!walk(root, 0)) {
        if (root?.props) {
            const ch = root.props.children;
            root.props.children = Array.isArray(ch) ? [...ch, entry]
                : ch != null ? [ch, entry] : [entry];
        }
    }
}

/**
 * Build the React element for the follow/unfollow menu entry.
 * The label reflects the current following state — re-evaluated each time
 * the menu is opened, so it's always accurate.
 */
function buildFollowEntry(userId: string): any {
    const isFollowingThis =
        Boolean(storage.enabled) &&
        String(storage.targetUserId) === String(userId);

    const username = getUsername(userId);
    const label    = isFollowingThis
        ? `✅  Following ${username} — tap to stop`
        : `🔔  Follow this user`;

    const onPress = (): void => {
        if (isFollowingThis) {
            stopFollowing();
        } else {
            // Also handles switching from one target to another.
            followUser(userId);
        }
    };

    // Try Discord's native ActionSheetRow for pixel-perfect styling.
    const rowMod = probe("ActionSheetRow", [
        ["ActionSheetRow", "ActionSheetSection"],
        ["ActionSheetRow"],
    ]);
    const ActionSheetRow: any =
        rowMod?.ActionSheetRow ??
        (typeof rowMod?.default === "function" ? rowMod.default : null);

    const R  = React       as any;
    const RN = ReactNative as any;

    if (typeof ActionSheetRow === "function") {
        return R.createElement(ActionSheetRow, { key: "vcf-entry", label, onPress });
    }

    // Fallback: manually styled row that matches Discord's dark theme.
    return R.createElement(
        RN.TouchableOpacity,
        {
            key:   "vcf-entry",
            onPress,
            style: {
                flexDirection:     "row",
                alignItems:        "center",
                paddingHorizontal: 16,
                paddingVertical:   14,
                borderTopWidth:    0.5,
                borderTopColor:    "rgba(255,255,255,0.08)",
            },
        },
        R.createElement(
            RN.Text,
            { style: { flex: 1, color: "#FFFFFF", fontSize: 16, fontWeight: "400" } },
            label,
        ),
    );
}

function injectProfileButton(): void {
    // All known component names for Discord Android's user-profile "..." overflow
    // menu across builds that Revenge targets. We patch every name that resolves
    // on this particular build.
    const targets = [
        "UserProfileContextMenu",               // "..." on the profile page (primary)
        "UserProfileOverflowMenu",              // alternative display name
        "ProfileOverflowMenu",                  // older builds
        "GuildMemberUserContextMenu",           // guild member context
        "UserContextMenu",                      // generic user context
        "NativeUserContextMenu",               // native wrapper variant
        "UserProfileBottomSheetContextMenu",   // bottom-sheet profile variant
    ];

    let patched = 0;
    for (const name of targets) {
        const mod = probeByName(name);
        if (!mod) { log(`${name}: not on this build`); continue; }

        // Locate the function to patch (.default, or first named export).
        const key: string =
            typeof mod.default === "function"
                ? "default"
                : (Object.keys(mod).find(k => typeof mod[k] === "function") ?? "");
        if (!key) { log(`${name}: no patchable export`); continue; }

        try {
            const unpatch = after(key, mod, (args: any[], res: any) => {
                if (!res) return;

                // Extract userId from component props — prop name varies by component.
                const props   = args[0] ?? {};
                const userId  = (
                    props.userId      ??
                    props.user?.id    ??
                    props.member?.userId ??
                    props.guildMember?.userId
                ) as string | undefined;

                if (!userId) return;
                if (userId === ownId()) return; // skip our own profile

                const entry = buildFollowEntry(userId);
                injectEntry(res, entry);
            });
            if (typeof unpatch === "function") disposers.push(unpatch);
            log(`Patched ${name}`);
            patched++;
        } catch (err) {
            log(`Failed to patch ${name}: ${err}`);
        }
    }

    if (patched === 0) {
        log("No profile context menu components found on this build");
    }
}

// ── Plugin lifecycle ──────────────────────────────────────────────────────────

export default {
    onLoad(): void {
        // Initialise storage with safe defaults.
        if (storage.enabled      === undefined) storage.enabled      = false;
        if (storage.targetUserId === undefined) storage.targetUserId = null;
        if (storage.status       === undefined) storage.status       = "Not following";

        running           = true;
        pendingFollowDest = null;
        moduleCache.clear();

        startListening();
        injectProfileButton();

        log("Loaded — profile button injected, listeners active");
    },

    onUnload(): void {
        running           = false;
        pendingFollowDest = null;

        // Run unpatchers in reverse registration order.
        for (const d of disposers.splice(0).reverse()) {
            try { d(); } catch (err) { log(`Cleanup error: ${err}`); }
        }
        moduleCache.clear();
        log("Unloaded");
    },

    settings: Settings,
};
