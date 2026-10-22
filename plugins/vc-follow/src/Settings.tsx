import { storage } from '@vendetta/plugin';
import { useProxy } from '@vendetta/storage';
import { React, ReactNative } from '@vendetta/metro/common';
import { followUser, stopFollowing } from './index';

// Kept deliberately simple so it works on Discord builds without modern form APIs.
export default function Settings() {
    useProxy(storage);
    const [id, setId] = React.useState(String(storage.targetUserId ?? ''));
    const [result, setResult] = React.useState('');
    const e = React.createElement;
    const Text = (text: string, extra: object = {}) => e(ReactNative.Text, {
        style: { color: '#eeeeee', fontSize: 15, marginBottom: 10, ...extra },
    }, text);
    const Button = (text: string, handler: () => void, color: string) => e(ReactNative.TouchableOpacity, {
        onPress: handler,
        style: { backgroundColor: color, padding: 12, borderRadius: 8, marginVertical: 6 },
    }, Text(text, { color: '#fff', fontWeight: 'bold', textAlign: 'center', marginBottom: 0 }));
    return e(ReactNative.ScrollView, { contentContainerStyle: { padding: 16 } },
        Text('VC Follow', { fontSize: 22, fontWeight: 'bold' }),
        Text('Follow a friend automatically when they move to another voice channel in the same server. You must already be connected to a VC.'),
        Text(`Status: ${storage.status ?? 'Not following'}`),
        Text('Discord user ID'),
        e(ReactNative.TextInput, {
            value: id,
            onChangeText: setId,
            keyboardType: 'numeric',
            placeholder: '123456789012345678',
            placeholderTextColor: '#aaaaaa',
            style: { color: '#fff', backgroundColor: '#262932', borderRadius: 8, padding: 12 },
        }),
        Button('Follow VC', () => setResult(followUser(id)), '#5865F2'),
        Button('Unfollow VC', () => { setResult(stopFollowing()); setId(''); }, '#42454c'),
        Text(result, { color: '#a1b4fc' }),
        Text('Commands: /vcf @user and /vcunf. The optional profile button may not appear on all Discord versions.', { color: '#aaaaaa', fontSize: 13 }),
    );
}
