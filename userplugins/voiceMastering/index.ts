/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 nerdrx and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { definePluginSettings } from "@api/Settings";
import definePlugin, { OptionType } from "@utils/types";
import { MediaEngineStore, SelectedChannelStore, showToast, Toasts, UserStore, VoiceStateStore } from "@webpack/common";

const settings = definePluginSettings({
    autoNormalize: {
        type: OptionType.BOOLEAN,
        description: "Automatically even out everyone's loudness (boost quiet people, tame loud ones) using their live speaking levels",
        default: true
    },
    targetLoudness: {
        type: OptionType.SLIDER,
        description: "Target loudness everyone is nudged toward (higher = louder overall)",
        markers: [20, 40, 60, 80, 100],
        default: 55
    },
    maxGain: {
        type: OptionType.SLIDER,
        description: "Maximum auto boost (%) — how loud a quiet person can be pushed",
        markers: [100, 150, 200, 300, 400],
        default: 250
    },
    strength: {
        type: OptionType.SLIDER,
        description: "How aggressively auto-normalize reacts (higher = snappier, but more pumping)",
        markers: [1, 2, 3, 4, 5],
        default: 2,
        stickToMarkers: true
    }
});

/** userId -> smoothed recent speaking level (0..~100) */
const level = new Map<string, number>();
/** userId -> gain we've applied (%), so we don't spam identical calls */
const applied = new Map<string, number>();
let engine: any = null;
let onActivity: ((userId: string, v: number) => void) | null = null;
let loop: ReturnType<typeof setInterval> | undefined;

function setUserVolume(userId: string, volume: number) {
    // Apply on every active voice connection (mirrors how Discord stores per-user volume)
    try {
        MediaEngineStore.getMediaEngine()?.connections?.forEach((c: any) => c.setLocalVolume?.(userId, volume));
    } catch { }
}

function normalizeTick() {
    if (!settings.store.autoNormalize) return;
    const chanId = SelectedChannelStore.getVoiceChannelId();
    if (!chanId) return;

    const me = UserStore.getCurrentUser()?.id;
    const states = VoiceStateStore.getVoiceStatesForChannel(chanId) ?? {};
    const target = settings.store.targetLoudness;
    const k = settings.store.strength / 100; // convergence rate per tick

    for (const userId of Object.keys(states)) {
        if (userId === me) continue;
        const lvl = level.get(userId);
        if (lvl == null || lvl < 2) continue; // not enough recent signal to judge

        // desired gain so lvl*gain ≈ target loudness
        const desired = Math.max(60, Math.min(settings.store.maxGain, (target / lvl) * 100));
        const cur = applied.get(userId) ?? 100;
        const next = cur + (desired - cur) * k * settings.store.strength;

        if (Math.abs(next - cur) > 1) {
            applied.set(userId, next);
            setUserVolume(userId, Math.round(next));
        }
    }
}

function resetUser(userId: string) {
    if (applied.has(userId)) {
        setUserVolume(userId, 100);
        applied.delete(userId);
    }
    level.delete(userId);
}

function attach() {
    engine = MediaEngineStore.getMediaEngine();
    if (!engine?.on) return;
    onActivity = (userId: string, v: number) => {
        // exponential-ish smoothing of the amplitude Discord reports
        const prev = level.get(userId) ?? 0;
        level.set(userId, prev * 0.8 + v * 0.2);
    };
    engine.on("VoiceActivity", onActivity);
}

function detach() {
    if (engine && onActivity) {
        try { engine.off?.("VoiceActivity", onActivity); } catch { }
    }
    engine = null;
    onActivity = null;
}

export default definePlugin({
    name: "VoiceMastering",
    description: "A mixing desk for voice chat: auto-normalizes everyone to the same loudness and lets you set per-user gain well beyond Discord's 200% cap.",
    authors: [{ name: "nerdrx", id: 0n }],
    settings,

    toolboxActions: {
        "🎚️ Reset everyone to 100%"() {
            for (const id of [...applied.keys()]) resetUser(id);
            showToast("VoiceMastering: all per-user volumes reset", Toasts.Type.SUCCESS);
        },
        "📊 Show current gains"() {
            const rows = [...applied.entries()]
                .map(([id, g]) => `${UserStore.getUser(id)?.username ?? id}: ${Math.round(g)}%`)
                .join("\n");
            showToast(rows || "No auto-adjustments yet", Toasts.Type.MESSAGE);
        }
    },

    flux: {
        VOICE_STATE_UPDATES({ voiceStates }: { voiceStates: Array<{ userId: string; channelId?: string | null; }>; }) {
            const myChan = SelectedChannelStore.getVoiceChannelId();
            for (const s of voiceStates) {
                // someone left our channel (or moved) → drop their tracking + restore
                if (s.channelId !== myChan) resetUser(s.userId);
            }
        }
    },

    start() {
        attach();
        loop = setInterval(normalizeTick, 500);
    },

    stop() {
        clearInterval(loop);
        for (const id of [...applied.keys()]) resetUser(id);
        level.clear();
        detach();
    }
});
