/*
 * ServerDeclutter – shared UI building blocks (icons, number field, guild icon, job hook)
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./ui.css";

import { classNameFactory } from "@api/Styles";
import { useEffect, useRef, useState } from "@webpack/common";

import { ICONS as UI_ICONS, TextField } from "../_ui";
import { BulkProgress, CancelToken, createToken, releaseToken } from "./actions";

export const cl = classNameFactory("vc-serverdeclutter-");

export const ICON_COLOR = "teal";

// ---------------------------------------------------------------- Icons

export const ICONS = {
    ...UI_ICONS,
    broom: "M19.36 2.72 20.78 4.14 15.06 9.85C16.13 11.39 16.28 13.24 15.38 14.44L9.06 8.12C10.26 7.22 12.11 7.37 13.65 8.44L19.36 2.72M5.93 17.57C3.92 15.56 2.69 13.16 2.35 10.92L7.23 8.83L14.67 16.27L12.58 21.15C10.34 20.81 7.94 19.58 5.93 17.57Z",
    bellOff: "M20 18.69 7.84 6.14 5.27 3.49 4 4.76l2.8 2.8v.01c-.52.99-.8 2.16-.8 3.42v5l-2 2v1h13.73l2 2L21 19.72l-1-1.03zM12 22c1.11 0 2-.89 2-2h-4c0 1.11.89 2 2 2zm6-7.32V11c0-3.08-1.64-5.64-4.5-6.32V4c0-.83-.67-1.5-1.5-1.5s-1.5.67-1.5 1.5v.68c-.15.03-.29.08-.42.12-.1.03-.2.07-.3.11h-.01c-.01 0-.01 0-.02.01-.23.09-.46.2-.68.31 0 0-.01 0-.01.01L18 14.68z",
    leave: "M10.09 15.59 11.5 17l5-5-5-5-1.41 1.41L12.67 11H3v2h9.67l-2.58 2.59zM19 3H5a2 2 0 0 0-2 2v4h2V5h14v14H5v-4H3v4a2 2 0 0 0 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2z",
    stop: "M6 6h12v12H6z",
    crown: "M5 16 3 5l5.5 5L12 4l3.5 6L21 5l-2 11H5zm14 3c0 .6-.4 1-1 1H6c-.6 0-1-.4-1-1v-1h14v1z",
    arrowUp: "M7 14l5-5 5 5z",
    arrowDown: "M7 10l5 5 5-5z"
};

// ---------------------------------------------------------------- Building blocks

export function NumberField({ value, onChange, min, max, suffix }: { value: number; onChange(v: number): void; min: number; max: number; suffix?: string; }) {
    const [text, setText] = useState(String(value));
    useEffect(() => setText(String(value)), [value]);
    const commit = () => {
        const n = Math.round(Number(text));
        const clamped = Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : value;
        setText(String(clamped));
        if (clamped !== value) onChange(clamped);
    };
    return (
        <span className={cl("number")}>
            <TextField
                type="number"
                value={text}
                min={min}
                max={max}
                onChange={setText}
                onBlur={commit}
                onKeyDown={e => e.key === "Enter" && commit()}
            />
            {suffix && <span className={cl("muted")}>{suffix}</span>}
        </span>
    );
}

export function GuildIcon({ id, icon, name, size = 28 }: { id: string; icon: string | null; name: string; size?: number; }) {
    if (icon) {
        return <img className={cl("guild-icon")} width={size} height={size} src={`https://cdn.discordapp.com/icons/${id}/${icon}.webp?size=64`} alt="" loading="lazy" />;
    }
    const acronym = name.split(/\s+/).map(w => w[0] ?? "").join("").slice(0, 3);
    return <span className={cl("guild-icon")} style={{ width: size, height: size }}>{acronym}</span>;
}

// ---------------------------------------------------------------- Job hook

export interface LogEntry {
    id: number;
    kind: "ok" | "warn" | "error";
    text: string;
}

export interface JobState extends BulkProgress {
    running: boolean;
    title: string;
    log: LogEntry[];
}

let logId = 0;

/** A cancellable job with progress – it is cancelled when the window is closed */
export function useJob() {
    const [state, setState] = useState<JobState>({ running: false, title: "", done: 0, total: 0, label: "", log: [] });
    const tokenRef = useRef<CancelToken | null>(null);
    const mounted = useRef(true);

    useEffect(() => () => {
        mounted.current = false;
        tokenRef.current?.cancel();
    }, []);

    const update = (patch: Partial<JobState> | ((s: JobState) => Partial<JobState>)) => {
        if (!mounted.current) return;
        setState(s => ({ ...s, ...(typeof patch === "function" ? patch(s) : patch) }));
    };

    const log = (kind: LogEntry["kind"], text: string) =>
        update(s => ({ log: [...s.log, { id: ++logId, kind, text }].slice(-300) }));

    async function run<T>(title: string, total: number, fn: (token: CancelToken, hooks: { onProgress(p: BulkProgress): void; onLog: typeof log; }) => Promise<T>): Promise<T | null> {
        if (tokenRef.current) return null;
        const token = createToken();
        tokenRef.current = token;
        update({ running: true, title, done: 0, total, label: "Starting …", log: [] });
        try {
            return await fn(token, { onProgress: p => update(p), onLog: log });
        } finally {
            releaseToken(token);
            tokenRef.current = null;
            update({ running: false });
        }
    }

    return {
        state,
        run,
        cancel: () => tokenRef.current?.cancel(),
        clearLog: () => update({ log: [] })
    };
}
