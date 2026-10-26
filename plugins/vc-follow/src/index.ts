
import { logger } from "@vendetta";
import { findByProps, findByName } from "@vendetta/metro";
import { after } from "@vendetta/patcher";
import { findInReactTree } from "@vendetta/utils";
import { storage } from "@vendetta/plugin";
import Settings from "./Settings";

const PROFILE_MENU_NAMES = [
    "UserProfileOverflowMenu",
    "BotUserProfileOverflowMenu",
];

const PERM_CONNECT = 1n << 20n;
const PERM_MOVE_MEMBERS = 1n << 24n;
const DEBOUNCE_MS = 2500;

const unpatches: Array<() => void> = [];
const cache = new Map<string, any>();

let running = false;
let lastSeenTargetChannel: string | null = null;
let pendingFollowDest: string | null = null;
let lastAttemptChannel: string | null = null;
let lastAttemptAt = 0;

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
    if (cache.has(label)) return cache.get(label);

    for (const keys of candidates) {
        try {
            const module = findByProps(...keys);
            if (module) {
                cache.set(label, module);
                return module;
            }
        } catch {}
    }

    return null;
}

function probeName(name: string): any {
    if (cache.has(name)) return cache.get(name);

    try {
        const module = findByName(name, false);
        if (module) {
            cache.set(name, module);
            return module;
        }
    } catch {}

    return null;
}

const voiceStore = () =>
    probe("VoiceStateStore", [
        ["getVoiceStateForUser", "getVoiceStatesForChannel"],
        ["getVoiceStateForUser"],
        ["getAllVoiceStates"],
    ]);

const channelStore = () =>
    probe("ChannelStore", [["getChannel"]]);

const userStore = () =>
    probe("UserStore", [["getCurrentUser", "getUser"], ["getCurrentUser"]]);

const permissionStore = () =>
    probe("PermissionStore", [["can"]]);

const voiceActions = () =>
    probe("VoiceActions", [["selectVoiceChannel", "disconnect"], ["selectVoiceChannel"]]);

function ownId(): string | null {
    try {
        return userStore()?.getCurrentUser?.()?.id ?? null;
    } catch {
        return null;
    }
}

function getUsername(id: string): string {
    try {
        const user = userStore()?.getUser?.(id);
        return user?.globalName ?? user?.displayName ?? user?.username ?? id;
    } catch {
        return id;
    }
}

function normalizeUserId(value: unknown): string | null {
    const match = /^(?:<@!?)?(\d{15,22})>?$/.exec(String(value ?? "").trim());
    return match?.[1] ?? null;
}

function getUserVoiceChannel(id: string): string | null {
    const store = voiceStore();
    if (!store) return null;

    try {
        const state = store.getVoiceStateForUser?.(id);
        if (state) return state.channelId ?? state.channel_id ?? null;

        const all = store.getAllVoiceStates?.();
        if (all && typeof all === "object") {
            for (const group of Object.values(all) as any[]) {
                const state = group?.[id];
                if (state) return state.channelId ?? state.channel_id ?? null;
            }
        }
    } catch (error) {
        log(`Voice lookup failed: ${String(error)}`);
    }

    return null;
}

function getOwnVoiceChannel(): string | null {
    const store = probe("SelectedChannelStore", [
        ["getVoiceChannelId"],
        ["getCurrentVoiceChannelId"],
    ]);

    try {
        return store?.getVoiceChannelId?.()
            ?? store?.getCurrentVoiceChannelId?.()
            ?? null;
    } catch {
        return null;
    }
}

function can(channel: any, permission: bigint): boolean | null {
    const store = permissionStore();
    if (typeof store?.can !== "function") return null;

    try {
        return !!store.can(permission, channel);
    } catch {
        try {
            return !!store.can(Number(permission), channel);
        } catch {
            return null;
        }
    }
}

function channelHasSpace(channel: any, channelId: string): boolean | null {
    if (!channel) return null;

    const limit = Number(channel.userLimit ?? channel.user_limit ?? 0);
    if (!Number.isFinite(limit) || limit <= 0) return true;

    if (can(channel, PERM_MOVE_MEMBERS) === true) return true;

    try {
        const states = voiceStore()?.getVoiceStatesForChannel?.(channelId);
        if (!states) return null;

        const count =
            typeof states.size === "number" ? states.size :
            Array.isArray(states) ? states.length :
            typeof states === "object" ? Object.keys(states).length : 0;

        return count < limit;
    } catch {
        return null;
    }
}

