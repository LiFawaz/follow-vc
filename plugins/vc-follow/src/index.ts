
/**
 * VC Follow — Vendetta-compatible plugin
 *
 * Follows one user between voice channels, including across servers.
 * Persists the selected target until the user unfollows or switches target.
 * Retries joining a full voice channel when voice state changes.
 *
 * Author: Li Fawaz
 *
 * Compatibility note:
 * This file uses the legacy @vendetta/* API expected by the original
 * project. It is NOT a native @revenge-mod/* plugin migration.
 */

import { logger } from "@vendetta";
import { findByProps, findByName } from "@vendetta/metro";
import { React, ReactNative } from "@vendetta/metro/common";
import { after } from "@vendetta/patcher";
import { storage } from "@vendetta/plugin";
import Settings from "./Settings";

const PERM_CONNECT = 1n << 20n;
const PERM_MOVE_MEMBERS = 1n << 24n;

const disposers: Array<() => void> = [];
const moduleCache = new Map<string, any>();

let running = false;
let lastSeenTargetChannel: string | null = null;
let lastAttemptChannel: string | null = null;
let lastAttemptAt = 0;
let pendingFollowDest: string | null = null;
let retryQueued = false;

const DEBOUNCE_MS = 2500;

function log(message: string): void {
    try {
        logger.log(`[VC Follow] ${message}`);
    } catch {}
}

function setStatus(message: string): void {
    storage.status = message;
    log(message);
}

function probe(label: string, candidates: string[][]): any {
    if (moduleCache.has(label)) {
        return moduleCache.get(label);
    }

    for (const keys of candidates) {
        try {
            const result = findByProps(...keys);
            if (result) {
                moduleCache.set(label, result);
                return result;
            }
        } catch {}
    }

    return null;
}

function probeByName(name: string): any {
    if (moduleCache.has(`name:${name}`)) {
        return moduleCache.get(`name:${name}`);
    }

    try {
        const result = findByName(name, false);
        if (result) {
            moduleCache.set(`name:${name}`, result);
            return result;
        }
    } catch {}

    return null;
}

function voiceStore(): any {
    return probe("VoiceStateStore", [
        ["getVoiceStateForUser", "getVoiceStatesForChannel"],
        ["getVoiceStateForUser"],
        ["getAllVoiceStates"],
    ]);
}

function channelStore(): any {
    return probe("ChannelStore", [
        ["getChannel", "getDMFromUserId"],
        ["getChannel"],
    ]);
}

function userStore(): any {
    return probe("UserStore", [
        ["getCurrentUser", "getUser"],
        ["getCurrentUser"],
    ]);
}

function permissionStore(): any {
    return probe("PermissionStore", [
        ["can", "canWithPartialContext"],
        ["can"],
    ]);
}

function voiceActions(): any {
    return probe("VoiceActions", [
        ["selectVoiceChannel", "disconnect"],
        ["selectVoiceChannel"],
    ]);
}

function ownId(): string | null {
    try {
        return userStore()?.getCurrentUser?.()?.id ?? null;
    } catch {
        return null;
    }
}

function getUsername(userId: string): string {
    try {
        const user = userStore()?.getUser?.(userId);
        return user?.globalName
            ?? user?.displayName
            ?? user?.username
            ?? userId;
    } catch {
        return userId;
    }
}

function normalizeUserId(raw: unknown): string | null {
    const match = /^(?:<@!?)?(\d{15,22})>?$/.exec(
        String(raw ?? "").trim()
    );
    return match?.[1] ?? null;
}

function extractChannelId(state: any): string | null {
    const value = state?.channelId ?? state?.channel_id ?? null;
    return value == null ? null : String(value);
}

function getUserVoiceChannel(userId: string): string | null {
    const store = voiceStore();
    if (!store) return null;

    try {
        const direct = store.getVoiceStateForUser?.(userId);
        if (direct) return extractChannelId(direct);

        const all = store.getAllVoiceStates?.();
        if (all && typeof all === "object") {
            for (const group of Object.values(all) as any[]) {
                if (!group || typeof group !== "object") continue;

                const state = group[userId];
                if (state) return extractChannelId(state);
            }
        }
    } catch (error) {
        log(`Could not read voice state: ${String(error)}`);
    }

    return null;
}

function getOwnVoiceChannel(): string | null {
    const selected = probe("SelectedChannelStore", [
        ["getVoiceChannelId"],
        ["getCurrentVoiceChannelId"],
    ]);

    try {
        const value =
            selected?.getVoiceChannelId?.()
            ?? selected?.getCurrentVoiceChannelId?.()
            ?? null;

        return value == null ? null : String(value);
    } catch {
        return null;
    }
}

