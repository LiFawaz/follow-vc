import { findByProps } from "@revenge-mod/modules/finders";
import React from "react";
import * as ReactNative from "react-native";

const CONNECT = 1n << 20n;
const MOVE_MEMBERS = 1n << 24n;
const unpatches: Array<() => void> = [];
const cache = new Map<string, any>();
let running = false;
let apiRef: any;
let lastTargetChannel: string | null = null;
let lastAttemptChannel: string | null = null;
let lastAttemptAt = 0;
let pendingChannel: string | null = null;

function log(message: string) {
    try { (apiRef?.logger ?? apiRef?.plugin?.logger)?.log?.(`[VC Follow] ${message}`); } catch {}
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
    } catch (error) { log(`Could not persist settings: ${String(error)}`); }
}
function probe(label: string, candidates: string[][]): any {
    if (cache.has(label)) return cache.get(label);
    for (const keys of candidates) {
        try {
            const found = findByProps(...keys);
            if (found) { cache.set(label, found); return found; }
        } catch {}
    }
    return null;
}
const users = () => probe("users", [["getCurrentUser", "getUser"], ["getCurrentUser"]]);
const voice = () => probe("voice", [["getVoiceStateForUser", "getVoiceStatesForChannel"], ["getVoiceStateForUser"], ["getAllVoiceStates"]]);
const channels = () => probe("channels", [["getChannel"]]);
const selected = () => probe("selected", [["getVoiceChannelId"], ["getCurrentVoiceChannelId"], ["getSelectedVoiceChannelId"]]);
const permissions = () => probe("permissions", [["can"]]);
const voiceActions = () => probe("voiceActions", [["selectVoiceChannel", "disconnect"], ["selectVoiceChannel"]]);

