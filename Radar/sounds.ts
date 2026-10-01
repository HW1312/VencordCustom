/*
 * Radar – short sounds generated with WebAudio (no files, no external requests)
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { logger } from "./store";

interface Note {
    /** Frequency in Hz */
    f: number;
    /** Start in seconds */
    t: number;
    /** Duration in seconds */
    d: number;
    wave?: OscillatorType;
    /** Relative volume 0–1 */
    g?: number;
}

export type SoundId = "ping" | "chime" | "pop" | "bell" | "blip" | "alarm" | "radar";

export const SOUNDS: Record<SoundId, { label: string; notes: Note[]; }> = {
    ping: {
        label: "Ping",
        notes: [{ f: 1318, t: 0, d: 0.18 }, { f: 1760, t: 0.07, d: 0.22, g: 0.7 }]
    },
    chime: {
        label: "Bright chime",
        notes: [{ f: 784, t: 0, d: 0.35 }, { f: 988, t: 0.12, d: 0.35 }, { f: 1175, t: 0.24, d: 0.5 }]
    },
    pop: {
        label: "Pop",
        notes: [{ f: 420, t: 0, d: 0.09, wave: "triangle" }, { f: 640, t: 0.05, d: 0.08, wave: "triangle", g: 0.6 }]
    },
    bell: {
        label: "Gong",
        notes: [{ f: 523, t: 0, d: 0.9, g: 0.8 }, { f: 1046, t: 0, d: 0.6, g: 0.25 }, { f: 1568, t: 0, d: 0.4, g: 0.12 }]
    },
    blip: {
        label: "Blip",
        notes: [{ f: 1000, t: 0, d: 0.06, wave: "square", g: 0.35 }, { f: 1500, t: 0.08, d: 0.06, wave: "square", g: 0.35 }]
    },
    alarm: {
        label: "Alarm",
        notes: [0, 0.18, 0.36, 0.54].map((t, i) => ({ f: i % 2 ? 660 : 880, t, d: 0.14, wave: "sawtooth" as OscillatorType, g: 0.45 }))
    },
    radar: {
        label: "Radar",
        notes: [{ f: 1200, t: 0, d: 0.25, g: 0.8 }, { f: 1200, t: 0.3, d: 0.18, g: 0.35 }, { f: 1200, t: 0.52, d: 0.12, g: 0.15 }]
    }
};

export const SOUND_OPTIONS = (Object.keys(SOUNDS) as SoundId[]).map(id => ({ value: id, label: SOUNDS[id].label }));

let ctx: AudioContext | null = null;

export function playSound(id: string, volume = 60) {
    const sound = SOUNDS[id as SoundId] ?? SOUNDS.ping;
    try {
        ctx ??= new AudioContext();
        if (ctx.state === "suspended") void ctx.resume();

        const master = ctx.createGain();
        master.gain.value = Math.max(0, Math.min(100, volume)) / 100 * 0.5;
        master.connect(ctx.destination);

        const now = ctx.currentTime + 0.02;
        let end = now;
        for (const n of sound.notes) {
            const osc = ctx.createOscillator();
            const gain = ctx.createGain();
            osc.type = n.wave ?? "sine";
            osc.frequency.value = n.f;

            // Short fade-in, then exponential decay (no crackling)
            const start = now + n.t;
            const peak = n.g ?? 1;
            gain.gain.setValueAtTime(0.0001, start);
            gain.gain.exponentialRampToValueAtTime(peak, start + 0.01);
            gain.gain.exponentialRampToValueAtTime(0.0001, start + n.d);

            osc.connect(gain);
            gain.connect(master);
            osc.start(start);
            osc.stop(start + n.d + 0.02);
            end = Math.max(end, start + n.d + 0.05);
        }

        setTimeout(() => master.disconnect(), (end - now) * 1000 + 200);
    } catch (e) {
        logger.error("Could not play sound", e);
    }
}

export function closeAudio() {
    ctx?.close().catch(() => { });
    ctx = null;
}
