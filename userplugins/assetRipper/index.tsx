/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 nerdrx and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { findGroupChildrenByChildId, NavContextMenuPatchCallback } from "@api/ContextMenu";
import { definePluginSettings } from "@api/Settings";
import definePlugin, { OptionType } from "@utils/types";
import { zipSync } from "fflate";
import {
    EmojiStore, GuildStore, Menu, SelectedGuildStore,
    showToast, SoundboardStore, StickersStore, Toasts
} from "@webpack/common";

const settings = definePluginSettings({
    emojis: { type: OptionType.BOOLEAN, description: "Include custom emojis", default: true },
    stickers: { type: OptionType.BOOLEAN, description: "Include stickers", default: true },
    sounds: { type: OptionType.BOOLEAN, description: "Include soundboard sounds", default: true }
});

function sanitize(s: string) {
    return (s || "unnamed").replace(/[^\w.-]+/g, "_").slice(0, 64);
}

interface Asset { path: string; url: string; }

function collect(guildId: string): Asset[] {
    const out: Asset[] = [];
    const used = new Set<string>();
    const uniq = (p: string) => {
        let n = p, i = 1;
        while (used.has(n)) { const d = p.lastIndexOf("."); n = `${p.slice(0, d)}_${i++}${p.slice(d)}`; }
        used.add(n);
        return n;
    };

    if (settings.store.emojis) {
        const grouped = (EmojiStore as any).getGroupedCustomEmoji?.() ?? {};
        for (const e of (grouped[guildId] ?? []) as any[]) {
            const ext = e.animated ? "gif" : "png";
            out.push({ path: uniq(`emojis/${sanitize(e.name)}.${ext}`), url: `https://cdn.discordapp.com/emojis/${e.id}.${ext}?size=256&quality=lossless` });
        }
    }
    if (settings.store.stickers) {
        for (const s of (StickersStore.getStickersByGuildId?.(guildId) ?? []) as any[]) {
            // format_type: 1 PNG, 2 APNG, 3 LOTTIE (json), 4 GIF
            const isLottie = s.format_type === 3;
            const isGif = s.format_type === 4;
            const ext = isLottie ? "json" : isGif ? "gif" : "png";
            const host = isLottie ? "cdn.discordapp.com" : "media.discordapp.net";
            out.push({ path: uniq(`stickers/${sanitize(s.name)}.${ext}`), url: `https://${host}/stickers/${s.id}.${ext}` });
        }
    }
    if (settings.store.sounds) {
        for (const snd of (SoundboardStore.getSoundsForGuild?.(guildId) ?? []) as any[]) {
            out.push({ path: uniq(`sounds/${sanitize(snd.name)}.ogg`), url: `https://cdn.discordapp.com/soundboard-sounds/${snd.soundId}` });
        }
    }
    return out;
}

async function rip(guildId: string) {
    const guild: any = GuildStore.getGuild(guildId);
    const gname = sanitize(guild?.name ?? guildId);
    const assets = collect(guildId);
    if (!assets.length) {
        showToast("Asset Ripper: nothing to rip (check the category toggles)", Toasts.Type.FAILURE);
        return;
    }

    showToast(`Asset Ripper: downloading ${assets.length} assets from ${guild?.name ?? "server"}…`, Toasts.Type.MESSAGE);

    const files: Record<string, Uint8Array> = {};
    let ok = 0, fail = 0;
    // fetch with a small concurrency cap so we don't hammer the CDN
    const queue = [...assets];
    async function worker() {
        while (queue.length) {
            const a = queue.shift()!;
            try {
                const res = await fetch(a.url);
                if (!res.ok) throw new Error(String(res.status));
                files[a.path] = new Uint8Array(await res.arrayBuffer());
                ok++;
            } catch {
                fail++;
            }
        }
    }
    await Promise.all(Array.from({ length: 6 }, worker));

    if (!ok) { showToast("Asset Ripper: every download failed", Toasts.Type.FAILURE); return; }

    const zipped = zipSync(files, { level: 0 }); // assets are already compressed; store-only is fast
    const blob = new Blob([zipped], { type: "application/zip" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${gname}-assets.zip`;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);

    showToast(`Asset Ripper: saved ${ok} assets${fail ? ` (${fail} failed)` : ""} → ${gname}-assets.zip`, Toasts.Type.SUCCESS);
}

const guildContext: NavContextMenuPatchCallback = (children, { guild }: { guild?: { id: string; }; }) => {
    if (!guild) return;
    const item = (
        <Menu.MenuItem
            id="asset-ripper-rip"
            label="📦 Rip server assets"
            action={() => rip(guild.id)}
        />
    );
    const group = findGroupChildrenByChildId(["privacy", "leave-guild", "hide-muted-channels"], children) ?? children;
    group.push(item);
};

export default definePlugin({
    name: "AssetRipper",
    description: "Bulk-download a server's custom emojis, stickers and soundboard sounds into a single zip. Right-click a server → Rip server assets.",
    authors: [{ name: "nerdrx", id: 0n }],
    settings,

    contextMenus: {
        "guild-context": guildContext
    },

    toolboxActions: {
        "📦 Rip current server's assets"() {
            const gid = SelectedGuildStore.getGuildId();
            if (!gid) return showToast("Asset Ripper: open a server first", Toasts.Type.FAILURE);
            rip(gid);
        }
    }
});
