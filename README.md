# VC Follow for Revenge

VC Follow is a client-side plugin for Revenge/Vendetta-compatible Discord clients. It attempts to keep your account in the same voice channel as one Discord user you select.

> **Compatibility note:** this plugin depends on internal Discord client stores, event names, context-menu components, and voice-switching actions. These internals can change without notice. A successful build does not guarantee compatibility with every client version.

## What it does

- Adds a **Follow this user** entry to supported user profile/context menus.
- Saves the selected Discord user ID and follow state in plugin storage.
- Attempts to join the selected user's current voice channel when a voice-state change is detected.
- Attempts to follow the target across servers if the client exposes the required voice state and join action.
- Tracks when the target leaves voice and tries to follow again when they join another channel.
- Checks the destination channel's Connect permission when the client exposes channel and permission data.
- Checks voice-channel capacity when the client exposes voice states and user limits. A full channel may be retried when a voice-state event indicates a slot opened.
- Provides a settings screen for entering a Discord user ID, following/unfollowing, viewing status, and enabling a server mute/deafen monitor.

These are best-effort behaviors. The plugin cannot guarantee that a join request succeeds or that all events are visible to your client.

## What it does not do

- It does not bypass Discord server permissions, channel limits, or server-side moderation.
- The **Server mute/deafen monitor** only detects a reported server mute/deafen state and checks whether the matching moderation permission appears to be present. It reports the result in the plugin status; it does **not** unmute or undeafen you.
- It does not guarantee that the client exposes another user's voice state, especially across servers.
- Slash commands are not included because the previous `/vcf` and `/vcunf` registrations did not work reliably in the target client. Use the settings screen or profile/context-menu entry instead.

## Install

1. Open **Settings → Revenge → Plugins**.
2. Add the repository manifest URL:
   `https://kkssmm918839-crypto.github.io/follow-vc/index.json`
3. Install **VC Follow** and enable it.
4. Open a user's profile/context menu and select **Follow this user**.

To change targets, choose **Follow this user** on a different user. To stop following, use the plugin settings and press **Unfollow VC**.

If you have an older copy installed from a different manifest URL, remove that copy before installing this repository version to avoid duplicate plugin entries.

## Settings

### Follow VC

1. Open the VC Follow plugin settings.
2. Enter the target user's Discord ID in the **Discord user ID** field.
3. Press **Follow VC** to enable following.
4. Press **Unfollow VC** to disable following and clear the selected target.

The ID should be the user's numeric Discord ID, not their username. You can also use the profile/context-menu action if it is available in your client build.

### Server mute/deafen monitor

The **Monitor server restrictions** switch is off by default.

- **On:** when a voice-state event for your own account reports server mute or server deafen, the plugin attempts to check the matching permission in the current channel and updates the status with the result.
- **Off:** the monitor does not process those events.
- It only reports state and permission information. It does not send a moderation action.

Permission checks depend on the client exposing accurate voice-state fields and permission-store APIs. If the required information is unavailable, the status may be incomplete or the monitor may not detect the change.

## Status and troubleshooting

The settings page shows the latest status message. Examples include:

- **Already in the same VC** — you're already in the target's channel.
- **Can't follow: no permission to join that voice channel** — the client reports that Connect permission is missing.
- **Voice channel is full** — the plugin is waiting for capacity or another target move.
- **Voice switching unavailable on this Discord build** — the expected client action was not found.
- **Restriction monitor: detected server-muted/server-deafened...** — a matching voice-state event was received and permission checks were attempted.

If the profile menu item is missing, the current client may use different internal component names. Check the plugin debug logs for `[VC Follow]` messages. If the profile action is unavailable, use the settings screen.

If following does not work:

1. Confirm the plugin is enabled and a target ID is set.
2. Confirm that the target is currently in a voice channel you can join.
3. Check the plugin status and debug logs.
4. Update Revenge/your client and plugin if compatible releases are available.
5. Remember that client-internal API changes can break the plugin even when it compiles.

## Development

Requires Node.js and pnpm.

Install dependencies and run the repository checks:

```sh
pnpm install
pnpm test
pnpm run build
```

The build script transpiles `plugins/vc-follow/src/index.ts` and `plugins/vc-follow/src/Settings.tsx`, then writes the bundled plugin and manifest under `dist/vc-follow/`.

A passing test/build verifies only the checks those scripts perform. Runtime behavior still needs to be tested inside the intended Revenge/Vendetta-compatible client.

## Repository

- Source: `plugins/vc-follow/src/index.ts`
- Settings UI: `plugins/vc-follow/src/Settings.tsx`
- Plugin manifest: `plugins/vc-follow/manifest.json`
- Build script: `build.cjs`
- Tests: `tests/`
