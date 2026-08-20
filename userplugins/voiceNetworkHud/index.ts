/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 nerdrx and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { definePluginSettings } from "@api/Settings";
import definePlugin, { OptionType } from "@utils/types";
import { RTCConnectionStore, SelectedChannelStore, showToast, Toasts } from "@webpack/common";

const ACCENT = "#7700FF";

const settings = definePluginSettings({
    pollMs: {
        type: OptionType.NUMBER,
        description: "Stats poll interval in ms",
        default: 1000
    },
    autoShow: {
        type: OptionType.BOOLEAN,
        description: "Automatically show the HUD when you join a voice channel",
        default: true
    },
    hudPos: {
        type: OptionType.STRING,
        description: "Saved HUD position (internal)",
        default: "",
        hidden: true
    }
});

interface Metric {
    label: string;
    unit: string;
    series: number[];
    row?: HTMLElement;
    value?: HTMLElement;
    canvas?: HTMLCanvasElement;
    fmt(v: number): string;
}

const CAP = 90;
const metrics: Record<string, Metric> = {
    ping: { label: "Ping", unit: "ms", series: [], fmt: v => v.toFixed(0) },
    loss: { label: "Loss", unit: "%", series: [], fmt: v => v.toFixed(1) },
    jitter: { label: "Jitter", unit: "ms", series: [], fmt: v => v.toFixed(1) },
    out: { label: "Out", unit: "kbps", series: [], fmt: v => v.toFixed(0) },
    in: { label: "In", unit: "kbps", series: [], fmt: v => v.toFixed(0) }
};

let panel: HTMLDivElement | null = null;
let qualityDot: HTMLElement | null = null;
let pollTimer: ReturnType<typeof setInterval> | undefined;
let userHidden = false;
let prevPackets: { inbound: number; outbound: number; lost: number; } | null = null;
let prevBytes: { sent: number; recv: number; t: number; } | null = null;

/** Recursively harvest numeric fields from whatever shape the native stats object has */
function deepScan(obj: any) {
    const found = { jitter: 0, bytesSent: 0, bytesReceived: 0, availableOut: 0 };
    const seen = new Set<any>();
    const walk = (o: any, depth: number) => {
        if (!o || typeof o !== "object" || seen.has(o) || depth > 7) return;
        seen.add(o);
        for (const [k, v] of Object.entries(o)) {
            if (typeof v === "number" && isFinite(v)) {
                const key = k.toLowerCase();
                if (key.includes("jitter") && !key.includes("buffer")) found.jitter = Math.max(found.jitter, v);
                else if (key === "bytessent" || key === "bytes_sent") found.bytesSent += v;
                else if (key === "bytesreceived" || key === "bytes_received") found.bytesReceived += v;
                else if (key.includes("availableoutgoingbitrate")) found.availableOut = Math.max(found.availableOut, v);
            } else if (typeof v === "object") {
                walk(v, depth + 1);
            }
        }
    };
    walk(obj, 0);
    return found;
}

async function getRawStats(): Promise<any | null> {
    try {
        const conn = RTCConnectionStore.getRTCConnection?.();
        if (!conn?.getStats) return null;
        let stats = await conn.getStats();
        if (typeof stats === "string") stats = JSON.parse(stats);
        return stats;
    } catch {
        return null;
    }
}

function push(m: Metric, v: number) {
    m.series.push(v);
    if (m.series.length > CAP) m.series.shift();
    if (m.value) m.value.textContent = isFinite(v) ? `${m.fmt(v)} ${m.unit}` : "—";
    if (m.canvas) drawSpark(m.canvas, m.series);
}

function drawSpark(canvas: HTMLCanvasElement, series: number[]) {
    const ctx = canvas.getContext("2d")!;
    const { width: w, height: h } = canvas;
    ctx.clearRect(0, 0, w, h);
    if (series.length < 2) return;
    const max = Math.max(...series, 1e-6);
    ctx.beginPath();
    series.forEach((v, i) => {
        const x = (i / (CAP - 1)) * w;
        const y = h - 2 - (v / max) * (h - 6);
        i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    });
    ctx.strokeStyle = ACCENT;
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.lineTo((series.length - 1) / (CAP - 1) * w, h);
    ctx.lineTo(0, h);
    ctx.closePath();
    ctx.fillStyle = "rgba(119,0,255,0.15)";
    ctx.fill();
}

async function tick() {
    const inVC = !!SelectedChannelStore.getVoiceChannelId();
    if (!inVC) {
        prevPackets = prevBytes = null;
        if (panel) panel.style.display = "none";
        userHidden = false;
        return;
    }
    if (settings.store.autoShow && !userHidden) showPanel();
    if (!panel || panel.style.display === "none") return;

    push(metrics.ping, RTCConnectionStore.getLastPing?.() ?? NaN);

    const p = RTCConnectionStore.getPacketStats?.();
    if (p && prevPackets) {
        const dTotal = (p.inbound - prevPackets.inbound) + (p.outbound - prevPackets.outbound) + (p.lost - prevPackets.lost);
        const dLost = p.lost - prevPackets.lost;
        push(metrics.loss, dTotal > 0 ? (dLost / dTotal) * 100 : 0);
    }
    if (p) prevPackets = { ...p };

    const raw = await getRawStats();
    if (raw) {
        const s = deepScan(raw);
        // WebRTC-standard jitter is in seconds; native builds sometimes report ms
        push(metrics.jitter, s.jitter < 1 ? s.jitter * 1000 : s.jitter);
        const now = Date.now();
        if (prevBytes && now > prevBytes.t) {
            const dt = (now - prevBytes.t) / 1000;
            push(metrics.out, (s.bytesSent - prevBytes.sent) * 8 / 1000 / dt);
            push(metrics.in, (s.bytesReceived - prevBytes.recv) * 8 / 1000 / dt);
        }
        prevBytes = { sent: s.bytesSent, recv: s.bytesReceived, t: now };
    }

    if (qualityDot) {
        const ping = RTCConnectionStore.getLastPing?.() ?? 999;
        const loss = metrics.loss.series.at(-1) ?? 0;
        qualityDot.style.background =
            ping < 90 && loss < 1 ? "#2ecc71"
                : ping < 200 && loss < 5 ? "#f1c40f"
                    : "#e74c3c";
    }
}

