/*
 * HomeOrganizer – shared UI building blocks (icons, buttons, progress, confirmation, job hook)
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./ui.css";

import { classNameFactory } from "@api/Styles";
import ErrorBoundary from "@components/ErrorBoundary";
import { classes } from "@utils/misc";
import { Modal, openModal, useEffect, useRef, useState } from "@webpack/common";
import type { ReactNode } from "react";

import { CancelToken, createToken, describeError, isCancelled, onQueueChange, queueState, releaseToken } from "./queue";

export const cl = classNameFactory("vc-homeorganizer-");

// ---------------------------------------------------------------- Icons

export const ICONS = {
    home: "M12 3 2 12h3v8h6v-6h2v6h6v-8h3L12 3z",
    chat: "M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2z",
    person: "M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z",
    personAdd: "M15 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zm-9-2V7H4v3H1v2h3v3h2v-3h3v-2H6zm9 4c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z",
    check: "M9 16.17 4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z",
    close: "M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z",
    stop: "M6 6h12v12H6z",
    open: "M19 19H5V5h7V3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14c1.1 0 2-.9 2-2v-7h-2v7zM14 3v2h3.59l-9.83 9.83 1.41 1.41L19 6.41V10h2V3h-7z",
    shield: "M12 1 3 5v6c0 5.55 3.84 10.74 9 12 5.16-1.26 9-6.45 9-12V5l-9-4zm0 10.99h7c-.53 4.12-3.28 7.79-7 8.94V12H5V6.3l7-3.11v8.8z",
    pin: "M16 9V4h1a1 1 0 0 0 0-2H7a1 1 0 0 0 0 2h1v5c0 1.66-1.34 3-3 3v2h5.97v7l1 1 1-1v-7H19v-2c-1.66 0-3-1.34-3-3z",
    warning: "M1 21h22L12 2 1 21zm12-3h-2v-2h2v2zm0-4h-2v-4h2v4z",
    search: "M15.5 14h-.79l-.28-.27A6.47 6.47 0 0 0 16 9.5 6.5 6.5 0 1 0 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z",
    moon: "M9.37 5.51A7.35 7.35 0 0 0 9.1 7.5c0 4.08 3.32 7.4 7.4 7.4.68 0 1.35-.09 1.99-.27A7.014 7.014 0 0 1 12 19c-3.86 0-7-3.14-7-7 0-2.93 1.81-5.45 4.37-6.49zM12 3a9 9 0 1 0 9 9c0-.46-.04-.92-.1-1.36a5.389 5.389 0 0 1-4.4 2.26 5.403 5.403 0 0 1-3.14-9.8c-.44-.06-.9-.1-1.36-.1z",
    refresh: "M17.65 6.35A7.958 7.958 0 0 0 12 4a8 8 0 1 0 7.74 10h-2.08A5.99 5.99 0 0 1 12 18c-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z",
    leave: "M10.09 15.59 11.5 17l5-5-5-5-1.41 1.41L12.67 11H3v2h9.67l-2.58 2.59zM19 3H5a2 2 0 0 0-2 2v4h2V5h14v14H5v-4H3v4a2 2 0 0 0 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2z",
    group: "M16 11c1.66 0 2.99-1.34 2.99-3S17.66 5 16 5c-1.66 0-3 1.34-3 3s1.34 3 3 3zm-8 0c1.66 0 2.99-1.34 2.99-3S9.66 5 8 5C6.34 5 5 6.34 5 8s1.34 3 3 3zm0 2c-2.33 0-7 1.17-7 3.5V19h14v-2.5c0-2.33-4.67-3.5-7-3.5zm8 0c-.29 0-.62.02-.97.05 1.16.84 1.97 1.97 1.97 3.45V19h6v-2.5c0-2.33-4.67-3.5-7-3.5z"
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

export function Segmented<T extends string | number>({ value, options, onChange, disabled }: {
    value: T;
    options: { value: T; label: ReactNode; }[];
    onChange(v: T): void;
    disabled?: boolean;
}) {
    return (
        <div className={classes(cl("seg"), disabled && cl("disabled"))}>
            {options.map(o => (
                <button
                    key={String(o.value)}
                    disabled={disabled}
                    className={classes(cl("seg-item"), o.value === value && cl("seg-item-active"))}
                    onClick={() => onChange(o.value)}
                >
                    {o.label}
                </button>
            ))}
        </div>
    );
}

export function Toggle({ checked }: { checked: boolean; }) {
    return (
        <span className={classes(cl("switch"), checked && cl("switch-on"))} aria-hidden>
            <span className={cl("switch-knob")} />
        </span>
    );
}

export function ToggleRow({ checked, onChange, label, hint }: { checked: boolean; onChange(v: boolean): void; label: ReactNode; hint?: ReactNode; }) {
    return (
        <div
            role="switch"
            aria-checked={checked}
            tabIndex={0}
            className={cl("row")}
            onClick={() => onChange(!checked)}
            onKeyDown={e => {
                if (e.key === " " || e.key === "Enter") {
                    e.preventDefault();
                    onChange(!checked);
                }
            }}
        >
            <span className={cl("row-text")}>
                <span className={cl("row-label")}>{label}</span>
                {hint && <span className={cl("row-hint")}>{hint}</span>}
            </span>
            <Toggle checked={checked} />
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

export function Checkbox({ checked, onChange, disabled, title }: { checked: boolean; onChange(v: boolean): void; disabled?: boolean; title?: string; }) {
    return (
        <input
            type="checkbox"
            className={cl("check")}
            checked={checked}
            disabled={disabled}
            title={title}
            onChange={e => onChange(e.currentTarget.checked)}
            onClick={e => e.stopPropagation()}
        />
    );
}

export function Avatar({ src, name, size = 36 }: { src?: string; name: string; size?: number; }) {
    const [broken, setBroken] = useState(false);
    if (!src || broken) {
        return (
            <span className={cl("avatar-fallback")} style={{ width: size, height: size, fontSize: size * 0.42 }}>
                {name.trim().charAt(0).toUpperCase() || "?"}
            </span>
        );
    }
    return <img className={cl("avatar")} src={src} width={size} height={size} alt="" onError={() => setBroken(true)} />;
}

export function Chip({ children, tone = "info", title }: { children: ReactNode; tone?: "info" | "warn" | "bad" | "good"; title?: string; }) {
    return <span className={classes(cl("chip"), cl(`chip-${tone}`))} title={title}>{children}</span>;
}

export function Notice({ tone = "info", children }: { tone?: "info" | "warn" | "danger"; children: ReactNode; }) {
    return (
        <div className={classes(cl("notice"), cl(`notice-${tone}`))}>
            <Icon name={tone === "info" ? "shield" : "warning"} size={16} />
            <div>{children}</div>
        </div>
    );
}

// ---------------------------------------------------------------- Progress

export function ProgressBar({ done, total, label }: { done: number; total: number; label?: ReactNode; }) {
    const pct = total > 0 ? Math.min(100, Math.round(done / total * 100)) : 0;
    return (
        <div className={cl("progress")}>
            <div className={cl("progress-head")}>
                <span className={cl("progress-label")}>{label}</span>
                {total > 0 && <span className={cl("muted")}>{done}/{total} · {pct} %</span>}
            </div>
            <div className={cl("progress-track")}>
                <div className={cl("progress-fill")} style={{ width: `${pct}%` }} />
            </div>
        </div>
    );
}

/** Queue status (waiting requests, rate limit) */
export function QueueBadge() {
    const [, setTick] = useState(0);
    useEffect(() => onQueueChange(() => setTick(t => t + 1)), []);
    useEffect(() => {
        const id = setInterval(() => queueState.pausedUntil > Date.now() && setTick(t => t + 1), 1000);
        return () => clearInterval(id);
    }, []);
    const pause = Math.ceil((queueState.pausedUntil - Date.now()) / 1000);
    if (pause > 0) return <span className={classes(cl("badge"), cl("badge-warn"))}>Rate limited - waiting {pause}s</span>;
    if (queueState.pending > 0) return <span className={cl("badge")}>{queueState.pending} in queue</span>;
    return null;
}

