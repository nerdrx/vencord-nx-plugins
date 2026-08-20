# vencord-nx-plugins

A pile of voice-focused Vencord plugins I built for myself. Part of the NX stuff, installable through [NX Hub](https://github.com/nerdrx/nx-hub) or by hand.

14 plugins, one build, all local — nothing phones home.

## what's in here

**voice**
- `VoiceKeeper` — rejoins a pinned voice channel after timeouts/outages/crashes. Right-click a channel to pin it. Leaves you alone if you disconnect on purpose.
- `SoundboardSpam` — loops soundboard sounds into your VC. Random, specific, or cross-server, and it respects the rate limit. For waking people up.
- `VoiceMastering` — evens out everyone's loudness automatically, plus per-user gain past Discord's 200% cap.
- `VoiceCodecUnlocks` — force a higher outgoing bitrate, and take manual control of echo cancellation / noise suppression / Krisp.
- `BitrateAutopilot` — drops your outgoing bitrate when the line goes bad and ramps it back once it clears.

**network**
- `VoiceNetworkHUD` — draggable overlay with live ping / loss / jitter / bitrate.
- `GatewayInspector` — live feed of every gateway event, filterable, with the raw payloads.

**presence**
- `PresenceRadar` — top-down map of a server's voice channels, speaking rings, click a channel to hop in.
- `FriendRadar` — pings you when a chosen friend joins a VC. Optional follow-them-in mode.
- `VCRhythm` — logs who's in voice when and draws weekly heatmaps. Stays on your machine.
- `StalkerSuite` — local dashboard over the presence data your client already receives for people you watch. Stored locally, nothing sent anywhere. Personal use — don't be weird with it.
- `OrbitBridge` — the consent-respecting one: feeds your *friends'* presence and custom status to a local [NX Orbit](https://github.com/nerdrx/nx-orbit) instance. Friends-only, surface-only, POSTs to 127.0.0.1 and nowhere else, never touches messages.

**utility**
- `KeywordAlerts` — desktop notification when a word or regex shows up in any channel you can see, muted or not. Click it to jump there.
- `AssetRipper` — right-click a server to zip up its emojis, stickers and soundboard sounds.
- `FakeDeafen` — look deafened to everyone while you still hear the whole channel.

Everything's driven from the Vencord toolbox and right-click menus; settings are under Vencord → Plugins.

## install

**NX Hub:** find "Vencord NX Plugins", hit install, restart Discord. Turn off Vencord's auto-updater afterwards or it'll overwrite the build on the next update.

**By hand:**
```
git clone https://github.com/nerdrx/vencord-nx-plugins
cd vencord-nx-plugins
./install.sh
```
That clones Vencord at a pinned version, drops the plugins in, builds, and deploys to `~/.config/Vencord/dist` (your old dist gets backed up to `dist.bak` first). Ctrl+R Discord when it's done.

## theme

There's a matching Vencord theme in [`themes/nx.theme.css`](themes/nx.theme.css) — the NX look (deep space, violet, glassy chrome, faint starfield) applied to Discord itself so the whole client matches the plugin overlays. `install.sh` drops it into your Vencord themes folder; enable it under Vencord → Themes → NX. It recolors through Discord's design tokens rather than chasing hashed class names, so it holds up across updates.

## about bans

Discord doesn't scan your client, so none of this is "detectable" the way people assume — it only sees traffic. Almost everything here is local reads it can't see at all. The one exception is `SoundboardSpam`, which fires real API calls in a loop; the risk there isn't detection, it's someone reporting you for blasting them. So keep that one among friends. Nobody gets banned just for running Vencord.

## dev

Plugins live in `userplugins/`, one folder each — standard Vencord layout. `scripts/build.sh` produces the release tarball and CI publishes it whenever I push a `v*` tag.

## license

GPL-3.0. Vencord is against Discord's ToS, so use at your own risk.
