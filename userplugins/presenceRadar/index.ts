/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 nerdrx and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import definePlugin from "@utils/types";
import { findByPropsLazy } from "@webpack";
import { GuildChannelStore, SelectedChannelStore, SelectedGuildStore, UserStore, VoiceStateStore } from "@webpack/common";

const { selectVoiceChannel } = findByPropsLazy("selectVoiceChannel", "selectChannel");

/** userId -> timestamp we last saw them speaking (for the pulse ring) */
const speaking = new Map<string, number>();

let panel: HTMLDivElement | null = null;
let body: HTMLElement | null = null;
let raf = 0;

function guildId() {
    return SelectedGuildStore.getGuildId();
}

function vocalChannels(gid: string) {
    const chans = GuildChannelStore.getChannels(gid)?.VOCAL ?? [];
    return chans
        .map((c: any) => c.channel ?? c)
        .filter(Boolean);
}

function render() {
    if (!panel || !body || panel.style.display === "none") return;

    const gid = guildId();
    const myChan = SelectedChannelStore.getVoiceChannelId();
    const now = Date.now();

    if (!gid) {
        body.innerHTML = `<div style="opacity:0.55;font-size:12px;padding:16px;">Open a server to see its voice channels.</div>`;
        raf = requestAnimationFrame(render);
        return;
    }

    const channels = vocalChannels(gid).filter(ch => {
        const states = VoiceStateStore.getVoiceStatesForChannel(ch.id) ?? {};
        return Object.keys(states).length > 0 || ch.id === myChan;
    });

    // Build/refresh channel columns
    body.replaceChildren(...channels.map(ch => {
        const states = VoiceStateStore.getVoiceStatesForChannel(ch.id) ?? {};
        const ids = Object.keys(states);
        const isMine = ch.id === myChan;

        const col = document.createElement("div");
        col.style.cssText = `
            min-width: 150px; max-width: 190px; background: rgba(255,255,255,${isMine ? 0.07 : 0.03});
            border: 1px solid ${isMine ? "rgba(0,229,255,0.5)" : "rgba(119,0,255,0.22)"};
            border-radius: 12px; padding: 10px; flex: none;
        `;

        const head = document.createElement("div");
        head.style.cssText = "display:flex;align-items:center;gap:6px;margin-bottom:8px;cursor:pointer;";
        head.title = "Click to join";
        head.onclick = () => selectVoiceChannel(ch.id);
        const name = document.createElement("div");
        name.textContent = `🔊 ${ch.name}`;
        name.style.cssText = `font-size:12px;font-weight:700;color:${isMine ? "#7ff0ff" : "#b47aff"};flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;`;
        const cnt = document.createElement("div");
        cnt.textContent = String(ids.length);
        cnt.style.cssText = "font-size:11px;opacity:0.5;";
        head.append(name, cnt);
        col.append(head);

        for (const uid of ids) {
            const user = UserStore.getUser(uid);
            const st: any = states[uid];
            const talking = now - (speaking.get(uid) ?? 0) < 350;

            const row = document.createElement("div");
            row.style.cssText = "display:flex;align-items:center;gap:7px;padding:3px 0;";

            const av = document.createElement("div");
            const url = user?.getAvatarURL?.(undefined, 32) ?? "";
            av.style.cssText = `
                width: 22px; height: 22px; border-radius: 50%; flex: none;
                background: ${url ? `center/cover url(${url})` : "#443"};
                box-shadow: ${talking ? "0 0 0 2px #2ecc71, 0 0 8px 1px rgba(46,204,113,0.7)" : "0 0 0 1px rgba(255,255,255,0.1)"};
                transition: box-shadow 0.12s;
            `;

            const label = document.createElement("div");
            label.textContent = user?.username ?? uid;
            label.style.cssText = `font-size:11px;flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:${uid === UserStore.getCurrentUser()?.id ? "#7ff0ff" : "#e8e4f5"};`;

            const icons = document.createElement("div");
            icons.style.cssText = "font-size:10px;opacity:0.7;flex:none;";
            icons.textContent = `${st?.selfMute || st?.mute ? "🔇" : ""}${st?.selfDeaf || st?.deaf ? "🎧" : ""}${st?.selfVideo ? "📹" : ""}${st?.selfStream ? "🖥" : ""}`;

            row.append(av, label, icons);
            col.append(row);
        }
        return col;
    }));

    if (!channels.length)
        body.innerHTML = `<div style="opacity:0.55;font-size:12px;padding:16px;">No one's in voice here yet.</div>`;

    raf = requestAnimationFrame(render);
}

