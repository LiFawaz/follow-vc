
import { logger } from "@vendetta";
import { findByProps, findByName } from "@vendetta/metro";
import { after } from "@vendetta/patcher";
import { storage } from "@vendetta/plugin";
import { registerCommand } from "@vendetta/commands";
import Settings from "./Settings";

const MENU_NAMES = [
    "UserProfileOverflowMenu",
    "BotUserProfileOverflowMenu",
];

const CONNECT = 1n << 20n;
const unpatches: Array<() => void> = [];
const cache = new Map<string, any>();

let running = false;
let lastTargetChannel: string | null = null;
let lastAttemptChannel: string | null = null;
let lastAttemptAt = 0;

function log(message: string): void {
    try {
        logger.log(`[VC Follow] ${message}`);
    } catch {}
}

function probe(label: string, candidates: string[][]): any {
    if (cache.has(label)) return cache.get(label);

    for (const keys of candidates) {
        try {
            const found = findByProps(...keys);
            if (found) {
                cache.set(label, found);
                return found;
            }
        } catch {}
    }

    return null;
}

function probeName(name: string): any {
    if (cache.has(name)) return cache.get(name);

    try {
        const found = findByName(name, false);
        if (found) {
            cache.set(name, found);
            return found;
        }
    } catch {}

    return null;
}

const users = () =>
    probe("users", [
        ["getCurrentUser", "getUser"],
        ["getCurrentUser"],
    ]);

const voice = () =>
    probe("voice", [
        ["getVoiceStateForUser", "getVoiceStatesForChannel"],
        ["getVoiceStateForUser"],
        ["getAllVoiceStates"],
    ]);

const channels = () => probe("channels", [["getChannel"]]);
const selected = () =>
    probe("selected", [
        ["getVoiceChannelId"],
        ["getCurrentVoiceChannelId"],
    ]);

const permissions = () => probe("permissions", [["can"]]);

const voiceActions = () =>
    probe("voiceActions", [
        ["selectVoiceChannel", "disconnect"],
        ["selectVoiceChannel"],
    ]);

function ownId(): string | null {
    try {
        return users()?.getCurrentUser?.()?.id ?? null;
    } catch {
        return null;
    }
}

function username(id: string): string {
    try {
        const user = users()?.getUser?.(id);
        return (
            user?.globalName ??
            user?.displayName ??
            user?.username ??
            id
        );
    } catch {
        return id;
    }
}

function normalizeId(value: unknown): string | null {
    const match = /^(?:<@!?)?(\d{15,22})>?$/.exec(
        String(value ?? "").trim()
    );

    return match?.[1] ?? null;
}

function getVoiceChannel(id: string): string | null {
    const store = voice();

    try {
        const state = store?.getVoiceStateForUser?.(id);

        if (state) {
            return state.channelId ?? state.channel_id ?? null;
        }

        const all = store?.getAllVoiceStates?.();

        if (all && typeof all === "object") {
            for (const group of Object.values(all) as any[]) {
                const state = group?.[id];

                if (state) {
                    return state.channelId ?? state.channel_id ?? null;
                }
            }
        }
    } catch (error) {
        log(`Voice lookup failed: ${String(error)}`);
    }

    return null;
}

function ownVoiceChannel(): string | null {
    try {
        const store = selected();

        return (
            store?.getVoiceChannelId?.() ??
            store?.getCurrentVoiceChannelId?.() ??
            null
        );
    } catch {
        return null;
    }
}

function canConnect(channel: any): boolean | null {
    try {
        const can = permissions()?.can;

        if (typeof can !== "function" || !channel) return null;

        try {
            return !!can(CONNECT, channel);
        } catch {
            return !!can(Number(CONNECT), channel);
        }
    } catch {
        return null;
    }
}

function setStatus(message: string): void {
    storage.status = message;
    log(message);
}

function moveTo(channelId: string, source: string): void {
    if (
        !running ||
        !storage.enabled ||
        !storage.targetUserId ||
        !channelId
    ) {
        return;
    }

    if (ownVoiceChannel() === channelId) {
        setStatus(
            `Already in ${username(String(storage.targetUserId))}'s voice channel`
        );
        return;
    }

    if (
        lastAttemptChannel === channelId &&
        Date.now() - lastAttemptAt < 2500
    ) {
        return;
    }

    let channel: any = null;

    try {
        channel = channels()?.getChannel?.(channelId) ?? null;
    } catch {}

    if (channel && canConnect(channel) === false) {
        setStatus("Can't join: missing permission to connect");
        return;
    }

    const api = voiceActions();

    if (typeof api?.selectVoiceChannel !== "function") {
        setStatus("Voice switching API not found on this Discord build");
        return;
    }

    lastAttemptChannel = channelId;
    lastAttemptAt = Date.now();

    try {
        api.selectVoiceChannel(channelId);
        setStatus(
            `Trying to join ${channel?.name ?? "target voice channel"} (${source})`
        );
    } catch (error) {
        setStatus(`Join failed: ${String(error)}`);
    }
}

export function followUser(rawId: unknown): string {
    const id = normalizeId(rawId);

    if (!id) return "Invalid Discord user ID";
    if (id === ownId()) return "You can't follow yourself";

    storage.targetUserId = id;
    storage.enabled = true;

    lastAttemptChannel = null;
    lastAttemptAt = 0;
    lastTargetChannel = getVoiceChannel(id);

    if (lastTargetChannel) {
        moveTo(lastTargetChannel, "follow start");
        return `Following ${username(id)}`;
    }

    setStatus(`Waiting for ${username(id)} to join voice`);

    return `Following ${username(id)}; waiting for voice`;
}

