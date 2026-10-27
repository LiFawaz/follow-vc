import { storage }                     from '@vendetta/plugin';
import { useProxy }                    from '@vendetta/storage';
import { React, ReactNative }          from '@vendetta/metro/common';
import { followUser, stopFollowing, setAutoUnmuteUndeafen } from './index';

export default function Settings() {
    useProxy(storage);
    const [id, setId]         = React.useState(String(storage.targetUserId ?? ''));
    const [result, setResult] = React.useState('');

    const e  = React.createElement;
    const RN = ReactNative as any;

    const Text = (text: string, extra: object = {}) =>
        e(RN.Text, {
            style: { color: '#eeeeee', fontSize: 15, marginBottom: 10, ...extra },
        }, text);

    const Button = (label: string, handler: () => void, color: string) =>
        e(RN.TouchableOpacity, {
            onPress: handler,
            style:   { backgroundColor: color, padding: 12, borderRadius: 8, marginVertical: 6 },
        }, Text(label, { color: '#fff', fontWeight: 'bold', textAlign: 'center', marginBottom: 0 }));

    return e(RN.ScrollView, { contentContainerStyle: { padding: 16 } },
        Text('VC Follow', { fontSize: 22, fontWeight: 'bold' }),
        Text(
            'Automatically follows a friend between voice channels — including across different ' +
            'servers. If the target VC is full, the plugin waits for a slot to open or for your ' +
            'friend to move to another channel. You do not need to be in a voice channel first.'
        ),
        Text(`Status: ${storage.status ?? 'Not following'}`),
        Text('Auto server unmute / undeafen', { fontSize: 17, fontWeight: 'bold', marginTop: 12 }),
        e(RN.View, {
            style: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 },
        },
            e(RN.View, { style: { flex: 1, paddingRight: 12 } },
                Text('Automatically remove server mute / deafen', { marginBottom: 4, fontWeight: '600' }),
                Text(
                    'When enabled, detects server mute/deafen applied to you and attempts to request removal if your permissions allow it. It never changes your normal client mute/deafen.',
                    { color: '#aaaaaa', fontSize: 13, marginBottom: 0 }
                )
            ),
            e(RN.Switch, {
                value: storage.autoUnmuteUndeafen === true,
                onValueChange: (value: boolean) => {
                    setAutoUnmuteUndeafen(value);
                    if (!value) storage.status = storage.status ?? 'Not following';
                    setResult(value ? 'Auto server unmute/undeafen enabled' : 'Auto server unmute/undeafen disabled');
                },
                trackColor: { false: '#555555', true: '#248046' },
                thumbColor: storage.autoUnmuteUndeafen === true ? '#d8ffe4' : '#eeeeee',
            })
        ),
        Text('Discord user ID'),
        e(RN.TextInput, {
            value: id, onChangeText: setId, keyboardType: 'numeric',
            placeholder: '123456789012345678', placeholderTextColor: '#aaaaaa',
            style: { color: '#fff', backgroundColor: '#262932', borderRadius: 8, padding: 12 },
        }),
        Button('Follow VC', () => setResult(followUser(id)), '#5865F2'),
        Button('Unfollow VC', () => { setResult(stopFollowing()); setId(''); }, '#42454c'),
        Text(result, { color: '#a1b4fc' }),
        Text('You can also long-press a user and choose “Follow this user”.', { color: '#aaaaaa', fontSize: 13 }),
    );
}