function can(channel: any, permission: bigint): boolean {
    const store = permissionStore();

    // Unknown permission status is not proof that joining is permitted.
    if (!store || typeof store.can !== "function") return true;

    try {
        return !!store.can(permission, channel);
    } catch {
        try {
            return !!store.can(Number(permission), channel);
        } catch {
            return true;
        }
    }
}

function countVoiceMembers(channelId: string): number | null {
    try {
        const states = voiceStore()?.getVoiceStatesForChannel?.(channelId);
        if (!states) return null;

        if (typeof states.size === "number") return states.size;
        if (Array.isArray(states)) return states.length;

        if (typeof states === "object") {
            return Object.keys(states).length;
        }
    } catch {}

    return null;
}

function channelHasSpace(channel: any, channelId: string): boolean {
    const limit = Number(channel?.userLimit ?? channel?.user_limit ?? 0);

    if (!Number.isFinite(limit) || limit <= 0) return true;
    if (can(channel, PERM_MOVE_MEMBERS)) return true;

    const count = countVoiceMembers(channelId);

    // If the member count is unknown, attempt the join and let Discord
    // enforce its own permissions and channel capacity.
    if (count === null) return true;

    return count < limit;
}

function clearPending(): void {
    pendingFollowDest = null;
    retryQueued = false;
}

function tryMoveTo(destinationId: string, source: string): void {
    if (
        !running
        || !storage.enabled
        || !storage.targetUserId
        || !destinationId
    ) {
        return;
    }

    const targetId = String(storage.targetUserId);

    // Do not join an outdated destination after the target has moved again.
    const actualTargetChannel = getUserVoiceChannel(targetId);
    if (
        actualTargetChannel
        && actualTargetChannel !== destinationId
    ) {
        pendingFollowDest = actualTargetChannel;
        queueRetry();
        return;
    }

    if (getOwnVoiceChannel() === destinationId) {
        clearPending();
        setStatus(`Already in ${getUsername(targetId)}'s voice channel`);
        return;
    }

    const now = Date.now();
    if (
        lastAttemptChannel === destinationId
        && now - lastAttemptAt < DEBOUNCE_MS
    ) {
        // Keep the pending destination so a later voice-state change can
        // retry it after the debounce window has expired.
        pendingFollowDest = destinationId;
        return;
    }

    const destination = channelStore()?.getChannel?.(destinationId);

    if (destination && !can(destination, PERM_CONNECT)) {
        clearPending();
        setStatus("Can't follow: no permission to connect to that channel");
        return;
    }

    if (
        destination
        && !channelHasSpace(destination, destinationId)
    ) {
        pendingFollowDest = destinationId;
        setStatus(
            `Voice channel is full — waiting for a slot for ${getUsername(targetId)}`
        );
        return;
    }

    const actions = voiceActions();
    if (typeof actions?.selectVoiceChannel !== "function") {
        pendingFollowDest = destinationId;
        setStatus("Voice switching API wasn't found on this Discord build");
        return;
    }

    pendingFollowDest = null;
    lastAttemptChannel = destinationId;
    lastAttemptAt = now;

    try {
        actions.selectVoiceChannel(destinationId);

        const channelName = destination?.name ?? destinationId;
        setStatus(
            `Following ${getUsername(targetId)} in ${channelName} (${source})`
        );
    } catch (error) {
        pendingFollowDest = destinationId;
        setStatus(`Voice join failed: ${String(error)}`);
    }
}

function queueRetry(): void {
    if (retryQueued || !running) return;
    retryQueued = true;

    // A short defer allows Discord's store to process the current dispatch
    // before we query the target and destination again.
    Promise.resolve().then(() => {
        retryQueued = false;
        retryPending();
    });
}

function retryPending(): void {
    if (
        !running
        || !storage.enabled
        || !storage.targetUserId
    ) {
        return;
    }

    const targetId = String(storage.targetUserId);
    const currentTargetChannel = getUserVoiceChannel(targetId);

    // The target may have switched channels while we were waiting.
    if (
        currentTargetChannel
        && currentTargetChannel !== pendingFollowDest
    ) {
        pendingFollowDest = currentTargetChannel;
    }

    if (!currentTargetChannel) {
        // Continue following; a later voice event will resume it.
        return;
    }

    if (!pendingFollowDest) return;

    const destination = channelStore()?.getChannel?.(pendingFollowDest);
    if (
        destination
        && !channelHasSpace(destination, pendingFollowDest)
    ) {
        return;
    }

    tryMoveTo(pendingFollowDest, "retry");
}

