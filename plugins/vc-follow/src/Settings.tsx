import { storage }                     from '@vendetta/plugin';
import { useProxy }                    from '@vendetta/storage';
import { React, ReactNative }          from '@vendetta/metro/common';
import { followUser, stopFollowing }   from './index';

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

        Text('Discord user ID'),
        e(RN.TextInput, {
            value:             id,
            onChangeText:      setId,
            keyboardType:      'numeric',
            placeholder:       '123456789012345678',
            placeholderTextColor: '#aaaaaa',
            style:             { color: '#fff', backgroundColor: '#262932', borderRadius: 8, padding: 12 },
        }),

        Button('Follow VC', () => setResult(followUser(id)), '#5865F2'),
        Button('Unfollow VC', () => { setResult(stopFollowing()); setId(''); }, '#42454c'),

        Text(result, { color: '#a1b4fc' }),
        Text(
            'Commands: /vcf <user_id> · /vcunf\n' +
            'Or long-press any username in chat → "Follow this user".',
            { color: '#aaaaaa', fontSize: 13 }
        ),
    );
}
