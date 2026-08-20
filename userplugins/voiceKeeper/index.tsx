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
    showToasts: {
        type: OptionType.BOOLEAN,
        description: "Show a toast when auto-rejoining",
        default: true
    }
});

let paused = false;
let watchdog: ReturnType<typeof setInterval> | undefined;
let lastAttempt = 0;

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
    if (!target || paused) return;
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
        // Fires on user-driven channel selection (join / move / the disconnect button),
        // NOT on network drops — perfect for telling "I left" apart from "I got dropped".
        VOICE_CHANNEL_SELECT(e: any) {
            const target = settings.store.pinnedChannelId;
            if (!target) return;

            const chanId = e?.channelId ?? e?.channel_id ?? null;

            if (chanId === target) {
                // (Re)joined the pinned channel — arm the watchdog
                paused = false;
            } else if (settings.store.disarmOnManualDisconnect) {
                // Manually disconnected (null) or deliberately moved elsewhere — back off
                if (!paused) {
                    paused = true;
                    toast("VoiceKeeper: paused (manual disconnect). Rejoin the pinned channel to re-arm.");
                }
            }
        },

        // Gateway (re)connected — e.g. right after an internet outage ends
        CONNECTION_OPEN() {
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
