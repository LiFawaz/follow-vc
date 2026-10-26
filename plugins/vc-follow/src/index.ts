/* ═══════════════════════════════════════════════════════════════════════════
   VC Follow  v1.1.0  —  Revenge Next (format: 1)

   FEATURES
   ─────────
   ▸ "Follow VC" button on every user's ··· overflow menu
       • Shows "📡 Follow VC" when idle
       • Shows "✅ Following [name]  · tap to unfollow" while following
       • Tapping on a DIFFERENT user's profile switches the follow target
   ▸ Follows forever until YOU stop it (no auto-stop)
   ▸ Retries every 3 s when the target's channel is full
   ▸ Persists across plugin reloads — remembers who you're following
   ▸ Settings page shows live status + Stop button
   ▸ No slash commands (removed — profile button replaces them)
   ═══════════════════════════════════════════════════════════════════════════ */


// ─────────────────────────────────────────────────────────────────────────────
//  API SHIM
//  Normalises differences between Revenge Next builds.
//  Tries several known global namespaces so the plugin works across versions.
// ─────────────────────────────────────────────────────────────────────────────

const _metro = (
  globalThis.Revenge?.Metro   ??
  globalThis.revenge?.metro   ??
  globalThis.vendetta?.metro  ??
  { findByProps: () => null, findByDisplayName: () => null, findByStoreName: () => null }
);

const _patcher = (
  globalThis.Revenge?.Patcher  ??
  globalThis.revenge?.patcher  ??
  globalThis.vendetta?.patcher ??
  { after: () => () => {}, before: () => () => {} }
);

const _React = (
  globalThis.React ??
  _metro.findByProps?.('createElement', 'useState', 'useEffect') ??
  null
);

const _RN = (
  globalThis.ReactNative ??
  _metro.findByProps?.('View', 'Text', 'StyleSheet', 'TouchableOpacity') ??
  null
);


// ─────────────────────────────────────────────────────────────────────────────
//  SAFE HELPERS
// ─────────────────────────────────────────────────────────────────────────────

/** Find a Discord webpack module by property names. Returns null on failure. */
function fP(...props) {
  try { return _metro.findByProps?.(...props) ?? null; }
  catch { return null; }
}

/** Find a Discord webpack module by its React display name. */
function fN(name) {
  try { return _metro.findByDisplayName?.(name, false) ?? null; }
  catch { return null; }
}

/** Find a Flux store by name. */
function fS(name) {
  try { return _metro.findByStoreName?.(name) ?? null; }
  catch { return null; }
}

/**
 * Patch `module[key]` with an `after` hook.
 * Handles both (args, result) and (ctx, args, result) callback signatures.
 * Returns a cleanup function.
 */
function afterPatch(module, key, fn) {
  if (!module || !key || !_patcher?.after) return () => {};
  try {
    // Wrap to normalise argument ordering across Revenge builds
    const cleanup = _patcher.after(module, key, function () {
      const all    = Array.from(arguments);
      // Some builds pass (ctx, args, result), others (args, result)
      const result = all[all.length - 1];
      const args   = all.length >= 3 ? all[1] : all[0];
      return fn(Array.isArray(args) ? args : [args], result);
    });
    return typeof cleanup === 'function' ? cleanup : () => {};
  } catch (e) {
    console.warn('[VCFollow] afterPatch failed for key:', key, e?.message);
    return () => {};
  }
}


// ─────────────────────────────────────────────────────────────────────────────
//  DISCORD MODULE HANDLES   (filled in onLoad)
// ─────────────────────────────────────────────────────────────────────────────

let FluxDispatcher  = null;  // event bus
let VoiceStateStore = null;  // who is in which channel
let ChannelStore    = null;  // channel metadata (userLimit, etc.)
let VoiceActions    = null;  // selectVoiceChannel()
let Storage         = null;  // persistent key-value storage


// ─────────────────────────────────────────────────────────────────────────────
//  PLUGIN STATE
// ─────────────────────────────────────────────────────────────────────────────

let g_followId   = null;   // Discord user ID we are following
let g_followName = null;   // their display name (for the UI)
let g_retryId    = null;   // channelId we are waiting to join (channel full)
let g_retryTimer = null;   // setInterval handle for the retry loop
const g_cleanups = [];     // patcher cleanup callbacks


// ─────────────────────────────────────────────────────────────────────────────
//  PERSISTENCE
//  Survive plugin disable / re-enable and Discord restarts.
// ─────────────────────────────────────────────────────────────────────────────

const STORAGE_KEY = '@vcfollow/v1';

