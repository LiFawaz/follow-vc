
import { logger } from "@revenge-mod/core";
import { findByProps, findByName } from "@revenge-mod/metro";
import { after } from "@revenge-mod/patcher";

const MENU_NAMES = [
    "UserProfileOverflowMenu",
    "BotUserProfileOverflowMenu",
];

const CONNECT = 1n << 20n;
const unpatches: Array<() => void> = [];
const cache = new Map<string, any>();

let running = false;
let apiRef: any;
let lastTargetChannel: string | null = null;
let lastAttemptChannel: string | null = null;
let lastAttemptAt = 0;

function log(message: string) {
    try {
        apiRef?.logger?.log(`[VC Follow] ${message}`);
    } catch {}
}

function store() {
    return apiRef?.plugin?.storage ?? apiRef?.storage ?? {};
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

const users = () => probe("users", [
    ["getCurrentUser", "getUser"],
    ["getCurrentUser"],
]);

const voice = () => probe("voice", [
    ["getVoiceStateForUser", "getVoiceStatesForChannel"],
    ["getVoiceStateForUser"],
    ["getAllVoiceStates"],
]);

const channels = () => probe("channels", [["getChannel"]]);
const selected = () => probe("selected", [
    ["getVoiceChannelId"],
    ["getCurrentVoiceChannelId"],
]);
const permissions = () => probe("permissions", [["can"]]);
const voiceActions = () => probe("voiceActions", [
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
        return user?.globalName ?? user?.displayName ?? user?.username ?? id;
    } catch {
        return id;
    }
}

function normalizeId(value: unknown): string | null {
    return /^(?:<@!?)?(\d{15,22})>?$/
        .exec(String(value ?? "").trim())?.[1] ?? null;
}

function getVoiceChannel(id: string): string | null {
    try {
        const state = voice()?.getVoiceStateForUser?.(id);
        if (state) return state.channelId ?? state.channel_id ?? null;

        const all = voice()?.getAllVoiceStates?.();
        if (all && typeof all === "object") {
            for (const group of Object.values(all) as any[]) {
                const item = group?.[id];
                if (item) return item.channelId ?? item.channel_id ?? null;
            }
        }
    } catch (error) {
        log(`Voice lookup failed: ${String(error)}`);
    }

    return null;
}

function ownVoiceChannel(): string | null {
    try {
        return selected()?.getVoiceChannelId?.()
            ?? selected()?.getCurrentVoiceChannelId?.()
            ?? null;
    } catch {
        return null;
    }
}

function setStatus(message: string) {
    const s = store();
    s.status = message;
    log(message);
}

function moveTo(channelId: string, source: string) {
    const s = store();

    if (!running || !s.enabled || !s.targetUserId || !channelId) return;

    if (ownVoiceChannel() === channelId) {
        setStatus(`Already in ${username(String(s.targetUserId))}'s voice channel`);
        return;
    }

    if (lastAttemptChannel === channelId && Date.now() - lastAttemptAt < 2500) return;

    let channel: any = null;
    try {
        channel = channels()?.getChannel?.(channelId) ?? null;
    } catch {}

    try {
        const can = permissions()?.can;
        if (channel && typeof can === "function") {
            let allowed = false;
            try {
                allowed = !!can(CONNECT, channel);
            } catch {
                allowed = !!can(Number(CONNECT), channel);
            }

            if (!allowed) {
                setStatus("Can't join: missing permission to connect");
                return;
            }
        }
    } catch {}

    const actions = voiceActions();
    if (typeof actions?.selectVoiceChannel !== "function") {
        setStatus("Voice switching API not found on this Discord build");
        return;
    }

    lastAttemptChannel = channelId;
    lastAttemptAt = Date.now();

    try {
        actions.selectVoiceChannel(channelId);
        setStatus(`Trying to join ${channel?.name ?? "target voice channel"} (${source})`);
    } catch (error) {
        setStatus(`Join failed: ${String(error)}`);
    }
}

export function followUser(rawId: unknown): string {
    const id = normalizeId(rawId);
    const s = store();

    if (!id) return "Invalid Discord user ID";
    if (id === ownId()) return "You can't follow yourself";

    s.targetUserId = id;
    s.enabled = true;
    lastAttemptChannel = null;
    lastAttemptAt = 0;
    lastTargetChannel = getVoiceChannel(id);

    if (lastTargetChannel) moveTo(lastTargetChannel, "follow start");
    else setStatus(`Waiting for ${username(id)} to join voice`);

    return lastTargetChannel
        ? `Following ${username(id)}`
        : `Following ${username(id)}; waiting for voice`;
}

export function stopFollowing(): string {
    const s = store();
    const oldId = s.targetUserId;

    s.enabled = false;
    s.targetUserId = null;
    lastTargetChannel = null;
    lastAttemptChannel = null;
    lastAttemptAt = 0;

    const message = oldId
        ? `Stopped following ${username(String(oldId))}`
        : "Not following anyone";

    setStatus(message);
    return message;
}

function onVoiceUpdate(payload: any) {
    const s = store();
    if (!running || !s.enabled || !s.targetUserId || !payload) return;

    const updates = Array.isArray(payload.voiceStates) ? payload.voiceStates
        : Array.isArray(payload.voice_states) ? payload.voice_states
        : payload.voiceState ? [payload.voiceState]
        : payload.voice_state ? [payload.voice_state]
        : [payload];

    for (const state of updates) {
        if (!state) continue;

        const id = String(state.userId ?? state.user_id ?? "");
        if (id !== String(s.targetUserId)) continue;

        const next = state.channelId ?? state.channel_id ?? null;
        lastTargetChannel = next;

        if (next) moveTo(String(next), "voice event");
        else setStatus("Target left voice; waiting for them to rejoin");
    }
}

function findItems(result: any): any[] | null {
    const direct = result?.props?.items ?? result?.props?.children?.props?.items;
    if (Array.isArray(direct) && Array.isArray(direct[0])) return direct[0];

    const stack = [result];
    const seen = new Set<any>();

    while (stack.length) {
        const node = stack.pop();
        if (!node || typeof node !== "object" || seen.has(node)) continue;
        seen.add(node);

        const items = node?.props?.items;
        if (Array.isArray(items) && Array.isArray(items[0])) return items[0];

        const children = node.props?.children;
        if (Array.isArray(children)) stack.push(...children);
        else if (children) stack.push(children);
    }

    return null;
}

function patchMenu(args: any[], result: any) {
    const s = store();
    if (!running || !result) return;

    const id = args?.[0]?.user?.id;
    if (!id || String(id) === ownId()) return;

    const items = findItems(result);
    if (!items) return;

    const userId = String(id);
    const following = !!s.enabled && String(s.targetUserId) === userId;

    const toggle = () => {
        if (s.enabled && String(s.targetUserId) === userId) stopFollowing();
        else followUser(userId);
    };

    const entry = {
        id: "vc-follow-profile",
        label: following ? "Unfollow VC" : "Follow VC",
        vcFollowAction: true,
        action: toggle,
        onPress: toggle,
    };

    const index = items.findIndex((item: any) => item?.vcFollowAction === true);
    if (index >= 0) items[index] = entry;
    else items.push(entry);
}

function registerCommands() {
    const commands = probe("commands", [["registerCommand"]]);
    if (typeof commands?.registerCommand !== "function") {
        log("Slash command API unavailable");
        return;
    }

    for (const command of [
        {
            name: "vcf",
            description: "Follow a user's voice channel",
            options: [{ name: "user", description: "Discord user ID", type: 3, required: true }],
            execute: (args: any) => {
                const value = Array.isArray(args)
                    ? args.find((arg: any) => arg?.name === "user")?.value
                    : args?.user;
                return { content: followUser(value), send: false };
            },
        },
        {
            name: "vcunf",
            description: "Stop following a voice channel",
            options: [],
            execute: () => ({ content: stopFollowing(), send: false }),
        },
    ]) {
        try {
            const unregister = commands.registerCommand(command);
            if (typeof unregister === "function") unpatches.push(unregister);
        } catch (error) {
            log(`Command registration failed: ${String(error)}`);
        }
    }
}

function startPlugin(api: any) {
    apiRef = api;
    running = true;
    cache.clear();

    const s = store();
    if (s.enabled === undefined) s.enabled = false;
    if (s.targetUserId === undefined) s.targetUserId = null;
    if (s.status === undefined) s.status = "Not following anyone";

    registerCommands();

    const dispatcher = probe("dispatcher", [
        ["dispatch", "subscribe", "unsubscribe"],
        ["subscribe", "unsubscribe"],
    ]);

    if (typeof dispatcher?.subscribe === "function") {
        for (const event of ["VOICE_STATE_UPDATES", "VOICE_STATE_UPDATE"]) {
            try {
                dispatcher.subscribe(event, onVoiceUpdate);
                unpatches.push(() => dispatcher.unsubscribe?.(event, onVoiceUpdate));
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
            if (typeof unpatch === "function") unpatches.push(unpatch);
        } catch (error) {
            log(`Could not patch ${name}: ${String(error)}`);
        }
    }

    if (s.enabled && s.targetUserId) {
        const channel = getVoiceChannel(String(s.targetUserId));
        if (channel) moveTo(channel, "resume");
    }

    log("Loaded");
}

function stopPlugin() {
    running = false;

    for (const unpatch of unpatches.splice(0).reverse()) {
        try {
            unpatch();
        } catch {}
    }

    cache.clear();
    log("Unloaded");
}

export default plugin({
    start(api: any) {
        startPlugin(api);
        return stopPlugin;
    },
});