function tryMoveTo(destinationId: string, source: string): void {
    if (!running || !storage.enabled || !storage.targetUserId || !destinationId) return;

    if (getOwnVoiceChannel() === destinationId) {
        pendingFollowDest = null;
        setStatus(`Already in ${getUsername(String(storage.targetUserId))}'s voice channel`);
        return;
    }

    if (
        lastAttemptChannel === destinationId &&
        Date.now() - lastAttemptAt < DEBOUNCE_MS
    ) return;

    let channel: any = null;

    try {
        channel = channelStore()?.getChannel?.(destinationId) ?? null;
    } catch {}

    if (channel) {
        if (can(channel, PERM_CONNECT) === false) {
            pendingFollowDest = null;
            setStatus("Can't join: missing permission to connect");
            return;
        }

        if (channelHasSpace(channel, destinationId) === false) {
            pendingFollowDest = destinationId;
            setStatus("Voice channel is full; waiting for a free slot");
            return;
        }
    }

    const actions = voiceActions();

    if (typeof actions?.selectVoiceChannel !== "function") {
        setStatus("Voice switching API not found on this Discord build");
        return;
    }

    pendingFollowDest = null;
    lastAttemptChannel = destinationId;
    lastAttemptAt = Date.now();

    try {
        actions.selectVoiceChannel(destinationId);
        setStatus(`Trying to join ${channel?.name ?? "target voice channel"} (${source})`);
    } catch (error) {
        setStatus(`Join failed: ${String(error)}`);
    }
}

function retryPending(): void {
    if (!pendingFollowDest || !running || !storage.enabled) return;

    const destination = pendingFollowDest;
    const channel = channelStore()?.getChannel?.(destination);
    const capacity = channelHasSpace(channel, destination);

    if (capacity === false) return;

    lastAttemptChannel = null;
    tryMoveTo(destination, "retry");
}

function onVoiceEvent(payload: any): void {
    if (!running || !payload) return;

    const updates = Array.isArray(payload.voiceStates)
        ? payload.voiceStates
        : Array.isArray(payload.voice_states)
            ? payload.voice_states
            : payload.voiceState
                ? [payload.voiceState]
                : payload.voice_state
                    ? [payload.voice_state]
                    : [payload];

    for (const state of updates) {
        if (!state) continue;

        const userId = String(state.userId ?? state.user_id ?? "");
        if (userId !== String(storage.targetUserId ?? "")) continue;

        const channelId = state.channelId ?? state.channel_id ?? null;
        lastSeenTargetChannel = channelId;

        if (channelId) {
            tryMoveTo(String(channelId), "voice event");
        } else {
            setStatus("Target left voice; waiting for them to rejoin");
        }
    }

    retryPending();
}

function onVoiceStoreChanged(): void {
    if (!running || !storage.enabled || !storage.targetUserId) return;

    const store = voiceStore();
    if (!store) return;

    const current = getUserVoiceChannel(String(storage.targetUserId));

    if (current !== lastSeenTargetChannel) {
        lastSeenTargetChannel = current;

        if (current) {
            tryMoveTo(current, "store change");
        } else {
            setStatus("Target left voice; waiting for them to rejoin");
        }
    }

    retryPending();
}

export function followUser(rawId: unknown): string {
    const id = normalizeUserId(rawId);

    if (!id) return "Invalid Discord user ID";
    if (id === ownId()) return "You can't follow yourself";

    storage.targetUserId = id;
    storage.enabled = true;

    pendingFollowDest = null;
    lastAttemptChannel = null;
    lastAttemptAt = 0;
    lastSeenTargetChannel = getUserVoiceChannel(id);

    if (lastSeenTargetChannel) {
        tryMoveTo(lastSeenTargetChannel, "follow start");
        return `Following ${getUsername(id)}`;
    }

    setStatus(`Waiting for ${getUsername(id)} to join a voice channel`);
    return `Following ${getUsername(id)}; waiting for them to join voice`;
}

export function stopFollowing(): string {
    const oldId = storage.targetUserId;

    storage.enabled = false;
    storage.targetUserId = null;

    pendingFollowDest = null;
    lastSeenTargetChannel = null;
    lastAttemptChannel = null;
    lastAttemptAt = 0;

    const message = oldId
        ? `Stopped following ${getUsername(String(oldId))}`
        : "Not following anyone";

    setStatus(message);
    return message;
}

/* PermissionViewer-style profile menu integration */