function saveState() {
  try {
    if (!Storage) return;
    const data = JSON.stringify({ id: g_followId ?? '', name: g_followName ?? '' });
    // Handle both React Native AsyncStorage (setItem) and simple sync stores (set)
    if (Storage.setItem)      Storage.setItem(STORAGE_KEY, data);
    else if (Storage.set)     Storage.set(STORAGE_KEY, data);
  } catch {}
}

function loadState() {
  try {
    if (!Storage) return;
    const raw = Storage.getItem
      ? Storage.getItem(STORAGE_KEY)
      : Storage.get?.(STORAGE_KEY) ?? null;

    const handle = (val) => {
      if (!val) return;
      try {
        const parsed = JSON.parse(val);
        if (parsed?.id) {
          g_followId   = parsed.id;
          g_followName = parsed.name ?? parsed.id;
        }
      } catch {}
    };

    // AsyncStorage returns a Promise; sync stores return the value directly
    if (raw && typeof raw.then === 'function') raw.then(handle);
    else handle(raw);
  } catch {}
}


// ─────────────────────────────────────────────────────────────────────────────
//  VOICE CHANNEL HELPERS
// ─────────────────────────────────────────────────────────────────────────────

/** Returns true if the channel is at its user limit. */
function channelIsFull(channelId) {
  if (!VoiceStateStore || !ChannelStore) return false;
  const ch    = ChannelStore.getChannel?.(channelId);
  const limit = ch?.userLimit ?? 0;
  if (limit === 0) return false;                          // 0 = unlimited
  const states = VoiceStateStore.getVoiceStatesForChannel?.(channelId) ?? {};
  return Object.keys(states).length >= limit;
}

/**
 * Attempt to join a voice channel.
 * Returns true on success, false if full or the API is unavailable.
 */
function tryJoin(channelId) {
  if (!VoiceActions?.selectVoiceChannel) return false;
  if (channelIsFull(channelId))          return false;
  try {
    VoiceActions.selectVoiceChannel(channelId);
    return true;
  } catch {
    return false;
  }
}


// ─────────────────────────────────────────────────────────────────────────────
//  RETRY LOOP
//  When the target's channel is full, poll every 3 s until a slot opens.
// ─────────────────────────────────────────────────────────────────────────────

function stopRetry() {
  if (g_retryTimer) { clearInterval(g_retryTimer); g_retryTimer = null; }
  g_retryId = null;
}

function startRetry(channelId) {
  stopRetry();
  g_retryId    = channelId;
  g_retryTimer = setInterval(() => {
    if (!g_retryId)            return stopRetry();
    if (tryJoin(g_retryId))    stopRetry();          // slot opened — joined!
    // else: still full, keep waiting silently
  }, 3000);
}


// ─────────────────────────────────────────────────────────────────────────────
//  FOLLOW / UNFOLLOW  PUBLIC API
// ─────────────────────────────────────────────────────────────────────────────

function followUser(userId, displayName) {
  stopRetry();
  g_followId   = userId;
  g_followName = displayName ?? userId;
  saveState();

  // Jump in immediately if they're already in a VC
  const vs = VoiceStateStore?.getVoiceStateForUser?.(userId);
  if (vs?.channelId) {
    if (!tryJoin(vs.channelId)) startRetry(vs.channelId);
  }
}

function unfollowUser() {
  stopRetry();
  g_followId   = null;
  g_followName = null;
  saveState();
}


// ─────────────────────────────────────────────────────────────────────────────
//  VOICE STATE EVENT LISTENER
//  Fires whenever any user moves between voice channels.
// ─────────────────────────────────────────────────────────────────────────────

function onVoiceStateUpdate(event) {
  if (!g_followId)               return;  // not following anyone
  if (event?.userId !== g_followId) return;  // not our target
  stopRetry();

  const targetChannelId = event?.channelId;
  if (!targetChannelId)  return;  // they left VC entirely — keep following, do nothing

  if (!tryJoin(targetChannelId)) startRetry(targetChannelId);
}


// ─────────────────────────────────────────────────────────────────────────────
//  PROFILE OVERFLOW MENU BUTTON
//
//  Discord mobile shows a ··· bottom sheet when you tap the three-dot button
//  on a user's profile card.  We patch whichever component renders those
//  action items and inject a "Follow VC" row at the top.
//
//  The component name differs across Discord builds, so we try a list of
//  known names in order, then fall back to a prop-based search.
// ─────────────────────────────────────────────────────────────────────────────

