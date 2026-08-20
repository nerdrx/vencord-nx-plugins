/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 nerdrx and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { definePluginSettings } from "@api/Settings";
import definePlugin, { OptionType } from "@utils/types";
import { MediaEngineStore, RTCConnectionStore, SelectedChannelStore, showToast, Toasts } from "@webpack/common";

const settings = definePluginSettings({
    maxKbps: {
        type: OptionType.SLIDER,
        description: "Ceiling bitrate (kbps) when the connection is clean",
        markers: [64, 96, 128, 256, 384, 512],
        default: 256,
        stickToMarkers: false
    },
    minKbps: {
        type: OptionType.SLIDER,
        description: "Floor bitrate (kbps) it will never drop below",
        markers: [8, 16, 24, 32, 48, 64],
        default: 24,
        stickToMarkers: false
    },
    lossThreshold: {
        type: OptionType.SLIDER,
        description: "Packet loss %% above which it starts backing off",
        markers: [1, 2, 3, 5, 8],
        default: 2,
        stickToMarkers: false
    },
    pingThreshold: {
        type: OptionType.NUMBER,
        description: "Ping (ms) above which it also backs off",
        default: 250
    },
    showToasts: {
        type: OptionType.BOOLEAN,
        description: "Toast on each bitrate change",
        default: false
    }
});

let loop: ReturnType<typeof setInterval> | undefined;
let current = 0;             // kbps currently applied
let prevPackets: { inbound: number; outbound: number; lost: number; } | null = null;
let sinceGoodProbe = 0;      // consecutive clean samples (used to ramp back up)

function setBitrate(kbps: number) {
    const bps = Math.round(kbps * 1000);
    let n = 0;
    MediaEngineStore.getMediaEngine()?.connections?.forEach((c: any) => {
        c.setVoiceBitRate?.(bps);
        c.setBitRate?.(bps);
        n++;
    });
    if (n && kbps !== current) {
        current = kbps;
        if (settings.store.showToasts)
            showToast(`Autopilot: ${kbps} kbps`, Toasts.Type.MESSAGE);
    }
}

function sampleLoss(): number {
    const p = RTCConnectionStore.getPacketStats?.();
    if (!p) return 0;
    let loss = 0;
    if (prevPackets) {
        const total = (p.inbound - prevPackets.inbound) + (p.outbound - prevPackets.outbound) + (p.lost - prevPackets.lost);
        const lost = p.lost - prevPackets.lost;
        loss = total > 0 ? (lost / total) * 100 : 0;
    }
    prevPackets = { inbound: p.inbound, outbound: p.outbound, lost: p.lost };
    return loss;
}

function tick() {
    if (!SelectedChannelStore.getVoiceChannelId()) {
        prevPackets = null;
        current = 0;
        return;
    }
    if (current === 0) { setBitrate(settings.store.maxKbps); return; }

    const loss = sampleLoss();
    const ping = RTCConnectionStore.getLastPing?.() ?? 0;
    const { maxKbps, minKbps, lossThreshold, pingThreshold } = settings.store;

    const bad = loss > lossThreshold || (ping && ping > pingThreshold);

    if (bad) {
        sinceGoodProbe = 0;
        // Back off proportionally to how far over the loss threshold we are (min 15%)
        const severity = Math.max(0.15, Math.min(0.5, loss / (lossThreshold * 4)));
        const next = Math.max(minKbps, Math.round(current * (1 - severity)));
        if (next < current) setBitrate(next);
    } else {
        // Clean: ramp back toward the ceiling, but slowly (probe every few clean samples)
        sinceGoodProbe++;
        if (sinceGoodProbe >= 3 && current < maxKbps) {
            sinceGoodProbe = 0;
            const next = Math.min(maxKbps, Math.round(current * 1.15) + 4);
            setBitrate(next);
        }
    }
}

export default definePlugin({
    name: "BitrateAutopilot",
    description: "Adaptively tunes your outgoing voice bitrate from live packet-loss and ping — backs off on a bad connection, ramps back up when it clears. Pairs with VoiceNetworkHUD.",
    authors: [{ name: "nerdrx", id: 0n }],
    settings,

    toolboxActions: {
        "🛩️ Autopilot status"() {
            const inVC = !!SelectedChannelStore.getVoiceChannelId();
            showToast(inVC ? `Autopilot: ${current || settings.store.maxKbps} kbps` : "Not in a voice channel", inVC ? Toasts.Type.SUCCESS : Toasts.Type.FAILURE);
        }
    },

    flux: {
        RTC_CONNECTION_STATE(e: any) {
            if (e?.state === "RTC_CONNECTED") {
                prevPackets = null;
                current = 0;
                sinceGoodProbe = 0;
                setTimeout(() => { if (SelectedChannelStore.getVoiceChannelId()) setBitrate(settings.store.maxKbps); }, 900);
            }
        }
    },

    start() {
        loop = setInterval(tick, 1500);
    },

    stop() {
        clearInterval(loop);
        prevPackets = null;
        current = 0;
    }
});
