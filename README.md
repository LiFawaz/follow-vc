# VC Follow

A small Revenge/Vendetta-compatible plugin that follows a selected user between voice channels.

## Install

Add this manifest in Revenge → Plugins:

`https://kkssmm918839-crypto.github.io/follow-vc/index.json`

Install and enable VC Follow, then open the plugin settings and enter a Discord user ID. You can also use **Follow this user** from a supported user menu. Press **Unfollow VC** to stop.

## Settings

- **Follow VC:** joins the selected user's voice channel when the client exposes the needed voice state and join action.
- **Monitor server restrictions:** when on, reports detected server mute/deafen states and checks the related permission. The switch is green when enabled. When off, the monitor does nothing.

## Notes

The monitor does not unmute or undeafen you. Discord controls server-side restrictions, and moderation permissions generally apply to other members, not yourself. This plugin does not bypass server permissions or channel limits.

The plugin uses Discord client internals, which can change between Revenge/Vendetta builds. If something fails, check the plugin status/logs and make sure your client is compatible.

## Build

Requires Node.js and pnpm.

```sh
pnpm install
pnpm test
pnpm run build
```
