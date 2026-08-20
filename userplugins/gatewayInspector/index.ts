/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 nerdrx and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { definePluginSettings } from "@api/Settings";
import definePlugin, { OptionType } from "@utils/types";
import { FluxDispatcher } from "@webpack/common";

const MAX_ROWS = 300;

const settings = definePluginSettings({
    paused: {
        type: OptionType.BOOLEAN,
        description: "Start paused",
        default: false
    }
});

interface Row {
    type: string;
    payload: any;
    t: number;
}

let panel: HTMLDivElement | null = null;
let listEl: HTMLElement | null = null;
let statusEl: HTMLElement | null = null;
const rows: Row[] = [];
const counts = new Map<string, number>();
let paused = false;
let filter = "";
let interceptor: ((e: any) => any) | null = null;

function onEvent(e: any) {
    const type = e?.type ?? "(no type)";
    counts.set(type, (counts.get(type) ?? 0) + 1);
    if (paused) return false;

    rows.unshift({ type, payload: e, t: Date.now() });
    if (rows.length > MAX_ROWS) rows.pop();
    if (panel) renderList();
    return false; // never block the event
}

function matches(type: string) {
    if (!filter) return true;
    const f = filter.toLowerCase();
    if (f.startsWith("!")) return !type.toLowerCase().includes(f.slice(1));
    return type.toLowerCase().includes(f);
}

