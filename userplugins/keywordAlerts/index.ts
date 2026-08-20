/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 nerdrx and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { showNotification } from "@api/Notifications";
import { definePluginSettings } from "@api/Settings";
import definePlugin, { OptionType } from "@utils/types";
import { ChannelRouter } from "@webpack/common";
import { ChannelStore, GuildStore, SelectedChannelStore, UserStore } from "@webpack/common";

const settings = definePluginSettings({
    keywords: {
        type: OptionType.STRING,
        description: "Comma-separated words/phrases to watch for (e.g. free games, my project, giveaway)",
        default: ""
    },
    useRegex: {
        type: OptionType.BOOLEAN,
        description: "Treat each entry as a regular expression instead of a plain word",
        default: false
    },
    caseSensitive: {
        type: OptionType.BOOLEAN,
        description: "Match case exactly",
        default: false
    },
    wholeWord: {
        type: OptionType.BOOLEAN,
        description: "Plain mode only: match whole words (so \"cat\" doesn't hit \"category\")",
        default: true
    },
    ignoreSelf: {
        type: OptionType.BOOLEAN,
        description: "Don't alert on your own messages",
        default: true
    },
    ignoreFocusedChannel: {
        type: OptionType.BOOLEAN,
        description: "Don't alert for the channel you're actively looking at",
        default: true
    },
    ignoredUserIds: {
        type: OptionType.STRING,
        description: "User IDs to never alert on (comma-separated)",
        default: ""
    }
});

let matchers: RegExp[] = [];
let lastSig = "";

function sig() {
    const s = settings.store;
    return `${s.keywords}|${s.useRegex}|${s.caseSensitive}|${s.wholeWord}`;
}

function ensureFresh() {
    const cur = sig();
    if (cur !== lastSig) { lastSig = cur; rebuild(); }
}

function rebuild() {
    const flags = settings.store.caseSensitive ? "" : "i";
    matchers = settings.store.keywords
        .split(",")
        .map(s => s.trim())
        .filter(Boolean)
        .map(entry => {
            try {
                if (settings.store.useRegex) return new RegExp(entry, flags);
                const esc = entry.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
                return new RegExp(settings.store.wholeWord ? `\\b${esc}\\b` : esc, flags);
            } catch {
                return null;
            }
        })
        .filter((r): r is RegExp => r != null);
}

function firstHit(content: string): string | null {
    for (const m of matchers) {
        const hit = content.match(m);
        if (hit) return hit[0];
    }
    return null;
}

export default definePlugin({
    name: "KeywordAlerts",
    description: "Get a desktop notification whenever a word or regex you care about is mentioned in any channel you can see — even muted ones. Click the alert to jump straight there.",
    authors: [{ name: "nerdrx", id: 0n }],
    settings,

    flux: {
        MESSAGE_CREATE({ message, channelId, guildId, optimistic }: any) {
            if (optimistic || !message?.content) return;
            ensureFresh();
            if (!matchers.length) return;

            const authorId = message.author?.id;
            const me = UserStore.getCurrentUser()?.id;
            if (settings.store.ignoreSelf && authorId === me) return;

            const ignored = new Set(settings.store.ignoredUserIds.split(",").map(s => s.trim()).filter(Boolean));
            if (authorId && ignored.has(authorId)) return;

            const cid = channelId ?? message.channel_id;
            if (settings.store.ignoreFocusedChannel && SelectedChannelStore.getChannelId() === cid && document.hasFocus()) return;

            const hit = firstHit(message.content);
            if (!hit) return;

            const channel: any = ChannelStore.getChannel(cid);
            const gid = guildId ?? channel?.guild_id;
            const where = channel?.name
                ? `#${channel.name}${gid ? ` · ${GuildStore.getGuild(gid)?.name ?? ""}` : ""}`
                : "a DM";
            const author = message.author?.global_name || message.author?.username || "Someone";
            const body = message.content.length > 180 ? message.content.slice(0, 177) + "…" : message.content;

            showNotification({
                title: `🔔 "${hit}" — ${author} in ${where}`,
                body,
                icon: authorId && message.author?.avatar
                    ? `https://cdn.discordapp.com/avatars/${authorId}/${message.author.avatar}.png?size=128`
                    : undefined,
                onClick: () => {
                    try { ChannelRouter.transitionToChannel(cid); } catch { }
                }
            });
        }
    },

    start() {
        ensureFresh();
    }
});
