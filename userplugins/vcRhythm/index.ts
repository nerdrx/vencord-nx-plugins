/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 nerdrx and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { createStore, get, set } from "@api/DataStore";
import definePlugin from "@utils/types";
import { ChannelStore, showToast, Toasts, UserStore } from "@webpack/common";

const store = createStore("VCRhythm", "presence");
const KEY = "buckets";

/**
 * Storage model: per user, a Map of hour-bucket -> minutes present.
 * Bucket key = dayOfWeek(0-6) * 24 + hour(0-23)  → 168 weekly slots.
 * We accumulate wall-clock minutes any user spends in voice, sampled each minute.
 */
type Buckets = Record<string, { name: string; slots: Record<number, number>; total: number; last: number; }>;

let data: Buckets = {};
let sampler: ReturnType<typeof setInterval> | undefined;
let dirty = false;

// userId -> channelId currently occupied (from our own voice-state view)
const present = new Map<string, string>();

async function load() {
    data = (await get<Buckets>(KEY, store)) ?? {};
}
async function persist() {
    if (!dirty) return;
    dirty = false;
    await set(KEY, data, store);
}

function bucketNow() {
    const d = new Date();
    return d.getDay() * 24 + d.getHours();
}

function sample() {
    if (present.size === 0) return;
    const slot = bucketNow();
    const now = Date.now();
    for (const uid of present.keys()) {
        const rec = data[uid] ??= { name: uid, slots: {}, total: 0, last: 0 };
        const user = UserStore.getUser(uid);
        if (user) rec.name = user.username ?? rec.name;
        rec.slots[slot] = (rec.slots[slot] ?? 0) + 1; // +1 minute
        rec.total += 1;
        rec.last = now;
    }
    dirty = true;
}

export default definePlugin({
    name: "VCRhythm",
    description: "Passively logs who's in voice and when (stored locally), then renders per-user weekly activity heatmaps. Data builds up from the day you enable it.",
    authors: [{ name: "nerdrx", id: 0n }],

    flux: {
        VOICE_STATE_UPDATES({ voiceStates }: { voiceStates: Array<{ userId: string; channelId?: string | null; oldChannelId?: string | null; }>; }) {
            for (const s of voiceStates) {
                if (s.channelId) present.set(s.userId, s.channelId);
                else present.delete(s.userId);
            }
        }
    },

    toolboxActions: {
        "📊 Show VC Rhythm"() {
            showHeatmaps();
        },
        async "🗑 Reset VC Rhythm data"() {
            data = {};
            dirty = true;
            await persist();
            showToast("VCRhythm: history cleared", Toasts.Type.SUCCESS);
        }
    },

    async start() {
        await load();
        sampler = setInterval(() => { sample(); persist(); }, 60_000);
    },

    async stop() {
        clearInterval(sampler);
        await persist();
        document.getElementById("vc-rhythm-panel")?.remove();
    }
});

function heat(v: number, max: number) {
    if (v <= 0) return "rgba(255,255,255,0.05)";
    const t = Math.min(1, v / max);
    // interpolate transparent-violet -> full accent
    const a = 0.15 + t * 0.85;
    return `rgba(119,0,255,${a.toFixed(3)})`;
}

function showHeatmaps() {
    document.getElementById("vc-rhythm-panel")?.remove();

    const panel = document.createElement("div");
    panel.id = "vc-rhythm-panel";
    panel.style.cssText = `
        position: fixed; top: 8%; left: 50%; transform: translateX(-50%); z-index: 3100;
        width: min(760px, 92vw); max-height: 84vh; overflow-y: auto;
        background: rgba(10,8,20,0.9); backdrop-filter: blur(20px) saturate(1.4);
        border: 1px solid rgba(119,0,255,0.4); border-radius: 16px; padding: 18px;
        font-family: var(--font-primary, sans-serif); color: #e8e4f5;
        box-shadow: 0 16px 50px rgba(0,0,0,0.6);
    `;

    const header = document.createElement("div");
    header.style.cssText = "display:flex;align-items:center;margin-bottom:14px;";
    const title = document.createElement("div");
    title.innerHTML = `<div style="font-size:15px;font-weight:700;letter-spacing:0.5px;color:#b47aff;">VC RHYTHM</div><div style="font-size:11px;opacity:0.55;">weekly voice presence · times are your local timezone</div>`;
    title.style.flex = "1";
    const close = document.createElement("button");
    close.textContent = "×";
    close.style.cssText = "background:rgba(119,0,255,0.2);border:none;color:#fff;border-radius:8px;width:28px;height:28px;font-size:16px;cursor:pointer;";
    close.onclick = () => panel.remove();
    header.append(title, close);
    panel.append(header);

    const users = Object.entries(data).sort((a, b) => b[1].total - a[1].total);
    if (!users.length) {
        const empty = document.createElement("div");
        empty.textContent = "No data yet. Stay in (or watch) voice channels for a while and check back — it samples once a minute.";
        empty.style.cssText = "opacity:0.6;font-size:13px;padding:20px 4px;";
        panel.append(empty);
        document.body.append(panel);
        return;
    }

    const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

    for (const [uid, rec] of users) {
        const max = Math.max(1, ...Object.values(rec.slots));
        const card = document.createElement("div");
        card.style.cssText = "margin-bottom:16px;padding:12px;background:rgba(255,255,255,0.03);border-radius:12px;";

        const name = document.createElement("div");
        const hrs = (rec.total / 60);
        name.innerHTML = `<span style="font-weight:600;color:#cbb8ff;">${rec.name}</span> <span style="opacity:0.5;font-size:11px;">· ${hrs >= 1 ? hrs.toFixed(1) + "h" : rec.total + "m"} logged</span>`;
        name.style.marginBottom = "8px";
        card.append(name);

        const grid = document.createElement("div");
        grid.style.cssText = "display:grid;grid-template-columns:34px repeat(24,1fr);gap:2px;align-items:center;";

        // header row: hours
        grid.append(document.createElement("div"));
        for (let h = 0; h < 24; h++) {
            const c = document.createElement("div");
            if (h % 6 === 0) { c.textContent = String(h); c.style.cssText = "font-size:8px;opacity:0.4;text-align:center;"; }
            grid.append(c);
        }

        for (let d = 0; d < 7; d++) {
            const lbl = document.createElement("div");
            lbl.textContent = days[d];
            lbl.style.cssText = "font-size:9px;opacity:0.5;";
            grid.append(lbl);
            for (let h = 0; h < 24; h++) {
                const v = rec.slots[d * 24 + h] ?? 0;
                const cell = document.createElement("div");
                cell.style.cssText = `aspect-ratio:1;border-radius:2px;background:${heat(v, max)};`;
                if (v > 0) cell.title = `${days[d]} ${h}:00 — ${v} min`;
                grid.append(cell);
            }
        }
        card.append(grid);
        panel.append(card);
    }

    document.body.append(panel);
}
