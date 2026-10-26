import { storage }                   from "@vendetta/plugin";
import { useProxy }                   from "@vendetta/storage";
import { React, ReactNative }         from "@vendetta/metro/common";
import { followUser, stopFollowing }  from "./index";

export default function Settings() {
    useProxy(storage);
    const [id,     setId]     = React.useState(String(storage.targetUserId ?? ""));
    const [result, setResult] = React.useState("");

    const e  = React.createElement;
    const RN = ReactNative as any;

    const Text = (text: string, extra: object = {}) =>
        e(RN.Text, {
            style: { color: "#eeeeee", fontSize: 15, marginBottom: 10, ...extra },
        }, text);

    const Button = (label: string, handler: () => void, color: string) =>
        e(RN.TouchableOpacity, {
            onPress: handler,
            style:   { backgroundColor: color, padding: 12, borderRadius: 8, marginVertical: 6 },
        }, Text(label, { color: "#fff", fontWeight: "bold", textAlign: "center", marginBottom: 0 }));

    const isFollowing = Boolean(storage.enabled) && Boolean(storage.targetUserId);
    const statusColor = isFollowing ? "#57f287" : "#aaaaaa";

    return e(RN.ScrollView, { contentContainerStyle: { padding: 16 } },
        Text("VC Follow", { fontSize: 22, fontWeight: "bold", marginBottom: 4 }),
        Text(
            "Automatically follows a friend between voice channels — including across " +
            "different servers. Open any user's profile and press \"...\" to see the " +
            "Follow button. If the target VC is full the plugin waits for a slot to open " +
            "before joining. Following never stops unless you press Unfollow or switch targets.",
            { color: "#cccccc", fontSize: 14, marginBottom: 16 },
        ),

        // Status pill
        e(RN.View, {
            style: {
                backgroundColor: "#1e2024",
                borderRadius: 8,
                padding: 12,
                marginBottom: 16,
                borderLeftWidth: 3,
                borderLeftColor: statusColor,
            },
        },
            Text(
                `Status: ${storage.status ?? "Not following"}`,
                { color: statusColor, marginBottom: 0, fontSize: 14, fontFamily: "monospace" },
            ),
        ),

        Text("Follow by User ID", { fontWeight: "bold", fontSize: 16, marginBottom: 4 }),
        Text(
            "Alternatively, paste a user ID below (right-click any user → Copy User ID).",
            { color: "#aaaaaa", fontSize: 13 },
        ),
        e(RN.TextInput, {
            value:               id,
            onChangeText:        setId,
            keyboardType:        "numeric",
            placeholder:         "123456789012345678",
            placeholderTextColor: "#666666",
            style: {
                color:           "#ffffff",
                backgroundColor: "#262932",
                borderRadius:    8,
                padding:         12,
                fontSize:        15,
                marginBottom:    8,
            },
        }),

        Button(
            "Follow",
            () => { const r = followUser(id); setResult(r); },
            "#5865F2",
        ),
        Button(
            "Unfollow",
            () => { const r = stopFollowing(); setResult(r); setId(""); },
            "#42454c",
        ),

        result
            ? Text(result, { color: "#a1b4fc", marginTop: 8, fontStyle: "italic" })
            : null,

        Text(
            "Tip: long-press or tap \"...\" on any user's profile to use the inline Follow button.",
            { color: "#666666", fontSize: 12, marginTop: 16 },
        ),
    );
}
