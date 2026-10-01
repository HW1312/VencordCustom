/*
 * ServerDeclutter – shared UI building blocks (icons, buttons, progress, job hook)
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./ui.css";

import { classNameFactory } from "@api/Styles";
import { classes } from "@utils/misc";
import { useEffect, useRef, useState } from "@webpack/common";
import type { ReactNode } from "react";

import { BulkProgress, CancelToken, createToken, releaseToken } from "./actions";

export const cl = classNameFactory("vc-serverdeclutter-");

// ---------------------------------------------------------------- Icons

export const ICONS = {
    broom: "M19.36 2.72 20.78 4.14 15.06 9.85C16.13 11.39 16.28 13.24 15.38 14.44L9.06 8.12C10.26 7.22 12.11 7.37 13.65 8.44L19.36 2.72M5.93 17.57C3.92 15.56 2.69 13.16 2.35 10.92L7.23 8.83L14.67 16.27L12.58 21.15C10.34 20.81 7.94 19.58 5.93 17.57Z",
    bell: "M12 22a2 2 0 0 0 2-2h-4a2 2 0 0 0 2 2zm6-6V11c0-3.07-1.64-5.64-4.5-6.32V4a1.5 1.5 0 0 0-3 0v.68C7.63 5.36 6 7.92 6 11v5l-2 2v1h16v-1l-2-2z",
    bellOff: "M20 18.69 7.84 6.14 5.27 3.49 4 4.76l2.8 2.8v.01c-.52.99-.8 2.16-.8 3.42v5l-2 2v1h13.73l2 2L21 19.72l-1-1.03zM12 22c1.11 0 2-.89 2-2h-4c0 1.11.89 2 2 2zm6-7.32V11c0-3.08-1.64-5.64-4.5-6.32V4c0-.83-.67-1.5-1.5-1.5s-1.5.67-1.5 1.5v.68c-.15.03-.29.08-.42.12-.1.03-.2.07-.3.11h-.01c-.01 0-.01 0-.02.01-.23.09-.46.2-.68.31 0 0-.01 0-.01.01L18 14.68z",
    check: "M9 16.17 4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z",
    folder: "M10 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z",
    leave: "M10.09 15.59 11.5 17l5-5-5-5-1.41 1.41L12.67 11H3v2h9.67l-2.58 2.59zM19 3H5a2 2 0 0 0-2 2v4h2V5h14v14H5v-4H3v4a2 2 0 0 0 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2z",
    search: "M15.5 14h-.79l-.28-.27A6.47 6.47 0 0 0 16 9.5 6.5 6.5 0 1 0 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z",
    stop: "M6 6h12v12H6z",
    refresh: "M17.65 6.35A7.958 7.958 0 0 0 12 4a8 8 0 1 0 7.74 10h-2.08A5.99 5.99 0 0 1 12 18c-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z",
    warning: "M1 21h22L12 2 1 21zm12-3h-2v-2h2v2zm0-4h-2v-4h2v4z",
    info: "M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-6h2v6zm0-8h-2V7h2v2z",
    crown: "M5 16 3 5l5.5 5L12 4l3.5 6L21 5l-2 11H5zm14 3c0 .6-.4 1-1 1H6c-.6 0-1-.4-1-1v-1h14v1z",
    arrowUp: "M7 14l5-5 5 5z",
    arrowDown: "M7 10l5 5 5-5z",
    close: "M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"
};

export type IconName = keyof typeof ICONS;

export function Icon({ name, size = 18, className }: { name: IconName; size?: number; className?: string; }) {
    return (
        <svg viewBox="0 0 24 24" width={size} height={size} className={classes(cl("icon"), className)} aria-hidden>
            <path fill="currentColor" d={ICONS[name]} />
        </svg>
    );
}

// ---------------------------------------------------------------- Building blocks

export function Button({ children, icon, variant = "primary", small, disabled, onClick, title }: {
    children?: ReactNode;
    icon?: IconName;
    variant?: "primary" | "ghost" | "danger" | "success";
    small?: boolean;
    disabled?: boolean;
    title?: string;
    onClick?(): void;
}) {
    return (
        <button
            className={classes(cl("btn"), cl(`btn-${variant}`), small && cl("btn-small"))}
            disabled={disabled}
            onClick={onClick}
            title={title}
        >
            {icon && <Icon name={icon} size={small ? 14 : 16} />}
            {children}
        </button>
    );
}

export function IconButton({ icon, title, onClick, danger, disabled }: { icon: IconName; title: string; onClick(): void; danger?: boolean; disabled?: boolean; }) {
    return (
        <button
            className={classes(cl("icon-btn"), danger && cl("icon-btn-danger"))}
            title={title}
            aria-label={title}
            disabled={disabled}
            onClick={e => {
                e.stopPropagation();
                onClick();
            }}
        >
            <Icon name={icon} size={16} />
        </button>
    );
}

export function Notice({ tone = "info", children }: { tone?: "info" | "warn" | "danger"; children: ReactNode; }) {
    return (
        <div className={classes(cl("notice"), cl(`notice-${tone}`))}>
            <Icon name={tone === "info" ? "info" : "warning"} size={16} />
            <div>{children}</div>
        </div>
    );
}

export function Stat({ label, value }: { label: string; value: ReactNode; }) {
    return (
        <div className={cl("stat")}>
            <span className={cl("stat-value")}>{value}</span>
            <span className={cl("stat-label")}>{label}</span>
        </div>
    );
}

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
            <input
                type="number"
                className={cl("input")}
                value={text}
                min={min}
                max={max}
                onChange={e => setText(e.currentTarget.value)}
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

export function ProgressBar({ done, total, label }: { done: number; total: number; label?: ReactNode; }) {
    const pct = total > 0 ? Math.min(100, Math.round(done / total * 100)) : 0;
    return (
        <div className={cl("progress")}>
            <div className={cl("progress-head")}>
                <span className={cl("progress-label")}>{label}</span>
                <span className={cl("muted")}>{done} / {total} · {pct}%</span>
            </div>
            <div className={cl("progress-track")}>
                <div className={cl("progress-fill")} style={{ width: `${pct}%` }} />
            </div>
        </div>
    );
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
