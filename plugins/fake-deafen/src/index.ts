import { logger } from "@vendetta";
import { findByProps } from "@vendetta/metro";
import { registerCommand } from "@vendetta/commands";
import { storage } from "@vendetta/plugin";
import Settings from "./Settings";

let originalSend: any = null;
let unregisterCommand: (() => void) | null = null;
let patchedSocket: any = null;

function probe(candidates: string[][]): any {
    for (const props of candidates) {
        try { const mod = findByProps(...props); if (mod) return mod; } catch (_) {}
    }
    return null;
}
function gateway() { return probe([["getSocket"], ["getSocketProxy"], ["gatewaySocket"], ["socket", "send"]]); }
function voiceStore() { return probe([["getVoiceChannelId"], ["getCurrentVoiceChannelId"], ["getSelectedVoiceChannelId"]]); }
function channelStore() { return probe([["getChannel", "getDMFromUserId"], ["getChannel"]]); }
function mediaStore() { return probe([["isSelfMute", "isSelfDeaf"], ["isMute", "isDeaf"], ["isLocalMute", "isLocalDeaf"]]); }

function pushVoiceState() {
    const ws = gateway();
    const store = voiceStore();
    const socket = ws?.getSocket?.();
    const channelId = store?.getVoiceChannelId?.() ?? store?.getCurrentVoiceChannelId?.() ?? store?.getSelectedVoiceChannelId?.();
    if (!socket || !channelId) { logger.log("[Fake-deaf] Join a voice channel first, then toggle Fake-deaf."); return; }
    const channel = channelStore()?.getChannel?.(channelId);
    const media = mediaStore();
    const realMute = !!(media?.isSelfMute?.() ?? media?.isMute?.() ?? media?.isLocalMute?.() ?? false);
    const realDeaf = !!(media?.isSelfDeaf?.() ?? media?.isDeaf?.() ?? media?.isLocalDeaf?.() ?? false);
    socket.send(4, {
        guild_id: channel?.guild_id ?? channel?.guildId ?? null,
        channel_id: channelId,
        self_mute: (!!storage.enabled && !!storage.fakeMute) || realMute,
        self_deaf: (!!storage.enabled && !!storage.fakeDeafen) || realDeaf,
        self_video: false,
        flags: 0,
    });
}
function patchSocket() {
    const socket = gateway()?.getSocket?.();
    if (!socket || typeof socket.send !== "function" || socket === patchedSocket) return;
    patchedSocket = socket;
    originalSend = socket.send;
    socket.send = function(op: number, data: any, ...args: any[]) {
        if (op === 4 && storage.enabled && data) {
            if (storage.fakeMute) data.self_mute = true;
            if (storage.fakeDeafen) data.self_deaf = true;
        }
        return originalSend.apply(this, [op, data, ...args]);
    };
}
function unpatchSocket() {
    if (patchedSocket && originalSend && patchedSocket.send) patchedSocket.send = originalSend;
    patchedSocket = null; originalSend = null;
}
export function setFakeDeafenEnabled(enabled: boolean) {
    storage.enabled = enabled;
    patchSocket();
    pushVoiceState();
}
function toggle() {
    setFakeDeafenEnabled(!storage.enabled);
    return storage.enabled ? "Fake-deaf ON." : "Fake-deaf OFF.";
}
export default {
    onLoad() {
        storage.enabled ??= false; storage.fakeMute ??= true; storage.fakeDeafen ??= true;
        patchSocket();
        unregisterCommand = registerCommand({
            name: "fake", displayName: "fake", description: "Toggle Fake-deaf",
            displayDescription: "Toggle Fake-deaf", options: [], applicationId: "-1",
            inputType: 1, type: 1,
            execute: () => ({send: false, result: toggle()}),
        });
        logger.log("[Fake-deaf] Loaded.");
    },
    onUnload() {
        unpatchSocket(); storage.enabled = false;
        unregisterCommand?.(); unregisterCommand = null;
    },
    settings: Settings,
};
