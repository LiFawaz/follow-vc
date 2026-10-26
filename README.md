# VC Follow for Revenge Next

VC Follow is a JavaScript-only plugin for the native Revenge Next plugin system. It provides a settings screen to follow a Discord user by ID and attempts to join the voice channel the target is in. Slash-command registration and voice-state access depend on the Discord/Revenge runtime APIs available in the installed build.

## Install

1. Open **Settings → Revenge → Plugins**.
2. Open the repository settings (gear) and add this repository URL:
   `https://kkssmm918839-crypto.github.io/follow-vc/index.json`
3. Return to Browse Plugins, install **VC Follow**, then enable it.
4. Open its settings, enter the target user's Discord ID, and press **Follow**.

If the plugin was installed from an older manifest URL or a standalone file, uninstall that copy first, then install from the repository above. Fresh installations are disabled by Revenge until enabled manually.

## Build and publish

This repository uses the official `@revenge-mod/plugin-cli` build tool. The workflow builds `plugins/vc-follow/src/index.ts`, packages the generated JavaScript with the plugin manifest into a versioned ZIP, generates a checksummed `index.json` repository index, and publishes the repository to GitHub Pages.

Local checks:

```sh
pnpm install
pnpm test
pnpm run build
```

The JavaScript bundle is written to `plugins/vc-follow/build/js/index.js`. The published ZIP contains `manifest.json` and `index.js` at its root, matching the manifest's `dist.script` path.

## Current limitations

- Voice-state event names and internal voice-switching APIs can vary by Discord client build. A successful build does not prove voice following works on every device.
- Following another user only works when Revenge/Discord exposes that user's voice state and the client allows joining the target channel.
- The project does not spoof mute/deafen state, intercept authentication tokens, or modify gateway packets.
- If the plugin will not enable, check Revenge's plugin error details and confirm the installed package came from the repository URL above.
