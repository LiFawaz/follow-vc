import { storage } from "@vendetta/plugin";
import { Forms } from "@vendetta/ui/components";
import { showToast } from "@vendetta/ui/toasts";
import { useProxy } from "@vendetta/storage";
import { setFakeDeafenEnabled } from "./index";

const { FormSwitchRow, FormText } = Forms;
export default function Settings() {
    useProxy(storage);
    storage.enabled ??= false; storage.fakeMute ??= true; storage.fakeDeafen ??= true;
    return (
        <>
            <FormSwitchRow label="Fake-deaf Active" subLabel="Your local mic/audio remain live; other users may see muted/deafened flags." value={storage.enabled}
                onValueChange={(v: boolean) => { setFakeDeafenEnabled(v); showToast(v ? "Fake-deaf enabled" : "Fake-deaf disabled"); }} />
            <FormSwitchRow label="Appear Muted" value={storage.fakeMute} onValueChange={(v: boolean) => { storage.fakeMute = v; }} />
            <FormSwitchRow label="Appear Deafened" value={storage.fakeDeafen} onValueChange={(v: boolean) => { storage.fakeDeafen = v; }} />
            <FormText>Toggle in settings or use /fake. Behavior depends on the Discord client and server; it is not a server mute/deafen bypass.</FormText>
        </>
    );
}