function buildPanel() {
    panel = document.createElement("div");
    panel.id = "vc-nethud";
    panel.style.cssText = `
        position: fixed; top: 60px; right: 20px; z-index: 3000; width: 230px;
        background: rgba(10, 8, 20, 0.78); backdrop-filter: blur(16px) saturate(1.4);
        border: 1px solid rgba(119, 0, 255, 0.35); border-radius: 14px;
        font-family: var(--font-primary, sans-serif); color: #e8e4f5;
        box-shadow: 0 8px 32px rgba(0,0,0,0.5); user-select: none;
    `;
    try {
        const [x, y] = JSON.parse(settings.store.hudPos || "[]");
        if (typeof x === "number") { panel.style.left = x + "px"; panel.style.top = y + "px"; panel.style.right = "auto"; }
    } catch { }

    const header = document.createElement("div");
    header.style.cssText = "display:flex;align-items:center;gap:8px;padding:8px 12px;cursor:grab;border-bottom:1px solid rgba(119,0,255,0.2);font-size:11px;font-weight:700;letter-spacing:1.5px;";
    qualityDot = document.createElement("span");
    qualityDot.style.cssText = "width:8px;height:8px;border-radius:50%;background:#888;flex:none;";
    const title = document.createElement("span");
    title.textContent = "VOICE NET";
    title.style.color = ACCENT.replace("FF", "ff");
    title.style.cssText += `color:#b47aff;flex:1;`;
    const close = document.createElement("span");
    close.textContent = "×";
    close.style.cssText = "cursor:pointer;font-size:14px;opacity:0.6;";
    close.onclick = () => { userHidden = true; panel!.style.display = "none"; };
    header.append(qualityDot, title, close);
    panel.append(header);

    // dragging
    let drag: [number, number] | null = null;
    header.onpointerdown = e => {
        if (e.target === close) return;
        drag = [e.clientX - panel!.offsetLeft, e.clientY - panel!.offsetTop];
        header.setPointerCapture(e.pointerId);
    };
    header.onpointermove = e => {
        if (!drag) return;
        panel!.style.left = e.clientX - drag[0] + "px";
        panel!.style.top = e.clientY - drag[1] + "px";
        panel!.style.right = "auto";
    };
    header.onpointerup = () => {
        drag = null;
        settings.store.hudPos = JSON.stringify([panel!.offsetLeft, panel!.offsetTop]);
    };

    for (const m of Object.values(metrics)) {
        const row = document.createElement("div");
        row.style.cssText = "display:flex;align-items:center;gap:8px;padding:5px 12px;";
        const label = document.createElement("span");
        label.textContent = m.label;
        label.style.cssText = "font-size:11px;opacity:0.7;width:38px;flex:none;";
        m.canvas = document.createElement("canvas");
        m.canvas.width = 100; m.canvas.height = 22;
        m.canvas.style.cssText = "flex:1;height:22px;";
        m.value = document.createElement("span");
        m.value.textContent = "—";
        m.value.style.cssText = "font-size:11px;font-variant-numeric:tabular-nums;text-align:right;width:58px;flex:none;color:#cbb8ff;";
        row.append(label, m.canvas, m.value);
        m.row = row;
        panel.append(row);
    }
    panel.lastElementChild!.setAttribute("style", (panel.lastElementChild as HTMLElement).style.cssText + "padding-bottom:10px;");
    document.body.append(panel);
}

function showPanel() {
    if (!panel) buildPanel();
    panel!.style.display = "block";
}

function destroyPanel() {
    panel?.remove();
    panel = qualityDot = null;
    for (const m of Object.values(metrics)) {
        m.series.length = 0;
        m.row = m.value = m.canvas = undefined;
    }
}

export default definePlugin({
    name: "VoiceNetworkHUD",
    description: "Live overlay graphing your voice connection's network internals: ping, packet loss, jitter and bitrate.",
    authors: [{ name: "nerdrx", id: 0n }],
    settings,

    toolboxActions: {
        "📡 Toggle Voice HUD"() {
            if (panel && panel.style.display !== "none") {
                userHidden = true;
                panel.style.display = "none";
            } else {
                userHidden = false;
                showPanel();
            }
        },
        async "🔬 Dump raw voice stats to console"() {
            const raw = await getRawStats();
            console.log("[VoiceNetworkHUD] raw stats:", raw);
            showToast(raw ? "Raw stats dumped to console (Ctrl+Shift+I)" : "No active voice connection", raw ? Toasts.Type.SUCCESS : Toasts.Type.FAILURE);
        }
    },

    start() {
        userHidden = false;
        pollTimer = setInterval(tick, Math.max(250, settings.store.pollMs));
    },

    stop() {
        clearInterval(pollTimer);
        destroyPanel();
        prevPackets = prevBytes = null;
    }
});