function onVoiceEvent(payload: any): void {
    if (!running || !payload) return;

    const updates: any[] =
        Array.isArray(payload.voiceStates) ? payload.voiceStates
        : Array.isArray(payload.voice_states) ? payload.voice_states
        : payload.voiceState ? [payload.voiceState]
        : [payload];

    const targetId = storage.targetUserId
        ? String(storage.targetUserId)
        : null;

    for (const state of updates) {
        if (!state) continue;

        const userId = String(state.userId ?? state.user_id ?? "");
        if (!targetId || userId !== targetId) continue;

        const channelId = extractChannelId(state);
        lastSeenTargetChannel = channelId;

        if (!channelId) {
            setStatus(
                `Waiting for ${getUsername(targetId)} to rejoin voice`
            );
            continue;
        }

        pendingFollowDest = channelId;
        queueRetry();
    }

    // Other users leaving a channel may free a slot for the target.
    queueRetry();
}

function onVoiceStoreChanged(): void {
    if (
        !running
        || !storage.enabled
        || !storage.targetUserId
    ) {
        return;
    }

    const targetId = String(storage.targetUserId);
    const currentChannel = getUserVoiceChannel(targetId);

    if (currentChannel !== lastSeenTargetChannel) {
        lastSeenTargetChannel = currentChannel;

        if (currentChannel) {
            pendingFollowDest = currentChannel;
        } else {
            setStatus(
                `Waiting for ${getUsername(targetId)} to rejoin voice`
            );
        }
    }

    // This path also runs when someone else leaves a full channel.
    queueRetry();
}

export function followUser(rawId: unknown): string {
    const id = normalizeUserId(rawId);

    if (!id) {
        return "Invalid user ID. Expected a 15–22 digit Discord ID.";
    }

    if (id === ownId()) {
        return "You can't follow yourself.";
    }

    const previous = storage.enabled
        ? String(storage.targetUserId ?? "")
        : "";

    storage.targetUserId = id;
    storage.enabled = true;

    clearPending();
    lastAttemptChannel = null;
    lastAttemptAt = 0;
    lastSeenTargetChannel = getUserVoiceChannel(id);

    const prefix = previous && previous !== id
        ? `Switched to following ${getUsername(id)}`
        : `Following ${getUsername(id)}`;

    if (lastSeenTargetChannel) {
        pendingFollowDest = lastSeenTargetChannel;
        tryMoveTo(lastSeenTargetChannel, "follow start");
        return `${prefix} — attempting to join their channel`;
    }

    setStatus(
        `Waiting for ${getUsername(id)} to enter a voice channel`
    );

    return `${prefix} — will follow when they join voice`;
}

export function stopFollowing(): string {
    const previous = storage.targetUserId
        ? String(storage.targetUserId)
        : null;

    storage.enabled = false;
    storage.targetUserId = null;

    clearPending();
    lastSeenTargetChannel = null;
    lastAttemptChannel = null;
    lastAttemptAt = 0;

    const message = previous
        ? `Stopped following ${previous}`
        : "Not following anyone";

    setStatus(message);
    return message;
}

/**
 * Subscribe to the legacy runtime's internal Flux and voice-state store.
 * These APIs are version-dependent; missing APIs are logged instead of
 * throwing during plugin startup.
 */
function startListening(): void {
    const flux = probe("Flux", [
        ["dispatch", "subscribe", "unsubscribe"],
        ["subscribe", "unsubscribe"],
    ]);

    if (typeof flux?.subscribe === "function") {
        for (const eventName of [
            "VOICE_STATE_UPDATES",
            "VOICE_STATE_UPDATE",
        ]) {
            try {
                flux.subscribe(eventName, onVoiceEvent);

                disposers.push(() => {
                    try {
                        flux.unsubscribe?.(eventName, onVoiceEvent);
                    } catch {}
                });

                log(`Subscribed to ${eventName}`);
            } catch (error) {
                log(`Could not subscribe to ${eventName}: ${String(error)}`);
            }
        }
    } else {
        log("Flux subscription API wasn't found");
    }

    const store = voiceStore();

    if (typeof store?.addChangeListener === "function") {
        try {
            const result = store.addChangeListener(onVoiceStoreChanged);

            disposers.push(
                typeof result === "function"
                    ? result
                    : () => {
                        try {
                            store.removeChangeListener?.(
                                onVoiceStoreChanged
                            );
                        } catch {}
                    }
            );

            log("Voice-state change listener attached");
        } catch (error) {
            log(`Could not attach voice-state listener: ${String(error)}`);
        }
    } else {
        log("Voice-state change listener API wasn't found");
    }

    if (storage.enabled && storage.targetUserId) {
        lastSeenTargetChannel = getUserVoiceChannel(
            String(storage.targetUserId)
        );

        if (lastSeenTargetChannel) {
            pendingFollowDest = lastSeenTargetChannel;
            queueRetry();
        } else {
            log("Saved target isn't currently in voice");
        }
    }
}

