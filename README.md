# Vencord NX Plugins

A suite of [Vencord](https://vencord.dev) userplugins focused on voice channels — built for the NX app family and installable through **[NX Hub](https://github.com/nerdrx/nx-hub)**.

All plugins share the NX look: deep-space dark, `#7700FF` violet accents, glassy overlays.

## Plugins

| Plugin | What it does |
| --- | --- |
| **VoiceKeeper** | Auto-rejoins a pinned voice channel after timeouts, internet outages or crashes. Right-click a voice channel → *Pin for Auto-Rejoin*. Respects manual disconnects. |
| **SoundboardSpam** | Spams soundboard sounds into your current VC (for waking people up). Random / specific / cross-server sound pools, rate-limit aware, optional local playback so you hear it too. Toolbox toggle. |
| **VoiceNetworkHUD** | Draggable glass overlay graphing your voice connection's internals live: ping, packet loss, jitter, in/out bitrate, with a health dot. |
| **FakeDeafen** | Appear deafened (and muted) to everyone while you still hear the whole channel. Rewrites the outbound voice-state payload; toolbox toggle. |
| **GatewayInspector** | Wireshark for Discord — live, filterable feed of every flux/gateway event with expandable JSON payloads and per-type counters. |
| **VoiceCodecUnlocks** | Force a higher outgoing voice bitrate and take manual control of echo cancellation / noise suppression / Krisp. Great for music over mic. |
| **VCRhythm** | Passively logs who's in voice and when (stored locally in IndexedDB) and renders per-user weekly activity heatmaps. |
| **VoiceMastering** | A mixing desk for voice chat: auto-normalizes everyone to the same loudness (boost the quiet, tame the loud) and sets per-user gain well past Discord's 200% cap. |
| **PresenceRadar** | Live top-down map of every voice channel in the server — who's where, muted/streaming icons, a green pulse ring on whoever's talking. Click a channel to hop in. |

Each plugin exposes its controls through the **Vencord toolbox** (the icon in the top-right of the app) and/or a right-click context menu, plus settings in **Vencord → Plugins**.

## Install

### Via NX Hub (recommended)
Open NX Hub, find **Vencord NX Plugins**, click **Install**, then fully restart Discord. The hub installs a prebuilt Vencord `dist` (Vencord + these plugins) into `~/.config/Vencord/dist`.

> Turn **off** Vencord's auto-updater (Vencord → Updater) so it doesn't overwrite the NX build.

### Manual (build from source)
Requires Node and a working Vencord install (`~/.config/Vencord/dist` present).

```bash
git clone https://github.com/nerdrx/vencord-nx-plugins
cd vencord-nx-plugins
./install.sh
```

This clones Vencord at the pinned ref, injects the plugins, builds, backs up your current `dist` to `dist.bak`, and deploys. Restart Discord (Ctrl+R) afterwards.

## Develop

The plugin sources live in [`userplugins/`](userplugins/) — one folder per plugin, standard Vencord userplugin layout. `scripts/build.sh` produces a release tarball; the GitHub Actions workflow builds and publishes it on every `v*` tag.

## License

GPL-3.0-or-later. Vencord is a third-party client mod; using it violates Discord's ToS — use at your own risk.