function fmtTime(t: number) {
    const d = new Date(t);
    return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}`;
}

function renderList() {
    if (!listEl || !statusEl) return;
    const shown = rows.filter(r => matches(r.type));
    statusEl.textContent = `${shown.length} shown · ${counts.size} types · ${[...counts.values()].reduce((a, b) => a + b, 0)} total${paused ? " · ⏸ PAUSED" : ""}`;

    listEl.replaceChildren(...shown.slice(0, 120).map(r => {
        const row = document.createElement("div");
        row.style.cssText = "border-bottom:1px solid rgba(119,0,255,0.12);padding:4px 8px;font-family:var(--font-code,monospace);font-size:11px;cursor:pointer;";
        const head = document.createElement("div");
        head.style.cssText = "display:flex;gap:8px;align-items:baseline;";
        const time = document.createElement("span");
        time.textContent = fmtTime(r.t);
        time.style.cssText = "opacity:0.4;flex:none;";
        const type = document.createElement("span");
        type.textContent = r.type;
        type.style.cssText = "color:#b47aff;font-weight:600;word-break:break-all;";
        const cnt = document.createElement("span");
        cnt.textContent = `×${counts.get(r.type)}`;
        cnt.style.cssText = "opacity:0.4;margin-left:auto;flex:none;";
        head.append(time, type, cnt);

        const body = document.createElement("pre");
        body.style.cssText = "display:none;margin:4px 0 2px;padding:6px;background:rgba(0,0,0,0.35);border-radius:6px;max-height:220px;overflow:auto;white-space:pre-wrap;word-break:break-all;color:#cbb8ff;";
        let built = false;
        row.onclick = () => {
            if (!built) {
                try {
                    body.textContent = JSON.stringify(r.payload, (_k, v) => typeof v === "bigint" ? String(v) : v, 2);
                } catch { body.textContent = String(r.payload); }
                built = true;
            }
            body.style.display = body.style.display === "none" ? "block" : "none";
        };
        row.append(head, body);
        return row;
    }));
}

function buildPanel() {
    panel = document.createElement("div");
    panel.id = "vc-gateway-inspector";
    panel.style.cssText = `
        position: fixed; bottom: 20px; left: 20px; z-index: 3000; width: 420px; height: 460px;
        display: flex; flex-direction: column;
        background: rgba(10, 8, 20, 0.86); backdrop-filter: blur(18px) saturate(1.4);
        border: 1px solid rgba(119,0,255,0.4); border-radius: 14px; overflow: hidden;
        font-family: var(--font-primary, sans-serif); color: #e8e4f5;
        box-shadow: 0 12px 40px rgba(0,0,0,0.55);
    `;

    const header = document.createElement("div");
    header.style.cssText = "display:flex;align-items:center;gap:8px;padding:8px 12px;cursor:grab;border-bottom:1px solid rgba(119,0,255,0.25);flex:none;";
    const title = document.createElement("span");
    title.textContent = "⚡ GATEWAY INSPECTOR";
    title.style.cssText = "font-size:11px;font-weight:700;letter-spacing:1.2px;color:#b47aff;flex:1;";

    const pauseBtn = document.createElement("button");
    const clearBtn = document.createElement("button");
    const closeBtn = document.createElement("button");
    for (const b of [pauseBtn, clearBtn, closeBtn])
        b.style.cssText = "background:rgba(119,0,255,0.18);border:none;color:#e8e4f5;border-radius:6px;padding:3px 8px;font-size:11px;cursor:pointer;";
    pauseBtn.textContent = paused ? "▶" : "⏸";
    clearBtn.textContent = "clear";
    closeBtn.textContent = "×";
    pauseBtn.onclick = () => { paused = !paused; pauseBtn.textContent = paused ? "▶" : "⏸"; renderList(); };
    clearBtn.onclick = () => { rows.length = 0; counts.clear(); renderList(); };
    closeBtn.onclick = () => hidePanel();
    header.append(title, pauseBtn, clearBtn, closeBtn);

    let drag: [number, number] | null = null;
    header.onpointerdown = e => {
        if (e.target !== header && e.target !== title) return;
        drag = [e.clientX - panel!.offsetLeft, e.clientY - panel!.offsetTop];
        header.setPointerCapture(e.pointerId);
    };
    header.onpointermove = e => {
        if (!drag) return;
        panel!.style.left = e.clientX - drag[0] + "px";
        panel!.style.top = e.clientY - drag[1] + "px";
        panel!.style.bottom = "auto";
    };
    header.onpointerup = () => { drag = null; };

    const search = document.createElement("input");
    search.placeholder = "filter by type…  (prefix ! to exclude, e.g. !TYPING)";
    search.style.cssText = "margin:8px;padding:6px 10px;border-radius:8px;border:1px solid rgba(119,0,255,0.3);background:rgba(0,0,0,0.3);color:#e8e4f5;font-size:12px;outline:none;flex:none;";
    search.oninput = () => { filter = search.value.trim(); renderList(); };

    statusEl = document.createElement("div");
    statusEl.style.cssText = "padding:0 12px 6px;font-size:10px;opacity:0.55;flex:none;";

    listEl = document.createElement("div");
    listEl.style.cssText = "flex:1;overflow-y:auto;";

    panel.append(header, search, statusEl, listEl);
    document.body.append(panel);
    renderList();
}

function showPanel() {
    if (!panel) buildPanel();
    panel!.style.display = "flex";
}
function hidePanel() {
    if (panel) panel.style.display = "none";
}

export default definePlugin({
    name: "GatewayInspector",
    description: "Wireshark for Discord: live, filterable feed of every flux/gateway event with expandable payloads and per-type counters.",
    authors: [{ name: "nerdrx", id: 0n }],
    settings,

    toolboxActions: {
        "⚡ Toggle Gateway Inspector"() {
            if (panel && panel.style.display !== "none") hidePanel();
            else showPanel();
        }
    },

    start() {
        paused = settings.store.paused;
        interceptor = onEvent;
        FluxDispatcher.addInterceptor(interceptor);
    },

    stop() {
        // FluxDispatcher has no removeInterceptor; neutralise our callback instead
        if (interceptor) {
            const d = FluxDispatcher as any;
            if (Array.isArray(d._interceptors))
                d._interceptors = d._interceptors.filter((i: any) => i !== interceptor);
        }
        interceptor = null;
        panel?.remove();
        panel = listEl = statusEl = null;
        rows.length = 0;
        counts.clear();
    }
});
