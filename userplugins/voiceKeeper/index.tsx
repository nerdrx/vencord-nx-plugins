/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 nerdrx and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { findGroupChildrenByChildId, NavContextMenuPatchCallback } from "@api/ContextMenu";
import { definePluginSettings } from "@api/Settings";
import definePlugin, { OptionType } from "@utils/types";
import { findByPropsLazy, findStoreLazy } from "@webpack";
import { ChannelStore, Menu, SelectedChannelStore, showToast, Toasts } from "@webpack/common";

const { selectVoiceChannel } = findByPropsLazy("selectVoiceChannel", "selectChannel");
const GatewayConnectionStore = findStoreLazy("GatewayConnectionStore");

const VOICE_TYPES = [2, 13]; // GUILD_VOICE, GUILD_STAGE_VOICE

const settings = definePluginSettings({
    pinnedChannelId: {
        type: OptionType.STRING,
        description: "Channel ID to auto-rejoin (set via right-click on a voice channel)",
        default: ""
    },
    retryInterval: {
        type: OptionType.NUMBER,
        description: "Seconds between rejoin attempts",
        default: 5
    },
    disarmOnManualDisconnect: {
        type: OptionType.BOOLEAN,
        description: "Stop auto-rejoining after you manually disconnect or switch channels (re-arms when you rejoin the pinned channel)",
        default: true
    },
    alwaysRejoin: {
        type: OptionType.BOOLEAN,
        description: "Force pin: ALWAYS rejoin the pinned channel no matter what — even if you manually disconnect or switch. Overrides the manual-leave detection above. (You can't leave until you unpin.)",
        default: false
    },
    showToasts: {
        type: OptionType.BOOLEAN,
        description: "Show a toast when auto-rejoining",
        default: true
    }
});

let paused = false;
let watchdog: ReturnType<typeof setInterval> | undefined;
let lastAttempt = 0;
// Timestamp of the last time the voice RTC connection was NOT healthy. Used to
// tell a real manual disconnect (fired while healthy) apart from Discord giving
// up after a drop (RTC trouble precedes the channel being cleared).
let lastRtcTrouble = 0;
const DROP_GRACE_MS = 12_000;

function isGatewayConnected() {
    try {
        return GatewayConnectionStore.isConnected();
    } catch {
        return navigator.onLine;
    }
}

function toast(msg: string, type = Toasts.Type.MESSAGE) {
    if (settings.store.showToasts) showToast(msg, type);
}

function check(force = false) {
    const target = settings.store.pinnedChannelId;
    if (!target) return;
    if (paused && !settings.store.alwaysRejoin) return; // force pin ignores the pause
    if (SelectedChannelStore.getVoiceChannelId() === target) return;
    if (!isGatewayConnected()) return;

    const now = Date.now();
    if (!force && now - lastAttempt < Math.max(2, settings.store.retryInterval) * 1000) return;
    lastAttempt = now;

    const channel = ChannelStore.getChannel(target);
    if (!channel) {
        // Channel is gone (deleted, or we lost access) — unpin so we don't loop forever
        settings.store.pinnedChannelId = "";
        toast("VoiceKeeper: pinned channel no longer exists, unpinned.", Toasts.Type.FAILURE);
        return;
    }

    toast(`VoiceKeeper: rejoining #${channel.name}`);
    selectVoiceChannel(target);
}

function pinChannel(id: string, name?: string) {
    settings.store.pinnedChannelId = id;
    paused = false;
    lastAttempt = 0;
    toast(`VoiceKeeper: pinned ${name ? `#${name}` : "channel"} for auto-rejoin`, Toasts.Type.SUCCESS);
}

function unpin() {
    settings.store.pinnedChannelId = "";
    paused = false;
    toast("VoiceKeeper: unpinned", Toasts.Type.MESSAGE);
}

const channelContextPatch: NavContextMenuPatchCallback = (children, { channel }: { channel: any; }) => {
    if (!channel || !VOICE_TYPES.includes(channel.type)) return;

    const isPinned = settings.store.pinnedChannelId === channel.id;
    const item = (
        <Menu.MenuItem
            id="vc-keeper-pin"
            label={isPinned ? "Unpin Auto-Rejoin" : "Pin for Auto-Rejoin"}
            color={isPinned ? "danger" : undefined}
            action={() => isPinned ? unpin() : pinChannel(channel.id, channel.name)}
        />
    );

    const group = findGroupChildrenByChildId(["mute-channel", "unmute-channel"], children);
    if (group) group.push(item);
    else children.push(item);
};

export default definePlugin({
    name: "VoiceKeeper",
    description: "Automatically reconnects you to a pinned voice channel after timeouts, internet outages or crashes. Right-click a voice channel to pin it.",
    authors: [{ name: "nerdrx", id: 0n }],
    settings,

    contextMenus: {
        "channel-context": channelContextPatch
    },

    flux: {
        // Track voice-connection health so we can tell a manual disconnect (fired
        // while the connection is healthy) from Discord clearing the channel after
        // it gives up on a drop (RTC trouble comes first).
        RTC_CONNECTION_STATE(e: any) {
            if (e?.state === "RTC_CONNECTED") lastRtcTrouble = 0;
            else lastRtcTrouble = Date.now();
        },

        VOICE_CHANNEL_SELECT(e: any) {
            const target = settings.store.pinnedChannelId;
            if (!target) return;

            const chanId = e?.channelId ?? e?.channel_id ?? null;

            if (chanId === target) {
                // (Re)joined the pinned channel — arm the watchdog
                paused = false;
                return;
            }

            // Force pin, or a drop (RTC was troubled just before) → never pause.
            // The watchdog rejoins on its next tick, gated by retryInterval, so
            // it recovers on its own without ever spamming the connection.
            const wasDrop = Date.now() - lastRtcTrouble < DROP_GRACE_MS;
            if (settings.store.alwaysRejoin || wasDrop) {
                paused = false;
                return;
            }

            if (settings.store.disarmOnManualDisconnect && !paused) {
                paused = true;
                toast("VoiceKeeper: paused (looks like you left on purpose). Rejoin the pinned channel to re-arm.");
            }
        },

        // Gateway (re)connected — e.g. right after an internet outage ends
        CONNECTION_OPEN() {
            lastRtcTrouble = Date.now(); // connection just came back; treat as recently-troubled
            setTimeout(() => check(true), 3000);
        }
    },

    toolboxActions: {
        "Pin current voice channel"() {
            const id = SelectedChannelStore.getVoiceChannelId();
            if (!id) return toast("VoiceKeeper: you're not in a voice channel", Toasts.Type.FAILURE);
            pinChannel(id, ChannelStore.getChannel(id)?.name);
        },
        "Unpin"() {
            unpin();
        },
        "Re-arm & rejoin now"() {
            if (!settings.store.pinnedChannelId) return toast("VoiceKeeper: nothing pinned", Toasts.Type.FAILURE);
            paused = false;
            lastAttempt = 0;
            lastRtcTrouble = 0;
            check(true);
            toast("VoiceKeeper: re-armed", Toasts.Type.SUCCESS);
        }
    },

    start() {
        paused = false;
        lastAttempt = 0;
        watchdog = setInterval(() => check(), 1000);
    },

    stop() {
        clearInterval(watchdog);
    }
});