export function stopFollowing(): string {
    const oldId = storage.targetUserId;

    storage.enabled = false;
    storage.targetUserId = null;

    lastTargetChannel = null;
    lastAttemptChannel = null;
    lastAttemptAt = 0;

    const message = oldId
        ? `Stopped following ${username(String(oldId))}`
        : "Not following anyone";

    setStatus(message);
    return message;
}

function onVoiceUpdate(payload: any): void {
    if (!running || !storage.enabled || !storage.targetUserId || !payload) {
        return;
    }

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

        const id = String(state.userId ?? state.user_id ?? "");

        if (id !== String(storage.targetUserId)) continue;

        const next = state.channelId ?? state.channel_id ?? null;
        lastTargetChannel = next;

        if (next) {
            moveTo(String(next), "voice event");
        } else {
            setStatus("Target left voice; waiting for them to rejoin");
        }
    }
}

function findItems(result: any): any[] | null {
    const direct =
        result?.props?.items ??
        result?.props?.children?.props?.items;

    if (Array.isArray(direct) && Array.isArray(direct[0])) {
        return direct[0];
    }

    const stack = [result];
    const seen = new Set<any>();

    while (stack.length) {
        const node = stack.pop();

        if (!node || typeof node !== "object" || seen.has(node)) {
            continue;
        }

        seen.add(node);

        const items = node?.props?.items;

        if (Array.isArray(items) && Array.isArray(items[0])) {
            return items[0];
        }

        const children = node.props?.children;

        if (Array.isArray(children)) {
            stack.push(...children);
        } else if (children) {
            stack.push(children);
        }
    }

    return null;
}

function patchMenu(args: any[], result: any): void {
    if (!running || !result) return;

    const id = args?.[0]?.user?.id;

    if (!id || String(id) === ownId()) return;

    const items = findItems(result);

    if (!items) {
        log("Profile menu items not found");
        return;
    }

    const userId = String(id);
    const following =
        !!storage.enabled &&
        String(storage.targetUserId) === userId;

    const toggle = () => {
        if (
            storage.enabled &&
            String(storage.targetUserId) === userId
        ) {
            stopFollowing();
        } else {
            followUser(userId);
        }
    };

    const entry = {
        id: "vc-follow-profile",
        label: following ? "Unfollow VC" : "Follow VC",
        vcFollowAction: true,
        action: toggle,
        onPress: toggle,
    };

    const index = items.findIndex(
        (item: any) => item?.vcFollowAction === true
    );

    if (index >= 0) {
        items[index] = entry;
    } else {
        items.push(entry);
    }
}

function registerCommands(): void {
    if (typeof registerCommand !== "function") {
        log("Slash command API unavailable");
        return;
    }

    try {
        const unregister = registerCommand({
            name: "vcf",
            description: "Follow a user's voice channel",
            options: [
                {
                    name: "user",
                    description: "Discord user ID",
                    type: 3,
                    required: true,
                },
            ],
            execute: (args: any[]) => {
                const value = Array.isArray(args)
                    ? args.find((arg) => arg?.name === "user")?.value
                    : args?.user;

                const result = followUser(value);

                return {
                    content: result,
                    result,
                    send: false,
                };
            },
        } as any);

        if (typeof unregister === "function") {
            unpatches.push(unregister);
        }
    } catch (error) {
        log(`Could not register /vcf: ${String(error)}`);
    }

    try {
        const unregister = registerCommand({
            name: "vcunf",
            description: "Stop following a voice channel",
            options: [],
            execute: () => {
                const result = stopFollowing();

                return {
                    content: result,
                    result,
                    send: false,
                };
            },
        } as any);

        if (typeof unregister === "function") {
            unpatches.push(unregister);
        }
    } catch (error) {
        log(`Could not register /vcunf: ${String(error)}`);
    }
}

export default {
    onLoad() {
        if (storage.enabled === undefined) storage.enabled = false;
        if (storage.targetUserId === undefined) storage.targetUserId = null;
        if (storage.status === undefined) {
            storage.status = "Not following anyone";
        }

        running = true;
        cache.clear();

        registerCommands();

        const dispatcher = probe("dispatcher", [
            ["dispatch", "subscribe", "unsubscribe"],
            ["subscribe", "unsubscribe"],
        ]);

        if (typeof dispatcher?.subscribe === "function") {
            for (const event of [
                "VOICE_STATE_UPDATES",
                "VOICE_STATE_UPDATE",
            ]) {
                try {
                    dispatcher.subscribe(event, onVoiceUpdate);

                    unpatches.push(() => {
                        dispatcher.unsubscribe?.(event, onVoiceUpdate);
                    });
                } catch (error) {
                    log(`Could not subscribe to ${event}: ${String(error)}`);
                }
            }
        } else {
            log("Voice event dispatcher unavailable");
        }

        for (const name of MENU_NAMES) {
            const module = probeName(name);

            if (typeof module?.default !== "function") continue;

            try {
                const unpatch = after("default", module, patchMenu);

                if (typeof unpatch === "function") {
                    unpatches.push(unpatch);
                }
            } catch (error) {
                log(`Could not patch ${name}: ${String(error)}`);
            }
        }

        if (storage.enabled && storage.targetUserId) {
            const channel = getVoiceChannel(
                String(storage.targetUserId)
            );

            if (channel) {
                moveTo(channel, "resume");
            }
        }

        log("Loaded");
    },

    onUnload() {
        running = false;

        for (const unpatch of unpatches.splice(0).reverse()) {
            try {
                unpatch();
            } catch {}
        }

        cache.clear();
        log("Unloaded");
    },

    settings: Settings,
};
