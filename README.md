<div align="center">

# ⬡ VENCORD · NX PLUGINS

**A voice-first arsenal for [Vencord](https://vencord.dev).**
Auto-rejoin. Network telemetry. Adaptive bitrate. Presence intel. And a soundboard cannon.

![version](https://img.shields.io/badge/version-0.5.0-7700FF?style=for-the-badge)
![plugins](https://img.shields.io/badge/plugins-14-7700FF?style=for-the-badge)
![vencord](https://img.shields.io/badge/vencord-1.15.2-00e5ff?style=for-the-badge)
![license](https://img.shields.io/badge/license-GPL--3.0-00e5ff?style=for-the-badge)

*Part of the **NX** family · deep space, violet glass · installable through [NX Hub](https://github.com/nerdrx/nx-hub)*

</div>

---

```
        ⬡  fourteen plugins, one build, zero telemetry
        ⬡  everything local · everything glass · everything #7700FF
```

## ⚡ The Arsenal

### 🎙️ Voice & Audio
| Plugin | What it does |
| :-- | :-- |
| **VoiceKeeper** | Auto-rejoins a pinned voice channel after timeouts, outages or crashes. Right-click a VC → *Pin for Auto-Rejoin*. Respects manual disconnects. |
| **SoundboardSpam** | Fires soundboard sounds into your VC on a loop — random, specific, or cross-server. Rate-limit aware, optional local playback. For waking people up. 😈 |
| **VoiceMastering** | A mixing desk for voice chat: auto-normalizes everyone to the same loudness and pushes per-user gain past Discord's 200% cap. |
| **VoiceCodecUnlocks** | Force a higher outgoing bitrate and manually control echo cancellation / noise suppression / Krisp. Music-over-mic mode. |
| **BitrateAutopilot** | Adaptively tunes your outgoing bitrate from live loss + ping — backs off on a bad line, ramps back when it clears. |

### 📡 Network & Diagnostics
| Plugin | What it does |
| :-- | :-- |
| **VoiceNetworkHUD** | Draggable glass overlay graphing ping, packet loss, jitter and in/out bitrate live, with a health dot. |
| **GatewayInspector** | Wireshark for Discord — live, filterable feed of every gateway/flux event with expandable payloads and per-type counters. |

### 🗺️ Presence & Intel
| Plugin | What it does |
| :-- | :-- |
| **PresenceRadar** | Live top-down map of every voice channel in a server — who's where, mute/stream icons, a green pulse ring on whoever's talking. Click to hop in. |
| **FriendRadar** | Desktop ping the instant a chosen friend joins any VC — with an optional clingy mode that follows them in. |
| **VCRhythm** | Passively logs who's in voice and when (locally), rendered as per-user weekly heatmaps. |
| **StalkerSuite** | Local dashboard that organizes the presence & activity your client already receives for people you watch — online history, now-playing, name changes, a live status radar. Everything is stored locally and nothing is ever sent anywhere. Opt-in per user; **personal use only — don't point it at anyone who wouldn't be cool with it.** |

### 🧰 Utility
| Plugin | What it does |
| :-- | :-- |
| **KeywordAlerts** | Desktop-notify when a word or regex you care about is said in *any* visible channel — even muted ones. Click to jump there. |
| **AssetRipper** | Bulk-download a server's emojis, stickers and soundboard sounds into a single zip. Right-click a server → *Rip server assets*. |
| **FakeDeafen** | Appear deafened (and muted) to everyone while you still hear the whole channel. Rewrites the outbound voice-state payload. |

> Every plugin is driven from the **Vencord toolbox** (top-right icon) and/or a right-click menu, with full settings in **Vencord → Plugins**.

## 📦 Install

### Via NX Hub — *recommended*
Open **[NX Hub](https://github.com/nerdrx/nx-hub)**, find **Vencord NX Plugins**, hit **Install**, restart Discord. The hub drops a prebuilt Vencord `dist` (Vencord + all 14 plugins) into `~/.config/Vencord/dist`.

> ⚠️ Turn **off** Vencord's auto-updater (Vencord → Updater) so it can't overwrite the NX build.

### Manual — *build from source*
Needs Node and a working Vencord install.
```bash
git clone https://github.com/nerdrx/vencord-nx-plugins
cd vencord-nx-plugins
./install.sh
```
Clones Vencord at the pinned ref, injects the plugins, builds, backs up your `dist` → `dist.bak`, deploys. `Ctrl+R` Discord after.

## 🛰️ How risky is this?

Discord doesn't scan your client — there's no anticheat, and it can't see your plugin list. Detection is purely *behavioral*: does your client send something a vanilla one wouldn't?

| Tier | Plugins | Risk |
| :-- | :-- | :-- |
| 🟢 **Invisible** | HUD · Inspector · VCRhythm · Mastering · Radars · StalkerSuite · KeywordAlerts | Pure local reads. Discord literally can't see them. |
| 🟡 **Protocol-normal** | CodecUnlocks · BitrateAutopilot · AssetRipper · FakeDeafen | Within-spec traffic. Negligible. |
| 🟠 **Behavioral** | **SoundboardSpam** | Real, high-rate API calls — the one to use among friends, not to get reported. |

Bans purely for running Vencord are essentially unheard of. Your only real exposure is annoying someone enough to report you — a soundboard question, not a plugins-in-general one.

## 🧪 Develop

Plugin sources live in [`userplugins/`](userplugins/) — one folder each, standard Vencord layout. `scripts/build.sh` produces the release tarball; CI builds + publishes it on every `v*` tag.

```bash
scripts/build.sh          # → out/nx-vencord-plugins-<ver>-linux.tar.gz
```

## 📜 License

GPL-3.0-or-later. Vencord is a third-party client mod; using it violates Discord's ToS — **use at your own risk.** These tools are for you and your friends, not for harassing anyone.

<div align="center">

⬡ **made with Claude** · `#7700FF`

</div>
