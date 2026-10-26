# VC Follow for Revenge Next

VC Follow attempts to keep you in the same voice channel as one selected Discord user. Following stays enabled until you stop it or choose a different person.

## Features

- Adds a **Follow this user** toggle to supported user profile/context menus.
- When the selected target is active, the menu entry changes to **Stop following username**.
- Selecting a different user switches the follow target.
- Tries to join the target's current voice channel, including across servers when the client exposes the required state and actions.
- Keeps following when the target leaves voice and attempts to rejoin when they return.
- Retries a full channel when voice-state events indicate a slot may have opened.
- Remembers the selected target and enabled state across plugin reloads.
- Includes a settings screen with status and a fallback to follow by Discord user ID.

## Install

1. Open **Settings → Revenge → Plugins**.
2. Open repository settings and add:
   `https://kkssmm918839-crypto.github.io/follow-vc/index.json`
3. Install **VC Follow** and enable it.
4. Open a user's profile/context menu and tap **Follow this user**.

To stop, open the same user's profile/context menu and tap **Stop following username**. To switch targets, open another user's profile and tap **Follow this user**.

If you installed an older copy from a different manifest URL, uninstall that copy before installing the repository version to avoid duplicate plugin entries.

## Settings fallback

If the profile toggle is unavailable on your Revenge/Discord build, open VC Follow's settings, paste the user's Discord ID, and tap **Follow user**. Use **Stop following** to disable following.

## Build and test

Requires Node.js and pnpm.

```sh
pnpm install
pnpm test
pnpm run build
```

The official `@revenge-mod/plugin-cli` builds the TypeScript source at `plugins/vc-follow/src/index.ts`. The deployment workflow packages the generated bundle with the manifest and publishes the repository index to GitHub Pages.

## Troubleshooting and compatibility

- Context-menu component names, voice-state event names, and voice-switching internals can change between client builds. If the profile item does not appear, check the plugin's debug logs and use the settings fallback.
- Following depends on the client exposing the target's voice state and allowing the client to join that channel. Server-side permission or capacity restrictions still apply.
- A successful build verifies compilation and packaging; it cannot prove that every profile menu and voice API is present in a specific installed client.