/**
 * Best-effort profile overflow injection.
 *
 * IMPORTANT: This still relies on private component names and prop shapes.
 * It is not a guaranteed Revenge profile-action API.
 */
function buildFollowEntry(userId: string): any {
    const followingThis =
        Boolean(storage.enabled)
        && String(storage.targetUserId) === String(userId);

    const username = getUsername(userId);
    const label = followingThis
        ? `Following ${username} — tap to stop`
        : "Follow this user";

    const onPress = (): void => {
        if (followingThis) {
            stopFollowing();
        } else {
            followUser(userId);
        }
    };

    const rowModule = probe("ActionSheetRow", [
        ["ActionSheetRow", "ActionSheetSection"],
        ["ActionSheetRow"],
    ]);

    const ActionSheetRow =
        rowModule?.ActionSheetRow
        ?? rowModule?.default;

    if (typeof ActionSheetRow === "function") {
        return React.createElement(ActionSheetRow, {
            key: "vc-follow-entry",
            label,
            onPress,
        });
    }

    const RN = ReactNative as any;

    if (!RN?.TouchableOpacity || !RN?.Text) return null;

    return React.createElement(
        RN.TouchableOpacity,
        {
            key: "vc-follow-entry",
            onPress,
            style: {
                flexDirection: "row",
                alignItems: "center",
                paddingHorizontal: 16,
                paddingVertical: 14,
                borderTopWidth: 0.5,
                borderTopColor: "rgba(255,255,255,0.08)",
            },
        },
        React.createElement(
            RN.Text,
            {
                style: {
                    flex: 1,
                    color: "#FFFFFF",
                    fontSize: 16,
                },
            },
            label
        )
    );
}

function injectEntry(root: any, entry: any): boolean {
    if (!root?.props || !entry) return false;

    // Do not mutate the original React element's props. Clone the element
    // when adding the entry to avoid corrupting shared render output.
    const children = root.props.children;

    if (Array.isArray(children)) {
        const hasActionRows = children.some(
            (child: any) =>
                child?.props
                && typeof child.props.onPress === "function"
        );

        if (hasActionRows) {
            root.props.children = [...children, entry];
            return true;
        }

        for (const child of children) {
            if (injectEntry(child, entry)) return true;
        }
    } else if (children?.props) {
        if (injectEntry(children, entry)) return true;
    }

    return false;
}

function injectProfileButton(): void {
    const candidates = [
        "UserProfileContextMenu",
        "UserProfileOverflowMenu",
        "ProfileOverflowMenu",
        "GuildMemberUserContextMenu",
        "UserContextMenu",
        "NativeUserContextMenu",
        "UserProfileBottomSheetContextMenu",
    ];

    let patched = 0;

    for (const name of candidates) {
        const mod = probeByName(name);
        if (!mod) continue;

        const key =
            typeof mod.default === "function"
                ? "default"
                : Object.keys(mod).find(
                    candidate => typeof mod[candidate] === "function"
                );

        if (!key) continue;

        try {
            const unpatch = after(key, mod, (args: any[], result: any) => {
                if (!running || !result) return;

                const props = args[0] ?? {};
                const userId = String(
                    props.userId
                    ?? props.user?.id
                    ?? props.member?.userId
                    ?? props.guildMember?.userId
                    ?? ""
                );

                if (!userId || userId === ownId()) return;

                const entry = buildFollowEntry(userId);
                if (!entry) return;

                injectEntry(result, entry);
            });

            if (typeof unpatch === "function") {
                disposers.push(unpatch);
            }

            patched++;
            log(`Patched possible profile menu: ${name}`);
        } catch (error) {
            log(`Could not patch ${name}: ${String(error)}`);
        }
    }

    if (patched === 0) {
        log(
            "No known profile menu component resolved; profile button may not appear"
        );
    }
}

export default {
    onLoad(): void {
        if (storage.enabled === undefined) {
            storage.enabled = false;
        }

        if (storage.targetUserId === undefined) {
            storage.targetUserId = null;
        }

        if (storage.status === undefined) {
            storage.status = "Not following";
        }

        running = true;
        clearPending();
        lastAttemptChannel = null;
        lastAttemptAt = 0;
        moduleCache.clear();

        startListening();
        injectProfileButton();

        log("Loaded");
    },

    onUnload(): void {
        running = false;
        clearPending();

        for (const dispose of disposers.splice(0).reverse()) {
            try {
                dispose();
            } catch (error) {
                log(`Cleanup failed: ${String(error)}`);
            }
        }

        moduleCache.clear();
        log("Unloaded");
    },

    settings: Settings,
};
