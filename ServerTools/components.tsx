/*
 * ServerTools – shared UI building blocks on top of the _ui kit (icons, progress, log, job hook)
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./ui.css";

import { classNameFactory } from "@api/Styles";
import { classes } from "@utils/misc";
import { useEffect, useRef, useState } from "@webpack/common";
import type { ReactNode } from "react";

import { Badge, Button as UiButton, Icon as UiIcon, Note, Progress, Section, Segmented as UiSegmented, Spinner, ToggleRow as UiToggleRow, UiColor } from "../_ui";
import type { JobHooks, LogKind } from "./backup";
import { CancelToken, createToken, describeError, isCancelled, onQueueChange, queueState, releaseToken } from "./queue";

export const cl = classNameFactory("vc-servertools-");

/** App icon color of ServerTools in the kit */
export const ICON_COLOR: UiColor = "orange";

// ---------------------------------------------------------------- Icons

export const ICONS = {
    archive: "M20.54 5.23 19.15 3.55C18.88 3.21 18.47 3 18 3H6c-.47 0-.88.21-1.16.55L3.46 5.23C3.17 5.57 3 6.02 3 6.5V19c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V6.5c0-.48-.17-.93-.46-1.27zM12 17.5 6.5 12H10v-2h4v2h3.5L12 17.5zM5.12 5l.81-1h12l.94 1H5.12z",
    restore: "M13 3a9 9 0 0 0-9 9H1l3.89 3.89.07.14L9 12H6c0-3.87 3.13-7 7-7s7 3.13 7 7-3.13 7-7 7c-1.93 0-3.68-.79-4.94-2.06l-1.42 1.42A8.954 8.954 0 0 0 13 21a9 9 0 0 0 0-18zm-1 5v5l4.28 2.54.72-1.21-3.5-2.08V8H12z",
    pulse: "M3 13h3.5l2-6 4 12 2.5-8 1.5 2H21v-2h-3.5l-2.5-3.5-2.5 8-4-12L5.1 11H3z",
    gift: "M20 7h-2.18A3 3 0 0 0 12 3.76 3 3 0 0 0 6.18 7H4a2 2 0 0 0-2 2v2a1 1 0 0 0 1 1h8V7h2v5h8a1 1 0 0 0 1-1V9a2 2 0 0 0-2-2zM9 7a1 1 0 1 1 1-1v1H9zm6 0h-1V6a1 1 0 1 1 1 1zM3 14v5a2 2 0 0 0 2 2h6v-7H3zm10 7h6a2 2 0 0 0 2-2v-5h-8v7z",
    download: "M5 20h14v-2H5v2zM19 9h-4V3H9v6H5l7 7 7-7z",
    upload: "M5 20h14v-2H5v2zm0-10h4v6h6v-6h4l-7-7-7 7z",
    warning: "M1 21h22L12 2 1 21zm12-3h-2v-2h2v2zm0-4h-2v-4h2v4z",
    check: "M9 16.17 4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z",
    close: "M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z",
    stop: "M6 6h12v12H6z",
    play: "M8 5v14l11-7z",
    copy: "M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z",
    send: "M2.01 21 23 12 2.01 3 2 10l15 2-15 2z",
    dice: "M19 3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zM7.5 18a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3zm0-9a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3zm4.5 4.5a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3zm4.5 4.5a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3zm0-9a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3z",
    refresh: "M17.65 6.35A7.958 7.958 0 0 0 12 4a8 8 0 1 0 7.74 10h-2.08A5.99 5.99 0 0 1 12 18c-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z",
    table: "M3 3v18h18V3H3zm8 16H5v-6h6v6zm0-8H5V5h6v6zm8 8h-6v-6h6v6zm0-8h-6V5h6v6z",
    shield: "M12 1 3 5v6c0 5.55 3.84 10.74 9 12 5.16-1.26 9-6.45 9-12V5l-9-4zm0 10.99h7c-.53 4.12-3.28 7.79-7 8.94V12H5V6.3l7-3.11v8.8z",
    tools: "M22.7 19 13.6 9.9c.9-2.3.4-5-1.5-6.9-2-2-5-2.4-7.4-1.3L9 6 6 9 1.6 4.7C.4 7.1.9 10.1 2.9 12.1c1.9 1.9 4.6 2.4 6.9 1.5l9.1 9.1c.4.4 1 .4 1.4 0l2.3-2.3c.5-.4.5-1.1.1-1.4z"
};

export type IconName = keyof typeof ICONS;

export function Icon({ name, size = 18, className }: { name: IconName; size?: number; className?: string; }) {
    return <UiIcon path={ICONS[name]} size={size} className={classes(cl("icon"), className)} />;
}

// ---------------------------------------------------------------- Building blocks (thin wrappers around the kit)

const VARIANTS = {
    primary: { variant: "filled" },
    ghost: { variant: "gray" },
    danger: { variant: "destructive" },
    success: { variant: "filled", color: "green" }
} as const;

export function Button({ children, icon, variant = "primary", small, disabled, onClick, title }: {
    children?: ReactNode;
    icon?: IconName;
    variant?: keyof typeof VARIANTS;
    small?: boolean;
    disabled?: boolean;
    title?: string;
    onClick?(): void;
}) {
    const v = VARIANTS[variant];
    return (
        <UiButton variant={v.variant} color={"color" in v ? v.color : undefined} icon={icon && ICONS[icon]} small={small} disabled={disabled} onClick={onClick} title={title}>
            {children}
        </UiButton>
    );
}