/** Build the action item object for the sheet */
function buildFollowItem(userId, username) {
  const isFollowing = g_followId === userId;
  return {
    label: isFollowing
      ? `✅ Following ${g_followName ?? username}  ·  tap to unfollow`
      : '📡 Follow VC',
    action() {
      if (isFollowing) unfollowUser();
      else             followUser(userId, username);
    },
    // Destructive styling only for the unfollow state? — leave normal
    destructive: false,
  };
}

/** Inject our item into the React element returned by the menu component */
function injectFollowItem(element, userId, username) {
  if (!element?.props) return;
  const item = buildFollowItem(userId, username);

  // Layout A: sections[0].items  (modern Discord mobile)
  const sections = element.props.sections;
  if (Array.isArray(sections) && sections.length > 0) {
    const sec = sections[0];
    if (!Array.isArray(sec.items)) sec.items = [];
    sec.items.unshift(item);
    return;
  }

  // Layout B: flat items array
  if (Array.isArray(element.props.items)) {
    element.props.items = [item, ...element.props.items];
    return;
  }

  // Layout C: children array (less common, but possible)
  if (Array.isArray(element.props.children)) {
    // We can't easily inject a native-sheet item here without knowing
    // the exact child component type — log and bail
    console.warn('[VCFollow] Unknown action sheet layout — profile button unavailable');
  }
}

function patchProfileMenu() {
  // ── Step 1: find the component ─────────────────────────────────────────
  const componentNames = [
    'UserProfileOverflowMenu',
    'UserContextMenu',
    'LongPressActionSheet',
    'UserProfileContextMenu',
    'OverflowMenu',
    'UserOverflowMenu',
  ];

  let host = null;
  for (const name of componentNames) {
    host = fN(name);
    if (host) break;
  }

  // Fallback: find by prop signature
  if (!host) host = fP('renderOverflowMenuItems', 'userId');
  if (!host) host = fP('openUserContextMenu');

  if (!host) {
    console.warn('[VCFollow] Profile menu component not found — profile button unavailable. Use the Settings screen instead.');
    return;
  }

  // ── Step 2: patch it ───────────────────────────────────────────────────
  const cleanup = afterPatch(host, 'default', (args, res) => {
    if (!res) return res;

    const props    = args?.[0] ?? {};
    const userId   = props.userId ?? props.user?.id;
    if (!userId) return res;

    const username = props.user?.global_name
                  ?? props.user?.username
                  ?? props.username
                  ?? userId;

    injectFollowItem(res, userId, username);
    return res;
  });

  g_cleanups.push(cleanup);
  console.log('[VCFollow] Profile button patched successfully');
}


// ─────────────────────────────────────────────────────────────────────────────
//  SETTINGS SCREEN
//  Shows: current follow status, retry warning, Stop button, how-to hint.
// ─────────────────────────────────────────────────────────────────────────────