function buildPanel() {
    panel = document.createElement("div");
    panel.id = "vc-presence-radar";
    panel.style.cssText = `
        position: fixed; top: 64px; left: 50%; transform: translateX(-50%); z-index: 3050;
        width: min(880px, 94vw); max-height: 60vh; display: flex; flex-direction: column;
        background: rgba(10,8,20,0.9); backdrop-filter: blur(20px) saturate(1.4);
        border: 1px solid rgba(119,0,255,0.4); border-radius: 16px; overflow: hidden;
        font-family: var(--font-primary, sans-serif); color: #e8e4f5;
        box-shadow: 0 16px 50px rgba(0,0,0,0.6);
    `;

    const header = document.createElement("div");
    header.style.cssText = "display:flex;align-items:center;gap:8px;padding:10px 14px;cursor:grab;border-bottom:1px solid rgba(119,0,255,0.25);flex:none;";
    const title = document.createElement("div");
    title.innerHTML = `<span style="font-size:13px;font-weight:700;letter-spacing:1px;color:#b47aff;">📡 PRESENCE RADAR</span> <span style="font-size:10px;opacity:0.5;">click a channel to hop · green ring = talking</span>`;
    title.style.flex = "1";
    const close = document.createElement("button");
    close.textContent = "×";
    close.style.cssText = "background:rgba(119,0,255,0.2);border:none;color:#fff;border-radius:8px;width:26px;height:26px;font-size:15px;cursor:pointer;";
    close.onclick = () => hidePanel();
    header.append(title, close);

    let drag: [number, number] | null = null;
    header.onpointerdown = e => {
        if (e.target === close) return;
        drag = [e.clientX - panel!.offsetLeft, e.clientY - panel!.offsetTop];
        panel!.style.transform = "none";
        header.setPointerCapture(e.pointerId);
    };
    header.onpointermove = e => {
        if (!drag) return;
        panel!.style.left = e.clientX - drag[0] + "px";
        panel!.style.top = e.clientY - drag[1] + "px";
    };
    header.onpointerup = () => { drag = null; };

    body = document.createElement("div");
    body.style.cssText = "display:flex;gap:10px;padding:14px;overflow-x:auto;overflow-y:auto;flex:1;align-items:flex-start;";

    panel.append(header, body);
    document.body.append(panel);
}

function showPanel() {
    if (!panel) buildPanel();
    panel!.style.display = "flex";
    cancelAnimationFrame(raf);
    render();
}
function hidePanel() {
    if (panel) panel.style.display = "none";
    cancelAnimationFrame(raf);
}

export default definePlugin({
    name: "PresenceRadar",
    description: "Live top-down map of every voice channel in the current server: who's where, who's muted/streaming, and a green pulse ring on whoever's talking. Click a channel to hop in.",
    authors: [{ name: "nerdrx", id: 0n }],

    toolboxActions: {
        "📡 Toggle Presence Radar"() {
            if (panel && panel.style.display !== "none") hidePanel();
            else showPanel();
        }
    },

    flux: {
        SPEAKING(e: any) {
            if (e?.speakingFlags) speaking.set(e.userId, Date.now());
        }
    },

    stop() {
        cancelAnimationFrame(raf);
        panel?.remove();
        panel = body = null;
        speaking.clear();
    }
});
