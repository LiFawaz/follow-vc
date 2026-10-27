# VC Follow

A small Revenge/Vendetta-compatible plugin that follows a selected user between voice channels.

## Install

In Revenge → Plugins, paste this link:

`https://kkssmm918839-crypto.github.io/follow-vc/vc-follow/`

Enable VC Follow, open its settings, and enter a Discord user ID. You can also choose **Follow this user** from a supported user menu. Press **Unfollow VC** to stop.

## Auto unmute / undeafen

Turn the switch on to automatically turn off your own client-side mute and deafen when detected. Turn it off to disable this behavior completely. The switch is green when enabled.

This only controls your own client mute/deafen. It cannot remove a server-imposed mute or deafen; Discord controls those restrictions.

## Notes

The plugin relies on Discord client internals, which can change between Revenge/Vendetta builds. Check the plugin status/logs if something does not work.

## Build

Requires Node.js and pnpm.

```sh
pnpm install
pnpm test
pnpm run build
```