function ownId(): string | null {
    try { return users()?.getCurrentUser?.()?.id ?? null; } catch { return null; }
}
function username(id: string): string {
    try {
        const u = users()?.getUser?.(id);
        return u?.globalName ?? u?.displayName ?? u?.username ?? id;
    } catch { return id; }
}
function normalizeId(value: unknown): string | null {
    return /^(?:<@!?)?(\d{15,22})>?$/.exec(String(value ?? "").trim())?.[1] ?? null;
}
function getVoiceChannel(id: string): string | null {
    try {
        const s = voice();
        const direct = s?.getVoiceStateForUser?.(id);
        if (direct) return direct.channelId ?? direct.channel_id ?? null;
        const all = s?.getAllVoiceStates?.();
        if (all && typeof all === "object") {
            for (const group of Object.values(all) as any[]) {
                const item = group?.[id];
                if (item) return item.channelId ?? item.channel_id ?? null;
            }
        }
    } catch (error) { log(`Voice lookup failed: ${String(error)}`); }
    return null;
}
function ownVoiceChannel(): string | null {
    try {
        const s = selected();
        return s?.getVoiceChannelId?.() ?? s?.getCurrentVoiceChannelId?.() ?? s?.getSelectedVoiceChannelId?.() ?? null;
    } catch { return null; }
}
function setStatus(message: string) {
    const s = store();
    s.status = message;
    persist();
    log(message);
}
function canJoin(channel: any): boolean {
    try {
        const fn = permissions()?.can;
        if (!channel || typeof fn !== "function") return true;
        try { return !!fn(CONNECT, channel); }
        catch { return !!fn(Number(CONNECT), channel); }
    } catch { return true; }
}
function channelHasSpace(channel: any, channelId: string): boolean {
    const limit = Number(channel?.userLimit ?? channel?.user_limit ?? 0);
    if (!Number.isFinite(limit) || limit <= 0) return true;
    try {
        const states = voice()?.getVoiceStatesForChannel?.(channelId);
        if (!states || typeof states !== "object") return true;
        if (Object.keys(states).length < limit) return true;
        const fn = permissions()?.can;
        if (typeof fn === "function") {
            try { return !!fn(MOVE_MEMBERS, channel); } catch { return !!fn(Number(MOVE_MEMBERS), channel); }
        }
    } catch {}
    return false;
}
function moveTo(channelId: string, source: string) {
    const s = store();
    if (!running || !s.enabled || !s.targetUserId || !channelId) return;
    if (ownVoiceChannel() === channelId) {
        pendingChannel = null;
        setStatus(`Following ${username(String(s.targetUserId))} · already in their voice channel`);
        return;
    }
    if (lastAttemptChannel === channelId && Date.now() - lastAttemptAt < 2500) return;
    let channel: any = null;
    try { channel = channels()?.getChannel?.(channelId) ?? null; } catch {}
    if (channel && !canJoin(channel)) {
        pendingChannel = null;
        setStatus(`Can't join ${username(String(s.targetUserId))}'s voice channel: missing Connect permission`);
        return;
    }
    if (channel && !channelHasSpace(channel, channelId)) {
        pendingChannel = channelId;
        setStatus(`Following ${username(String(s.targetUserId))} · channel full, waiting for a slot`);
        return;
    }
    const actions = voiceActions();
    if (typeof actions?.selectVoiceChannel !== "function") {
        setStatus("Voice switching API unavailable on this client build");
        return;
    }
    lastAttemptChannel = channelId;
    lastAttemptAt = Date.now();
    pendingChannel = null;
    try {
        actions.selectVoiceChannel(channelId);
        setStatus(`Following ${username(String(s.targetUserId))} · joining voice channel`);
    } catch (error) { setStatus(`Join failed: ${String(error)}`); }
}
export function followUser(rawId: unknown): string {
    const id = normalizeId(rawId);
    const s = store();
    if (!id) return "Couldn't identify this user";
    if (id === ownId()) return "You can't follow yourself";
    if (s.enabled && String(s.targetUserId) === id) return stopFollowing();
    s.targetUserId = id;
    s.enabled = true;
    persist();
    pendingChannel = null;
    lastAttemptChannel = null;
    lastAttemptAt = 0;
    lastTargetChannel = getVoiceChannel(id);
    if (lastTargetChannel) moveTo(lastTargetChannel, "follow start");
    else setStatus(`Following ${username(id)} · waiting for them to join voice`);
    return `Following ${username(id)}`;
}
export function stopFollowing(): string {
    const s = store();
    const oldId = s.targetUserId;
    s.enabled = false;
    s.targetUserId = null;
    persist();
    pendingChannel = null;
    lastTargetChannel = null;
    lastAttemptChannel = null;
    lastAttemptAt = 0;
    const message = oldId ? `Stopped following ${username(String(oldId))}` : "Not following anyone";
    setStatus(message);
    return message;
}
function onVoiceUpdate(payload: any) {
    const s = store();
    if (!running || !s.enabled || !s.targetUserId || !payload) return;
    const updates = Array.isArray(payload.voiceStates) ? payload.voiceStates
        : Array.isArray(payload.voice_states) ? payload.voice_states
        : payload.voiceState ? [payload.voiceState]
        : payload.voice_state ? [payload.voice_state] : [payload];
    for (const state of updates) {
        if (!state) continue;
        const id = String(state.userId ?? state.user_id ?? state.user?.id ?? "");
        const channel = state.channelId ?? state.channel_id ?? null;
        if (id === String(s.targetUserId)) {
            if (channel === lastTargetChannel) continue;
            lastTargetChannel = channel;
            lastAttemptChannel = null;
            lastAttemptAt = 0;
            if (channel) moveTo(String(channel), "target moved");
            else setStatus(`Following ${username(String(s.targetUserId))} · waiting for them to rejoin voice`);
        }
    }
    if (pendingChannel) {
        const dest = channels()?.getChannel?.(pendingChannel);
        if (dest && channelHasSpace(dest, pendingChannel)) moveTo(pendingChannel, "capacity freed");
    }
}
function onVoiceStoreChanged() {
    const s = store();
    if (!running || !s.enabled || !s.targetUserId) return;
    const channel = getVoiceChannel(String(s.targetUserId));
    if (channel === lastTargetChannel) return;
    lastTargetChannel = channel;
    lastAttemptChannel = null;
    lastAttemptAt = 0;
    if (channel) moveTo(channel, "voice store changed");
    else setStatus(`Following ${username(String(s.targetUserId))} · waiting for them to rejoin voice`);
}
function profileButton(userId: string) {
    const s = store();
    const active = !!s.enabled && String(s.targetUserId) === userId;
    const label = active ? `Stop following ${username(userId)}` : "Follow this user";
    const onPress = () => {
        const message = active ? stopFollowing() : followUser(userId);
        log(`Profile button: ${message}`);
    };
    const R = React as any;
    const RN = ReactNative as any;
    return R.createElement(RN.TouchableOpacity, {
        key: "vc-follow-profile-toggle",
        onPress,
        accessibilityRole: "button",
        style: { paddingHorizontal: 16, paddingVertical: 13 },
    }, R.createElement(RN.Text, {
        style: { color: "#FFFFFF", fontSize: 16, fontWeight: "600" },
    }, label));
}
function patchProfileMenus() {
    const patcher = apiRef?.unscoped?.patcher;
    if (typeof patcher?.instead !== "function") {
        log("Profile menu patching API unavailable; profile toggle not installed");
        return;
    }
    const names = ["GuildMemberUserContextMenu", "UserContextMenu", "NativeUserContextMenu", "UserProfileBottomSheetContextMenu"];
    let patched = 0;
    for (const name of names) {
        const mod = probe("menu:" + name, [[name]]);
        if (!mod || typeof mod !== "object") continue;
        const key = typeof mod.default === "function" ? "default" : Object.keys(mod).find(k => typeof mod[k] === "function");
        if (!key) continue;
        try {
            const unpatch = patcher.instead(mod, key, (args: any[], original: (...a: any[]) => any) => {
                const result = original(...args);
                const props = args?.[0] ?? {};
                const id = normalizeId(props.userId ?? props.user?.id ?? props.member?.userId ?? props.member?.user?.id
                    ?? result?.props?.userId ?? result?.props?.user?.id);
                if (!id || id === ownId() || !result?.props) return result;
                const entry = profileButton(id);
                const children = result.props.children;
                return React.cloneElement(result, {}, ...(Array.isArray(children) ? [...children, entry] : children == null ? [entry] : [children, entry]));
            });
            if (typeof unpatch === "function") unpatches.push(unpatch);
            patched++;
            log(`Patched profile menu ${name}`);
        } catch (error) { log(`Could not patch ${name}: ${String(error)}`); }
    }
    if (!patched) log("No supported profile menu component found; use the plugin settings to follow by ID");
}
function startPlugin(api: any) {
    apiRef = api;
    running = true;
    cache.clear();
    const s = store();
    s.enabled ??= false;
    s.targetUserId ??= null;
    s.status ??= "Not following anyone";
    const dispatcher = probe("dispatcher", [["dispatch", "subscribe", "unsubscribe"], ["subscribe", "unsubscribe"]]);
    if (typeof dispatcher?.subscribe === "function") {
        for (const event of ["VOICE_STATE_UPDATES", "VOICE_STATE_UPDATE"]) {
            try {
                dispatcher.subscribe(event, onVoiceUpdate);
                unpatches.push(() => dispatcher.unsubscribe?.(event, onVoiceUpdate));
            } catch (error) { log(`Subscribe ${event} failed: ${String(error)}`); }
        }
    } else log("Voice event dispatcher unavailable");
    const voiceStore = voice();
    if (typeof voiceStore?.addChangeListener === "function") {
        try {
            voiceStore.addChangeListener(onVoiceStoreChanged);
            unpatches.push(() => voiceStore.removeChangeListener?.(onVoiceStoreChanged));
        } catch (error) { log(`Voice store listener failed: ${String(error)}`); }
    }
    patchProfileMenus();
    if (s.enabled && s.targetUserId) {
        lastTargetChannel = getVoiceChannel(String(s.targetUserId));
        if (lastTargetChannel) moveTo(lastTargetChannel, "resume");
    }
    log("Loaded");
}
function stopPlugin() {
    running = false;
    pendingChannel = null;
    for (const unpatch of unpatches.splice(0).reverse()) {
        try { unpatch(); } catch {}
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
    const text = (value: string, style: object = {}) => e(RN.Text, { style: { color: "#eeeeee", fontSize: 15, marginBottom: 10, ...style } }, value);
    const button = (label: string, onPress: () => void, color: string) => e(RN.TouchableOpacity, {
        onPress, style: { backgroundColor: color, padding: 12, borderRadius: 8, marginVertical: 6 },
    }, text(label, { color: "#ffffff", fontWeight: "bold", textAlign: "center", marginBottom: 0 }));
    return e(RN.ScrollView, { contentContainerStyle: { padding: 16 } },
        text("VC Follow", { fontSize: 22, fontWeight: "bold" }),
        text("Open a user's profile and tap Follow this user. Tap the same profile button again to stop. Following remains active until you stop or select someone else.", { color: "#cccccc", fontSize: 14 }),
        text(`Status: ${settings.status ?? "Not following anyone"}`, { color: settings.enabled ? "#57f287" : "#aaaaaa" }),
        text("Fallback: follow by Discord user ID", { fontWeight: "bold", fontSize: 16 }),
        e(RN.TextInput, { value: id, onChangeText: setId, keyboardType: "numeric", placeholder: "123456789012345678", placeholderTextColor: "#666666", style: { color: "#ffffff", backgroundColor: "#262932", borderRadius: 8, padding: 12, fontSize: 15 } }),
        button("Follow user", () => setResult(followUser(id)), "#5865F2"),
        button("Stop following", () => { setResult(stopFollowing()); }, "#42454c"),
        result ? text(result, { color: "#a1b4fc", marginTop: 8 }) : null
    );
}
export default plugin<{ jsonStorage: { enabled: boolean; targetUserId: string | null; status: string } }>({
    jsonStorage: { load: true, default: { enabled: false, targetUserId: null, status: "Not following anyone" } },
    start(api: any) { startPlugin(api); return stopPlugin; },
    SettingsComponent,
});
