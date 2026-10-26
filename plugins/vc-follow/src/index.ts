
import { findByProps } from "@revenge-mod/modules/finders";
import React from "react";
import * as ReactNative from "react-native";

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
        (apiRef?.logger ?? apiRef?.plugin?.logger)?.log?.(`[VC Follow] ${message}`);
    } catch {}
}

function store() {
    return apiRef?.jsonStorage?.cache ?? apiRef?.storage?.cache ?? apiRef?.plugin?.storage?.cache ?? {};
}

function persist() {
    try {
        const value = { ...store() };
        if (typeof apiRef?.jsonStorage?.set === "function") apiRef.jsonStorage.set(value);
        else if (typeof apiRef?.storage?.set === "function") apiRef.storage.set(value);
        else if (typeof apiRef?.plugin?.storage?.set === "function") apiRef.plugin.storage.set(value);
    } catch (error) {
        log(`Could not persist settings: ${String(error)}`);
    }
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
    persist();
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
    persist();
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
    persist();
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

function registerCommands() {
    // Revenge Next exposes commands under api.api.commands; older builds may expose them directly.
    const commands = apiRef?.api?.commands ?? apiRef?.commands ?? probe("commands", [["registerCommand"]]);
    const register = commands?.registerCommand;
    if (typeof register !== "function") {
        log("Command API unavailable. Use plugin settings to follow by ID.");
        return;
    }

    const follow = (...args: any[]) => {
        const raw = args.length > 1 ? args[1] : args[0];
        const value = Array.isArray(raw)
            ? raw.find((arg: any) => arg?.name === "user" || arg?.name === "id")?.value ?? raw[0]?.value
            : raw?.user ?? raw?.id ?? raw?.options?.user ?? raw?.options?.id ?? raw;
        return { content: followUser(value), send: false };
    };
    const unfollow = () => ({ content: stopFollowing(), send: false });

    for (const [name, description, execute] of [
        ["vcf", "Follow a user voice channel by Discord user ID", follow],
        ["vcunf", "Stop following the current user", unfollow],
    ] as [string, string, (...args: any[]) => any][]) {
        try {
            let unregister: any;
            if (register.length >= 2) unregister = register.call(commands, name, description, execute);
            else unregister = register.call(commands, { name, description, options: name === "vcf" ? [{ name: "user", description: "Discord user ID", type: 3, required: true }] : [], execute });
            if (typeof unregister === "function") unpatches.push(unregister);
            log("Registered command /" + name);
        } catch (error) {
            log("Command registration failed for /" + name + ": " + String(error));
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

function SettingsComponent({ api }: { api: any }) {
    const settings = api?.jsonStorage?.use?.() ?? api?.storage?.use?.() ?? {};
    const [id, setId] = React.useState(String(settings.targetUserId ?? ""));
    const [result, setResult] = React.useState("");
    const RN = ReactNative as any;
    const e = React.createElement;

    const text = (value: string, style: object = {}) =>
        e(RN.Text, { style: { color: "#eeeeee", fontSize: 15, marginBottom: 10, ...style } }, value);
    const button = (label: string, onPress: () => void, color: string) =>
        e(RN.TouchableOpacity, {
            onPress,
            style: { backgroundColor: color, padding: 12, borderRadius: 8, marginVertical: 6 },
        }, text(label, { color: "#ffffff", fontWeight: "bold", textAlign: "center", marginBottom: 0 }));

    return e(RN.ScrollView, { contentContainerStyle: { padding: 16 } },
        text("VC Follow", { fontSize: 22, fontWeight: "bold" }),
        text("Enter a Discord user ID and tap Follow. The /vcf and /vcunf commands register when supported by this Revenge build. Cross-server following depends on voice-state visibility and channel permissions.", { color: "#cccccc", fontSize: 14 }),
        text(`Status: ${settings.status ?? "Not following anyone"}`, { color: settings.enabled ? "#57f287" : "#aaaaaa" }),
        text("Follow by User ID", { fontWeight: "bold", fontSize: 16 }),
        e(RN.TextInput, {
            value: id,
            onChangeText: setId,
            keyboardType: "numeric",
            placeholder: "123456789012345678",
            placeholderTextColor: "#666666",
            style: { color: "#ffffff", backgroundColor: "#262932", borderRadius: 8, padding: 12, fontSize: 15 },
        }),
        button("Follow", () => setResult(followUser(id)), "#5865F2"),
        button("Unfollow", () => { setResult(stopFollowing()); setId(""); }, "#42454c"),
        result ? text(result, { color: "#a1b4fc", marginTop: 8 }) : null
    );
}

export default plugin<{ jsonStorage: { enabled: boolean; targetUserId: string | null; status: string } }>({
    jsonStorage: {
        load: true,
        default: { enabled: false, targetUserId: null, status: "Not following anyone" },
    },
    start(api: any) {
        startPlugin(api);
        return stopPlugin;
    },
    SettingsComponent,
});
