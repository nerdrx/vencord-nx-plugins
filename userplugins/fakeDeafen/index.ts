/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 nerdrx and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { definePluginSettings } from "@api/Settings";
import definePlugin, { OptionType } from "@utils/types";
import { findByProps } from "@webpack";
import { FluxDispatcher, SelectedChannelStore, showToast, Toasts } from "@webpack/common";

const settings = definePluginSettings({
    fakeDeafen: {
        type: OptionType.BOOLEAN,
        description: "Appear deafened to others while still hearing everyone",
        default: true
    },
    fakeMute: {
        type: OptionType.BOOLEAN,
        description: "Also appear muted (recommended — a deafened-but-unmuted user looks suspicious)",
        default: true
    }
});

let enabled = false;
let hookedSocket: any = null;
let originalSend: ((...a: any[]) => any) | null = null;

function getSocket() {
    try {
        return findByProps("getSocket").getSocket();
    } catch {
        return null;
    }
}

/** Wrap the gateway socket's send so outgoing voice-state (op 4) carries the spoofed flags */
function hookSocket() {
    const socket = getSocket();
    if (!socket || socket === hookedSocket) return socket;

    // Restore any previously-hooked socket before moving to a new one
    unhookSocket();

    originalSend = socket.send;
    const orig = originalSend;
    socket.send = function (op: number, data: any, ...rest: any[]) {
        if (op === 4 && enabled && data) {
            if (settings.store.fakeDeafen) data.self_deaf = true;
            if (settings.store.fakeMute) data.self_mute = true;
        }
        return orig!.apply(this, [op, data, ...rest]);
    };
    hookedSocket = socket;
    return socket;
}

function unhookSocket() {
    if (hookedSocket && originalSend) {
        try { hookedSocket.send = originalSend; } catch { }
    }
    hookedSocket = null;
    originalSend = null;
}

/** Push the current (real or spoofed) voice state to the gateway so others update immediately */
function pushVoiceState() {
    const socket = hookSocket();
    const channelId = SelectedChannelStore.getVoiceChannelId();
    if (!socket || !channelId) return;

    const guildId = findByProps("getChannel").getChannel(channelId)?.guild_id ?? null;
    const MediaEngineStore = findByProps("isDeaf", "isMute");

    // Start from the user's real local state, then let the send-hook overlay the spoof
    socket.send(4, {
        guild_id: guildId,
        channel_id: channelId,
        self_mute: MediaEngineStore.isMute(),
        self_deaf: MediaEngineStore.isDeaf(),
        self_video: false
    });
}

function toggle(state = !enabled) {
    enabled = state;
    hookSocket();
    pushVoiceState();
    showToast(
        enabled ? "FakeDeafen: ON — you appear deafened but still hear everyone 🤫" : "FakeDeafen: OFF",
        enabled ? Toasts.Type.SUCCESS : Toasts.Type.MESSAGE
    );
}

function onConnectionOpen() {
    // Gateway reconnected → the old socket is dead, re-hook the new one
    hookedSocket = null;
    originalSend = null;
    if (enabled) setTimeout(() => { hookSocket(); pushVoiceState(); }, 1500);
}

export default definePlugin({
    name: "FakeDeafen",
    description: "Appear deafened (and muted) to everyone else while you can still hear the whole channel. Toggle from the Vencord toolbox.",
    authors: [{ name: "nerdrx", id: 0n }],
    settings,

    toolboxActions: {
        "🤫 Toggle Fake Deafen"() {
            toggle();
        }
    },

    start() {
        hookSocket();
        FluxDispatcher.subscribe("CONNECTION_OPEN", onConnectionOpen);
    },

    stop() {
        if (enabled) { enabled = false; pushVoiceState(); }
        FluxDispatcher.unsubscribe("CONNECTION_OPEN", onConnectionOpen);
        unhookSocket();
    }
});
