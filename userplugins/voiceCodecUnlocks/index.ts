/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 nerdrx and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { definePluginSettings } from "@api/Settings";
import definePlugin, { OptionType } from "@utils/types";
import { MediaEngineStore, showToast, Toasts } from "@webpack/common";

const settings = definePluginSettings({
    forceBitrate: {
        type: OptionType.BOOLEAN,
        description: "Override the outgoing voice bitrate (Discord normally caps it based on the channel)",
        default: false
    },
    bitrate: {
        type: OptionType.SLIDER,
        description: "Target voice bitrate in kbps (96+ is great for music; the server may still clamp very high values)",
        markers: [8, 64, 96, 128, 256, 384, 512],
        default: 128,
        stickToMarkers: false
    },
    echoCancellation: {
        type: OptionType.SELECT,
        description: "Echo cancellation",
        options: [
            { label: "Leave as Discord set it", value: "keep", default: true },
            { label: "Force ON", value: "on" },
            { label: "Force OFF (cleaner for music/instruments)", value: "off" }
        ]
    },
    noiseSuppression: {
        type: OptionType.SELECT,
        description: "Noise suppression",
        options: [
            { label: "Leave as Discord set it", value: "keep", default: true },
            { label: "Force ON", value: "on" },
            { label: "Force OFF (cleaner for music/instruments)", value: "off" }
        ]
    },
    noiseCancellation: {
        type: OptionType.SELECT,
        description: "Krisp noise cancellation",
        options: [
            { label: "Leave as Discord set it", value: "keep", default: true },
            { label: "Force ON", value: "on" },
            { label: "Force OFF", value: "off" }
        ]
    }
});

function eachConnection(fn: (c: any) => void) {
    try {
        const engine = MediaEngineStore.getMediaEngine();
        const conns: Set<any> = engine?.connections ?? new Set();
        conns.forEach(fn);
        return conns.size;
    } catch {
        return 0;
    }
}

function tri(setting: string, apply: (v: boolean) => void) {
    if (setting === "on") apply(true);
    else if (setting === "off") apply(false);
}

function applyAll(announce = false) {
    const n = eachConnection(conn => {
        try {
            if (settings.store.forceBitrate) {
                const bps = Math.round(settings.store.bitrate * 1000);
                conn.setVoiceBitRate?.(bps);
                conn.setBitRate?.(bps);
            }
            tri(settings.store.echoCancellation, v => conn.setEchoCancellation?.(v));
            tri(settings.store.noiseSuppression, v => conn.setNoiseSuppression?.(v));
            tri(settings.store.noiseCancellation, v => conn.setNoiseCancellation?.(v));
        } catch (e) {
            console.error("[VoiceCodecUnlocks] failed on a connection:", e);
        }
    });
    if (announce)
        showToast(n ? `VoiceCodecUnlocks: applied to ${n} voice connection(s)` : "VoiceCodecUnlocks: not in a voice channel", n ? Toasts.Type.SUCCESS : Toasts.Type.FAILURE);
}

function onRtcState(e: any) {
    // Reapply once the voice connection is fully established (settings are reset per-connection)
    if (e?.state === "RTC_CONNECTED") setTimeout(() => applyAll(), 800);
}

export default definePlugin({
    name: "VoiceCodecUnlocks",
    description: "Exposes hidden voice knobs: force a higher outgoing bitrate and take manual control of echo cancellation, noise suppression and Krisp. Great for music over mic.",
    authors: [{ name: "nerdrx", id: 0n }],
    settings,

    toolboxActions: {
        "🎚️ Apply voice settings now"() {
            applyAll(true);
        }
    },

    flux: {
        // Reapply once the voice connection is fully established (per-connection state resets on each connect)
        RTC_CONNECTION_STATE: onRtcState
    },

    start() {
        // Apply to any already-open connection immediately
        applyAll();
    }
});