function SettingsScreen() {
  if (!_React || !_RN) return null;

  const { View, Text, TouchableOpacity, ScrollView, StyleSheet } = _RN;
  const E = _React.createElement;
  const [, bump] = _React.useState(0);
  const refresh  = () => bump(n => n + 1);

  // ── Colour tokens ────────────────────────────────────────────────────────
  const C = {
    bg:    '#1e1f22',
    card:  '#2b2d31',
    divid: '#3f4147',
    muted: '#b5bac1',
    white: '#ffffff',
    faint: '#4e5058',
    blue:  '#5865f2',
    red:   '#ed4245',
    green: '#3ba55c',
    amber: '#faa61a',
  };

  const S = StyleSheet.create({
    root:    { flex: 1, backgroundColor: C.bg },
    scroll:  { paddingHorizontal: 16, paddingTop: 20, paddingBottom: 48 },
    card:    { backgroundColor: C.card, borderRadius: 14, padding: 18, marginBottom: 12 },
    bigHead: { color: C.white, fontSize: 22, fontWeight: '800', marginBottom: 4 },
    sub:     { color: C.muted, fontSize: 13, lineHeight: 20 },
    secLabel:{ color: C.faint, fontSize: 11, fontWeight: '700', letterSpacing: 1.2,
               textTransform: 'uppercase', marginBottom: 8 },
    row:     { flexDirection: 'row', alignItems: 'center', gap: 10 },
    dot:     { width: 10, height: 10, borderRadius: 5 },
    statusTx:{ color: C.white, fontSize: 16, fontWeight: '600', flex: 1 },
    btn:     { borderRadius: 12, paddingVertical: 15, alignItems: 'center', marginBottom: 8 },
    btnTx:   { color: C.white, fontSize: 15, fontWeight: '700', letterSpacing: 0.3 },
    warn:    { backgroundColor: C.amber + '20', borderRadius: 12, padding: 14, marginBottom: 12 },
    warnTx:  { color: C.amber, fontSize: 13, lineHeight: 20 },
    hintBox: { borderWidth: 1, borderColor: C.divid, borderRadius: 12, padding: 16,
               marginBottom: 12, alignItems: 'center' },
    hintTx:  { color: C.muted, fontSize: 13, textAlign: 'center', lineHeight: 20 },
  });

  const following = !!g_followId;
  const retrying  = !!g_retryId;

  return E(ScrollView, { style: S.root, contentContainerStyle: S.scroll },

    // ── Header ─────────────────────────────────────────────────────────────
    E(View, { style: S.card },
      E(Text, { style: S.bigHead }, '📡  VC Follow'),
      E(Text, { style: S.sub },
        'Tap the ··· button on any Discord user\'s profile,\nthen tap 📡 Follow VC to start.\n\nFollows forever — retries when a channel is full.\nTap the button again on their profile to stop, or use the button below.'),
    ),

    // ── Status card ─────────────────────────────────────────────────────────
    E(View, { style: S.card },
      E(Text, { style: S.secLabel }, 'Status'),
      E(View, { style: S.row },
        E(View, { style: [S.dot, { backgroundColor: following ? C.green : C.faint }] }),
        E(Text, { style: S.statusTx },
          following
            ? 'Following  ' + (g_followName ?? g_followId)
            : 'Idle — not following anyone'),
      ),
    ),

    // ── Retry warning ───────────────────────────────────────────────────────
    retrying
      ? E(View, { style: S.warn },
          E(Text, { style: S.warnTx },
            '⏳  Target channel is full.\nChecking for an open slot every 3 seconds…\n\nChannel ID: ' + g_retryId),
        )
      : null,

    // ── Stop button (only shown when following) ─────────────────────────────
    following
      ? E(TouchableOpacity, {
          style: [S.btn, { backgroundColor: C.red }],
          activeOpacity: 0.75,
          onPress() { unfollowUser(); refresh(); },
        },
          E(Text, { style: S.btnTx }, '⛔  Stop Following'),
        )
      : null,

    // ── How-to hint (only when idle) ────────────────────────────────────────
    !following
      ? E(View, { style: S.hintBox },
          E(Text, { style: S.hintTx },
            'Open any user\'s Discord profile\nand tap  ···  →  📡 Follow VC'),
        )
      : null,

  );
}


// ─────────────────────────────────────────────────────────────────────────────
//  PLUGIN LIFECYCLE EXPORT
// ─────────────────────────────────────────────────────────────────────────────

export default plugin({
  settings: SettingsScreen,

  // ── onLoad ─────────────────────────────────────────────────────────────────
  onLoad() {

    // ── 1. Wire up Discord module references ─────────────────────────────────
    FluxDispatcher = fP('dispatch', 'subscribe', 'unsubscribe')
                  ?? fS('FluxDispatcher');

    VoiceStateStore = fP('getVoiceStateForUser', 'getVoiceStatesForChannel')
                   ?? fS('VoiceStateStore');

    ChannelStore = fP('getChannel', 'getDMFromUserId')
               ?? fS('ChannelStore');

    VoiceActions = fP('selectVoiceChannel');

    // Try several storage APIs that different Revenge builds expose
    Storage = fP('getItem', 'setItem', 'removeItem')   // React Native AsyncStorage
           ?? fP('get', 'set', 'remove')               // alternate sync API
           ?? fP('getItem', 'setItem');                 // minimal async

    // ── 2. Restore persisted follow target ───────────────────────────────────
    loadState();

    // ── 3. Subscribe to voice state changes ──────────────────────────────────
    FluxDispatcher?.subscribe?.('VOICE_STATE_UPDATE', onVoiceStateUpdate);

    // ── 4. If we were already following, check if target is in a VC now ──────
    if (g_followId && VoiceStateStore) {
      const vs = VoiceStateStore.getVoiceStateForUser?.(g_followId);
      if (vs?.channelId) {
        if (!tryJoin(vs.channelId)) startRetry(vs.channelId);
      }
    }

    // ── 5. Inject the profile button ─────────────────────────────────────────
    patchProfileMenu();
  },

  // ── onUnload ───────────────────────────────────────────────────────────────
  onUnload() {
    stopRetry();
    FluxDispatcher?.unsubscribe?.('VOICE_STATE_UPDATE', onVoiceStateUpdate);

    // Remove all patches
    for (const cleanup of g_cleanups) {
      try { cleanup(); } catch {}
    }
    g_cleanups.length = 0;
  },
});
