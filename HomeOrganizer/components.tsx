/*
 * HomeOrganizer – shared building blocks on top of the _ui kit (icons, checkbox, number field, job hook, confirmation)
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./ui.css";

import { classNameFactory } from "@api/Styles";
import ErrorBoundary from "@components/ErrorBoundary";
import { classes } from "@utils/misc";
import { useEffect, useRef, useState } from "@webpack/common";
import type { ReactNode } from "react";

import { Avatar, Badge, Button, Icon, ICONS as UI, openWindow, Progress, Row, Section, Sheet, TextField, UiColor } from "../_ui";
import { CancelToken, createToken, describeError, isCancelled, onQueueChange, queueState, releaseToken } from "./queue";

export const cl = classNameFactory("vc-homeorganizer-");

export const APP_COLOR: UiColor = "teal";

// ---------------------------------------------------------------- Icons

export const ICONS = {
    home: "M12 3 2 12h3v8h6v-6h2v6h6v-8h3L12 3z",
    chat: "M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2z",
    person: UI.user,
    personAdd: "M15 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zm-9-2V7H4v3H1v2h3v3h2v-3h3v-2H6zm9 4c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z",
    check: UI.check,
    close: UI.close,
    stop: "M6 6h12v12H6z",
    divider: "M3 11h18v2H3z",
    open: UI.external,
    shield: "M12 1 3 5v6c0 5.55 3.84 10.74 9 12 5.16-1.26 9-6.45 9-12V5l-9-4zm0 10.99h7c-.53 4.12-3.28 7.79-7 8.94V12H5V6.3l7-3.11v8.8z",
    pin: "M16 9V4h1a1 1 0 0 0 0-2H7a1 1 0 0 0 0 2h1v5c0 1.66-1.34 3-3 3v2h5.97v7l1 1 1-1v-7H19v-2c-1.66 0-3-1.34-3-3z",
    warning: UI.warning,
    moon: "M9.37 5.51A7.35 7.35 0 0 0 9.1 7.5c0 4.08 3.32 7.4 7.4 7.4.68 0 1.35-.09 1.99-.27A7.014 7.014 0 0 1 12 19c-3.86 0-7-3.14-7-7 0-2.93 1.81-5.45 4.37-6.49zM12 3a9 9 0 1 0 9 9c0-.46-.04-.92-.1-1.36a5.389 5.389 0 0 1-4.4 2.26 5.403 5.403 0 0 1-3.14-9.8c-.44-.06-.9-.1-1.36-.1z",
    refresh: UI.refresh,
    leave: "M10.09 15.59 11.5 17l5-5-5-5-1.41 1.41L12.67 11H3v2h9.67l-2.58 2.59zM19 3H5a2 2 0 0 0-2 2v4h2V5h14v14H5v-4H3v4a2 2 0 0 0 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2z",
    group: "M16 11c1.66 0 2.99-1.34 2.99-3S17.66 5 16 5c-1.66 0-3 1.34-3 3s1.34 3 3 3zm-8 0c1.66 0 2.99-1.34 2.99-3S9.66 5 8 5C6.34 5 5 6.34 5 8s1.34 3 3 3zm0 2c-2.33 0-7 1.17-7 3.5V19h14v-2.5c0-2.33-4.67-3.5-7-3.5zm8 0c-.29 0-.62.02-.97.05 1.16.84 1.97 1.97 1.97 3.45V19h6v-2.5c0-2.33-4.67-3.5-7-3.5z"
};

export const TONE_COLOR: Record<"info" | "warn" | "bad" | "good", UiColor> = { info: "blue", warn: "orange", bad: "red", good: "green" };

// ---------------------------------------------------------------- Building blocks

/** Round selection check (iOS edit-mode style) */
export function Check({ checked, onChange, disabled, title }: { checked: boolean; onChange(v: boolean): void; disabled?: boolean; title?: string; }) {
    return (
        <button
            type="button"
            role="checkbox"
            aria-checked={checked}
            disabled={disabled}
            title={title}
            className={classes(cl("check"), checked && cl("check-on"))}
            onClick={e => {
                e.stopPropagation();
                onChange(!checked);
            }}
        >
            {checked && <Icon path={UI.check} size={12} />}
        </button>
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
            <TextField
                type="number"
                value={text}
                min={min}
                max={max}
                onChange={setText}
                onBlur={commit}
                onKeyDown={e => e.key === "Enter" && commit()}
            />
            {suffix && <span className={cl("dim")}>{suffix}</span>}
        </span>
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
    if (pause > 0) return <Badge color="orange">Rate limited - waiting {pause}s</Badge>;
    if (queueState.pending > 0) return <Badge>{queueState.pending} in queue</Badge>;
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
    const pct = state.total > 0 ? Math.min(100, Math.round(state.done / state.total * 100)) : 0;
    return (
        <Section>
            <Row
                title={state.running ? state.label : state.result}
                subtitle={state.running && state.total > 0 ? `${state.done}/${state.total} · ${pct} %` : undefined}
                trailing={state.running
                    ? <Button small variant="destructive" icon={ICONS.stop} onClick={job.cancel}>Cancel</Button>
                    : <Button small variant="gray" onClick={job.clear}>OK</Button>}
            >
                {state.running && <div className={cl("job-progress")}><Progress value={pct} color={APP_COLOR} /></div>}
            </Row>
        </Section>
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
    openWindow(close => (
        <Sheet
            header={{ title, icon: danger ? ICONS.warning : ICONS.home, iconColor: danger ? "red" : APP_COLOR }}
            onClose={close}
            actions={[
                { label: "Cancel", onClick: close },
                {
                    label: confirmText,
                    variant: danger ? "destructive" : "filled",
                    onClick: () => {
                        close();
                        onConfirm();
                    }
                }
            ]}
        >
            <ErrorBoundary>
                <div className={cl("confirm-text")}>{text}</div>
                {items.length > 0 && (
                    <Section>
                        {items.map(i => (
                            <Row key={i.id} leading={<Avatar src={i.avatar} size={24} />} title={i.name} trailing={i.detail && <span className={cl("dim")}>{i.detail}</span>} />
                        ))}
                    </Section>
                )}
            </ErrorBoundary>
        </Sheet>
    ), { size: "small" });
}