/** Whole row clickable, switch on the right */
export function ToggleRow({ checked, onChange, label, hint, disabled, danger }: {
    checked: boolean;
    onChange(v: boolean): void;
    label: ReactNode;
    hint?: ReactNode;
    disabled?: boolean;
    danger?: boolean;
}) {
    return (
        <UiToggleRow
            title={danger ? <span className={cl("text-bad")}>{label}</span> : label}
            subtitle={hint}
            checked={checked}
            disabled={disabled}
            onChange={onChange}
        />
    );
}

/** Kit segmented control for number values */
export function Segmented<T extends string | number>({ value, options, onChange, disabled }: {
    value: T;
    options: { value: T; label: string; }[];
    onChange(v: T): void;
    disabled?: boolean;
}) {
    return (
        <div className={classes(cl("seg"), disabled && cl("disabled"))}>
            <UiSegmented
                value={String(value)}
                options={options.map(o => ({ value: String(o.value), label: o.label }))}
                onChange={v => !disabled && onChange(options.find(o => String(o.value) === v)!.value)}
            />
        </div>
    );
}

export function NumberField({ value, onChange, min, max, disabled, suffix }: {
    value: number;
    onChange(v: number): void;
    min: number;
    max: number;
    disabled?: boolean;
    suffix?: string;
}) {
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
                className={classes("vc-ui-field", cl("number-input"))}
                value={text}
                min={min}
                max={max}
                disabled={disabled}
                onChange={e => setText(e.currentTarget.value)}
                onBlur={commit}
                onKeyDown={e => e.key === "Enter" && commit()}
            />
            {suffix && <span className={cl("muted")}>{suffix}</span>}
        </span>
    );
}

/** Kit section whose group holds free content (padded) and kit rows (full width) */
export function Card({ title, right, children }: { title?: ReactNode; right?: ReactNode; children: ReactNode; }) {
    return (
        <Section title={title} right={right}>
            <div className={cl("card-body")}>{children}</div>
        </Section>
    );
}

export function Notice({ tone = "info", children }: { tone?: "info" | "warn" | "danger"; children: ReactNode; }) {
    return <Note tone={tone === "info" ? undefined : tone === "warn" ? "warn" : "bad"}>{children}</Note>;
}

// ---------------------------------------------------------------- Progress & log

export function ProgressBar({ done, total, label, indeterminate }: { done: number; total: number; label?: ReactNode; indeterminate?: boolean; }) {
    const pct = total > 0 ? Math.min(100, Math.round(done / total * 100)) : 0;
    return (
        <div className={cl("progress")}>
            <div className={cl("progress-head")}>
                {indeterminate && <Spinner />}
                <span className={cl("progress-label")}>{label}</span>
                {!indeterminate && total > 0 && <span className={cl("muted")}>{pct} %</span>}
            </div>
            {!indeterminate && <Progress value={pct} />}
        </div>
    );
}

export interface LogEntry {
    id: number;
    kind: LogKind;
    text: string;
    time: number;
}

export function LogList({ entries }: { entries: LogEntry[]; }) {
    const ref = useRef<HTMLDivElement>(null);
    useEffect(() => {
        if (ref.current) ref.current.scrollTop = ref.current.scrollHeight;
    }, [entries.length]);
    if (!entries.length) return null;
    return (
        <div className={cl("log")} ref={ref}>
            {entries.map(e => (
                <div key={e.id} className={classes(cl("log-row"), cl(`log-${e.kind}`))}>
                    <span className={cl("log-time")}>{new Date(e.time).toLocaleTimeString()}</span>
                    <span>{e.text}</span>
                </div>
            ))}
        </div>
    );
}

/** Queue status (pending requests, rate limit) */
export function QueueBadge() {
    const [, setTick] = useState(0);
    useEffect(() => onQueueChange(() => setTick(t => t + 1)), []);
    useEffect(() => {
        const id = setInterval(() => queueState.pausedUntil > Date.now() && setTick(t => t + 1), 1000);
        return () => clearInterval(id);
    }, []);
    const pause = Math.ceil((queueState.pausedUntil - Date.now()) / 1000);
    if (pause > 0) return <Badge color="orange">Rate limit - waiting {pause}s</Badge>;
    if (queueState.pending > 0) return <Badge>{queueState.pending} in queue</Badge>;
    return null;
}

// ---------------------------------------------------------------- Job hook

export interface JobState {
    running: boolean;
    done: number;
    total: number;
    label: string;
    log: LogEntry[];
}

let logId = 0;

/**
 * Manages a cancellable job with progress & log.
 * When the window is closed, a running job is cancelled automatically.
 */
export function useJob() {
    const [state, setState] = useState<JobState>({ running: false, done: 0, total: 0, label: "", log: [] });
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

    const log = (kind: LogKind, text: string) => update(s => ({ log: [...s.log, { id: ++logId, kind, text, time: Date.now() }].slice(-400) }));

    async function run<T>(fn: (hooks: JobHooks) => Promise<T>, { keepLog = false } = {}): Promise<T | null> {
        if (tokenRef.current) return null;
        const token = createToken();
        tokenRef.current = token;
        update(s => ({ running: true, done: 0, total: 0, label: "Starting …", log: keepLog ? s.log : [] }));
        const hooks: JobHooks = {
            token,
            log,
            onProgress: (done, total, label) => update({ done, total, label }),
            onRateLimit: seconds => log("warn", `Rate limited by Discord - waiting ${Math.ceil(seconds)} s`)
        };
        try {
            return await fn(hooks);
        } catch (e) {
            if (isCancelled(e)) log("warn", "Cancelled");
            else log("error", describeError(e));
            throw e;
        } finally {
            releaseToken(token);
            tokenRef.current = null;
            update({ running: false });
        }
    }

    return {
        state,
        run,
        log,
        cancel: () => tokenRef.current?.cancel(),
        clearLog: () => update({ log: [] })
    };
}
