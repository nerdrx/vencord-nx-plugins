/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 nerdrx and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { findGroupChildrenByChildId, NavContextMenuPatchCallback } from "@api/ContextMenu";
import { showNotification } from "@api/Notifications";
import { definePluginSettings } from "@api/Settings";
import definePlugin, { OptionType } from "@utils/types";
import { findByPropsLazy } from "@webpack";
import { ChannelStore, GuildStore, Menu, SelectedChannelStore, showToast, Toasts, UserStore } from "@webpack/common";

const { selectVoiceChannel } = findByPropsLazy("selectVoiceChannel", "selectChannel");

const settings = definePluginSettings({
    trackedIds: {
        type: OptionType.STRING,
        description: "Tracked user IDs (comma-separated). Easier: right-click a user → Track in Friend Radar.",
        default: ""
    },
    autoFollow: {
        type: OptionType.BOOLEAN,
        description: "Clingy mode: automatically join the channel a tracked friend joins",
        default: false
    },
    notify: {
        type: OptionType.BOOLEAN,
        description: "Show a desktop notification when a tracked friend joins voice",
        default: true
    },
    onlyWhenNotInVC: {
        type: OptionType.BOOLEAN,
        description: "Auto-follow only when you're not already in a voice channel",
        default: true
    }
});

// userId -> last channelId we saw them in (to detect genuine joins/moves)
const lastChannel = new Map<string, string | null>();

function tracked(): Set<string> {
    return new Set(settings.store.trackedIds.split(",").map(s => s.trim()).filter(Boolean));
}

function setTracked(ids: Set<string>) {
    settings.store.trackedIds = [...ids].join(",");
}

function onJoin(userId: string, channelId: string) {
    const channel = ChannelStore.getChannel(channelId);
    const user = UserStore.getUser(userId);
    const name = user?.username ?? "A friend";
    const chanName = channel?.name ?? "a voice channel";
    const guildName = channel?.guild_id ? GuildStore.getGuild(channel.guild_id)?.name : "a DM";

    if (settings.store.notify) {
        showNotification({
            title: `📡 ${name} joined voice`,
            body: `${chanName}${guildName ? ` · ${guildName}` : ""}`,
            icon: user?.getAvatarURL?.(undefined, 128),
            onClick: () => selectVoiceChannel(channelId)
        });
    }

    if (settings.store.autoFollow) {
        const inVC = SelectedChannelStore.getVoiceChannelId();
        if (!(settings.store.onlyWhenNotInVC && inVC)) {
            selectVoiceChannel(channelId);
            showToast(`Friend Radar: following ${name} into #${chanName}`, Toasts.Type.SUCCESS);
        }
    }
}

const userContextPatch: NavContextMenuPatchCallback = (children, { user }: { user?: { id: string; username?: string; }; }) => {
    if (!user) return;
    const ids = tracked();
    const isTracked = ids.has(user.id);

    const item = (
        <Menu.MenuItem
            id="friend-radar-track"
            label={isTracked ? "Untrack in Friend Radar" : "Track in Friend Radar"}
            color={isTracked ? "danger" : undefined}
            action={() => {
                if (isTracked) ids.delete(user.id);
                else ids.add(user.id);
                setTracked(ids);
                showToast(`Friend Radar: ${isTracked ? "no longer tracking" : "now tracking"} ${user.username ?? user.id}`, Toasts.Type.SUCCESS);
            }}
        />
    );

    const group = findGroupChildrenByChildId(["block", "user-profile"], children) ?? children;
    group.push(item);
};

export default definePlugin({
    name: "FriendRadar",
    description: "Get pinged the instant a chosen friend joins any voice channel — with an optional clingy mode that follows them in. Right-click a user to track them.",
    authors: [{ name: "nerdrx", id: 0n }],
    settings,

    contextMenus: {
        "user-context": userContextPatch
    },

    flux: {
        VOICE_STATE_UPDATES({ voiceStates }: { voiceStates: Array<{ userId: string; channelId?: string | null; }>; }) {
            const ids = tracked();
            if (!ids.size) return;

            for (const s of voiceStates) {
                if (!ids.has(s.userId)) continue;
                const prev = lastChannel.get(s.userId) ?? null;
                const now = s.channelId ?? null;
                lastChannel.set(s.userId, now);

                // Fire only on a real transition INTO a channel (join or move), not on mute/unmute
                if (now && now !== prev) onJoin(s.userId, now);
            }
        }
    },

    start() {
        // seed current positions so we don't fire for people already sitting in VC
        for (const id of tracked()) {
            const u = UserStore.getUser(id);
            lastChannel.set(id, null);
            void u;
        }
    },

    stop() {
        lastChannel.clear();
    }
});
