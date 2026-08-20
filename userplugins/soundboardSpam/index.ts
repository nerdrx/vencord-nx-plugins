/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 nerdrx and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { definePluginSettings } from "@api/Settings";
import definePlugin, { OptionType } from "@utils/types";
import { ChannelStore, RestAPI, SelectedChannelStore, showToast, SoundboardStore, Toasts } from "@webpack/common";

const settings = definePluginSettings({
    intervalMs: {
        type: OptionType.NUMBER,
        description: "Milliseconds between sounds (server rate limits apply, don't go too low)",
        default: 1500
    },
    soundId: {
        type: OptionType.STRING,
        description: "Specific sound ID to spam (empty = random)",
        default: ""
    },
    source: {
        type: OptionType.SELECT,
        description: "Where random sounds are picked from",
        options: [
            { label: "Current server only", value: "guild", default: true },
            { label: "All servers (needs Nitro for cross-server sounds)", value: "all" },
            { label: "Favorites (across all servers)", value: "favorites" }
        ]
    },
    maxPlays: {
        type: OptionType.NUMBER,
        description: "Auto-stop after this many sounds (0 = until stopped)",
        default: 0
    },
    playLocally: {
        type: OptionType.BOOLEAN,
        description: "Also play the sounds locally so you hear the chaos too (API-sent sounds are only broadcast to others)",
        default: true
    },
    localVolume: {
        type: OptionType.SLIDER,
        description: "Local playback volume (%)",
        markers: [0, 25, 50, 75, 100],
        default: 60
    }
});

let timer: ReturnType<typeof setInterval> | undefined;
let playCount = 0;
let failStreak = 0;
let backoffUntil = 0;

function getPool(guildId: string) {
    switch (settings.store.source) {
        case "all": {
            return [...SoundboardStore.getSounds().values()].flat().filter(s => s.available);
        }
        case "favorites": {
            const favs = [...SoundboardStore.getSounds().values()].flat()
                .filter(s => s.available && SoundboardStore.isFavoriteSound(s.soundId));
            if (favs.length) return favs;
            // fall through to current guild if nothing is favorited
        }
        default:
            return (SoundboardStore.getSoundsForGuild(guildId) ?? []).filter(s => s.available);
    }
}

async function tick() {
    if (Date.now() < backoffUntil) return;

    const vcId = SelectedChannelStore.getVoiceChannelId();
    if (!vcId) return; // not in VC right now — keep the loop armed, VoiceKeeper might bring us back

    const guildId = ChannelStore.getChannel(vcId)?.guild_id;
    if (!guildId) return; // DM calls have no soundboard

    let sound = settings.store.soundId
        ? SoundboardStore.getSoundById(settings.store.soundId)
        : undefined;

    if (!sound) {
        const pool = getPool(guildId);
        if (!pool.length) {
            stopSpam("no soundboard sounds available in this server");
            return;
        }
        sound = pool[Math.floor(Math.random() * pool.length)];
    }

    try {
        await RestAPI.post({
            url: `/channels/${vcId}/send-soundboard-sound`,
            body: {
                sound_id: sound.soundId,
                ...(sound.guildId && sound.guildId !== guildId ? { source_guild_id: sound.guildId } : {}),
                emoji_id: sound.emojiId ?? undefined,
                emoji_name: sound.emojiName ?? undefined
            }
        });
        if (settings.store.playLocally) {
            const el = new Audio(`https://cdn.discordapp.com/soundboard-sounds/${sound.soundId}`);
            el.volume = Math.max(0, Math.min(1, (sound.volume ?? 1) * settings.store.localVolume / 100));
            el.play().catch(() => { });
        }
        playCount++;
        failStreak = 0;
        if (settings.store.maxPlays > 0 && playCount >= settings.store.maxPlays)
            stopSpam(`done, played ${playCount} sounds`);
    } catch (e: any) {
        const retryAfter = e?.body?.retry_after;
        if (retryAfter) {
            backoffUntil = Date.now() + retryAfter * 1000 + 250;
        } else if (++failStreak >= 5) {
            // individual sounds may fail (e.g. cross-server without Nitro) — only
            // give up when nothing goes through at all
            stopSpam("5 requests in a row failed (soundboard permission? Nitro for cross-server sounds?)");
            console.error("[SoundboardSpam]", e);
        }
    }
}

function startSpam() {
    if (timer) return;
    if (!SelectedChannelStore.getVoiceChannelId())
        return showToast("SoundboardSpam: join a voice channel first", Toasts.Type.FAILURE);

    playCount = 0;
    failStreak = 0;
    backoffUntil = 0;
    timer = setInterval(tick, Math.max(500, settings.store.intervalMs));
    tick();
    showToast("SoundboardSpam: WAKE UP ⏰🔊", Toasts.Type.SUCCESS);
}

function stopSpam(reason?: string) {
    if (!timer) return;
    clearInterval(timer);
    timer = undefined;
    showToast(`SoundboardSpam: stopped${reason ? ` — ${reason}` : ` after ${playCount} sounds`}`, Toasts.Type.MESSAGE);
}

export default definePlugin({
    name: "SoundboardSpam",
    description: "Spams soundboard sounds into your current voice channel. For waking up sleepy friends. Start/stop via the Vencord toolbox.",
    authors: [{ name: "nerdrx", id: 0n }],
    settings,

    toolboxActions: {
        "⏰ Start wake-up spam"() {
            startSpam();
        },
        "🔇 Stop spam"() {
            stopSpam();
        },
        "🎧 Toggle hearing it yourself"() {
            settings.store.playLocally = !settings.store.playLocally;
            showToast(`SoundboardSpam: local playback ${settings.store.playLocally ? "on" : "off"}`, Toasts.Type.MESSAGE);
        }
    },

    stop() {
        stopSpam();
    }
});
