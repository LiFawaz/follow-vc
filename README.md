# VC Follow — for Revenge's Vendetta-compatible plugin loader

Rebuilt from the **file layout and command pattern** in the supplied `Fake-deaf-main.zip`, replacing every Fake Deafen feature with VC Follow. Does **not** spoof mute/deafen or modify gateway packets.

## Features

- `/vcf @user` starts following a Discord user in VC. Valid target IDs are accepted from plugin settings too.
- `/vcunf` stops following.
- React Native settings screen with Follow VC / Unfollow VC controls and status messages.
- Automatically switches to the user's destination VC when they move within **your current server**, but only if **you are already in a voice channel** and have CONNECT permission to the destination.
- Checks channel capacity when voice state data is available. Never disconnects you when the target leaves.
- Attempts to add a **Follow VC / Unfollow VC** action to user profiles when the host exposes a supported action provider (experimental; may not appear).
- Registers cleanup for its slash commands and listeners when disabled.
- No external network calls, token interception, message tracking, or gateway packet modification.

## Which Revenge format?

**This uses the older Vendetta-compatible format in your friend's code** (`@vendetta` plugin APIs, `onLoad/onUnload`, `manifest.json` and `index.js`). The install popup shown in your screenshots tries to fetch a **manifest.json URL**, which is consistent with this format.

**It is NOT the current, native Revenge Next `format: 1` plugin format.** If your installation only supports official Next `index.json` repositories, this build will not work without porting the runtime to `@revenge-mod/*`. See [official documentation](https://revenge.palmdevs.me/docs/plugin-development/getting-started/your-first-plugin/). The client-specific voice/module APIs are unstable, so mobile runtime compatibility remains unverified.

## Download/source layout

```
.github/workflows/deploy.yml          builds and deploys to GitHub Pages
plugins/vc-follow/manifest.json       development manifest
plugins/vc-follow/src/index.ts        plugin logic & commands
plugins/vc-follow/src/Settings.tsx    plugin settings
tests/vc-follow.test.cjs              local simulator tests
build.cjs                             offline-friendly compiler/bundler
dist/vc-follow/index.js               build output
dist/vc-follow/manifest.json          build output
```

## Build and test locally

Requires Node.js 20+:

```sh
npm install
npm run build
npm test
```

`build.cjs` compiles the two TypeScript sources to one **eval expression** (how the old Vendetta-compatible loader evaluates plugins), and writes a SHA-256 `hash` field to the manifest. No Rollup dependency is needed. This makes testing/publishing simpler than the original friend project.

## Publish on GitHub Pages (URL installation)

1. Create a public GitHub repository (for example `vc-follow-plugin`).
2. Upload **all project files** from this source archive, including `.github/workflows/deploy.yml` (don't upload only the ZIP or the `src` folder).
3. In repository Settings → Pages → Build and deployment, set **Source: GitHub Actions**.
4. Push/upload the files to your default branch (`main` or `master`), and check the **Actions** tab to confirm deployment succeeded.
5. In the Revenge **Plugins → + → Install a plugin** popup, paste:

   `https://YOUR_GITHUB_USERNAME.github.io/YOUR_REPOSITORY_NAME/vc-follow/`

   **Do not** paste a `github.com/.../blob/...zip` link, and **do not** paste the source ZIP path. The plugin loader fetches `manifest.json` and then `index.js` from that hosted folder.
6. Enable **VC Follow**, join an accessible VC in the same server as a friend, then run `/vcf @user`. Stop with `/vcunf`.

There is also a `VC-Follow-Hosted-Files.zip` archive containing only `vc-follow/manifest.json` and `vc-follow/index.js`. Those two files can be uploaded to any static HTTPS host if you don't want a build workflow.

## Caveats

- The profile action is experimental. Profile menus change between Discord versions; use `/vcf @user` or the settings screen if the button is not shown.
- `selectVoiceChannel` is a Discord internal API; if it can't be found in your build, the settings status will report this and no move will occur.
- Test in your own server first. The local unit tests are mock simulations, not a connected Android integration test.
- Following another user may make your own voice movement visible to that server's members.