// ---------------------------------------------------------------- Job hook

export interface JobHooks {
    token: CancelToken;
    progress(done: number, total: number, label: string): void;
    onRateLimit(seconds: number): void;
}

export interface JobState {
    running: boolean;
    done: number;
    total: number;
    label: string;
    result: string | null;
}

/** A cancellable job with progress. It is cancelled when the window closes. */
export function useJob() {
    const [state, setState] = useState<JobState>({ running: false, done: 0, total: 0, label: "", result: null });
    const tokenRef = useRef<CancelToken | null>(null);
    const mounted = useRef(true);

    useEffect(() => () => {
        mounted.current = false;
        tokenRef.current?.cancel();
    }, []);

    const update = (patch: Partial<JobState>) => mounted.current && setState(s => ({ ...s, ...patch }));

    async function run(fn: (hooks: JobHooks) => Promise<string>) {
        if (tokenRef.current) return;
        const token = createToken();
        tokenRef.current = token;
        update({ running: true, done: 0, total: 0, label: "Starting ...", result: null });
        try {
            const result = await fn({
                token,
                progress: (done, total, label) => update({ done, total, label }),
                onRateLimit: s => update({ label: `Rate limited by Discord - waiting ${Math.ceil(s)} s ...` })
            });
            update({ result });
        } catch (e) {
            update({ result: isCancelled(e) ? "Cancelled." : `Error: ${describeError(e)}` });
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
        clear: () => update({ result: null })
    };
}

export function JobBar({ job }: { job: ReturnType<typeof useJob>; }) {
    const { state } = job;
    if (!state.running && !state.result) return null;
    return (
        <div className={cl("jobbar")}>
            {state.running
                ? <>
                    <ProgressBar done={state.done} total={state.total} label={state.label} />
                    <Button small variant="danger" icon="stop" onClick={job.cancel}>Cancel</Button>
                </>
                : <>
                    <span className={cl("job-result")}>{state.result}</span>
                    <Button small variant="ghost" icon="close" onClick={job.clear}>OK</Button>
                </>}
        </div>
    );
}

// ---------------------------------------------------------------- Confirmation with preview

export interface ConfirmItem {
    id: string;
    name: string;
    avatar?: string;
    detail?: string;
}

/** Confirmation dialog with a list of the affected entries */
export function openConfirm({ title, text, items, confirmText, danger = true, onConfirm }: {
    title: string;
    text: ReactNode;
    items: ConfirmItem[];
    confirmText: string;
    danger?: boolean;
    onConfirm(): void;
}) {
    openModal(props => (
        <Modal
            {...props}
            size="md"
            title={title}
            actions={[
                { text: "Cancel", variant: "secondary", onClick: props.onClose },
                {
                    text: confirmText,
                    variant: danger ? "critical-primary" : "primary",
                    onClick: () => {
                        props.onClose();
                        onConfirm();
                    }
                }
            ]}
        >
            <ErrorBoundary>
                <div className={cl("confirm")}>
                    <div className={cl("confirm-text")}>{text}</div>
                    {items.length > 0 && (
                        <div className={cl("confirm-list")}>
                            {items.map(i => (
                                <div key={i.id} className={cl("confirm-row")}>
                                    <Avatar src={i.avatar} name={i.name} size={24} />
                                    <span className={cl("ellipsis")}>{i.name}</span>
                                    {i.detail && <span className={cl("muted")}>{i.detail}</span>}
                                </div>
                            ))}
                        </div>
                    )}
                </div>
            </ErrorBoundary>
        </Modal>
    ));
}