function getMainItems(result: any): any[] | null {
    let items = result?.props?.items;

    if (Array.isArray(items) && Array.isArray(items[0])) {
        return items[0];
    }

    items = result?.props?.children?.props?.items;

    if (Array.isArray(items) && Array.isArray(items[0])) {
        return items[0];
    }

    try {
        const node = findInReactTree(
            result,
            (item: any) =>
                Array.isArray(item?.props?.items) &&
                Array.isArray(item.props.items[0])
        );

        return node?.props?.items?.[0] ?? null;
    } catch (error) {
        log(`Menu tree lookup failed: ${String(error)}`);
        return null;
    }
}

function patchProfileMenu(args: any[], result: any): void {
    if (!running || !result) return;

    const props = args?.[0] ?? {};
    const userId = props.user?.id;

    if (!userId || String(userId) === ownId()) return;

    const items = getMainItems(result);

    if (!items) {
        log("Profile menu items not found");
        return;
    }

    const id = String(userId);
    const following =
        Boolean(storage.enabled) &&
        String(storage.targetUserId) === id;

    const label = following
        ? `Following ${getUsername(id)} — tap to unfollow`
        : "Follow this user";

    const entry = {
        label,
        vcFollowAction: true,
        action: () => {
            if (
                storage.enabled &&
                String(storage.targetUserId) === id
            ) {
                stopFollowing();
            } else {
                followUser(id);
            }
        },
    };

    const existing = items.findIndex(
        (item: any) => item?.vcFollowAction === true
    );

    if (existing >= 0) {
        items[existing] = entry;
    } else {
        items.push(entry);
    }
}

function injectProfileButton(): void {
    let patched = 0;

    for (const name of PROFILE_MENU_NAMES) {
        const module = probeName(name);

        if (!module || typeof module.default !== "function") {
            log(`${name} not found`);
            continue;
        }

        try {
            const unpatch = after("default", module, patchProfileMenu);

            if (typeof unpatch === "function") {
                unpatches.push(unpatch);
            }

            patched++;
            log(`Patched ${name}`);
        } catch (error) {
            log(`Could not patch ${name}: ${String(error)}`);
        }
    }

    if (!patched) {
        log("No supported profile menu found");
    }
}

function startListening(): void {
    const flux = probe("Flux", [
        ["dispatch", "subscribe", "unsubscribe"],
        ["subscribe", "unsubscribe"],
    ]);

    if (typeof flux?.subscribe === "function") {
        for (const event of ["VOICE_STATE_UPDATES", "VOICE_STATE_UPDATE"]) {
            try {
                flux.subscribe(event, onVoiceEvent);

                unpatches.push(() => {
                    try {
                        flux.unsubscribe?.(event, onVoiceEvent);
                    } catch {}
                });
            } catch (error) {
                log(`Flux subscription failed: ${String(error)}`);
            }
        }
    } else {
        log("Flux dispatcher unavailable");
    }

    const store = voiceStore();

    if (typeof store?.addChangeListener === "function") {
        try {
            const remove = store.addChangeListener(onVoiceStoreChanged);

            unpatches.push(
                typeof remove === "function"
                    ? remove
                    : () => {
                        try {
                            store.removeChangeListener?.(onVoiceStoreChanged);
                        } catch {}
                    }
            );
        } catch (error) {
            log(`Voice listener failed: ${String(error)}`);
        }
    }

    if (storage.enabled && storage.targetUserId) {
        lastSeenTargetChannel = getUserVoiceChannel(
            String(storage.targetUserId)
        );

        if (lastSeenTargetChannel) {
            tryMoveTo(lastSeenTargetChannel, "resume");
        } else {
            setStatus(
                `Waiting for ${getUsername(String(storage.targetUserId))} to join voice`
            );
        }
    }
}

export default {
    onLoad() {
        if (storage.enabled === undefined) storage.enabled = false;
        if (storage.targetUserId === undefined) storage.targetUserId = null;
        if (storage.status === undefined) storage.status = "Not following anyone";

        running = true;
        cache.clear();
        pendingFollowDest = null;
        lastAttemptChannel = null;

        startListening();
        injectProfileButton();

        log("Loaded");
    },

    onUnload() {
        running = false;
        pendingFollowDest = null;

        for (const unpatch of unpatches.splice(0).reverse()) {
            try {
                unpatch();
            } catch (error) {
                log(`Cleanup failed: ${String(error)}`);
            }
        }

        cache.clear();
        log("Unloaded");
    },

    settings: Settings,
};
