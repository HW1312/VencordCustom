/*
 * Radar – shared UI building blocks (icons, switches, segments, pickers)
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { classNameFactory } from "@api/Styles";
import { classes } from "@utils/misc";
import { useLayoutEffect, useMemo, useRef, useState } from "@webpack/common";
import type { ReactNode } from "react";

import type { IconName as EngineIcon } from "./engine";

export const cl = classNameFactory("vc-radar-");

// ---------------------------------------------------------------- Icons

const ICONS = {
    search: "M15.5 14h-.79l-.28-.27A6.47 6.47 0 0 0 16 9.5 6.5 6.5 0 1 0 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5Zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14Z",
    at: "M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10h5v-2h-5c-4.34 0-8-3.66-8-8s3.66-8 8-8 8 3.66 8 8v1.43c0 .79-.71 1.57-1.5 1.57s-1.5-.78-1.5-1.57V12c0-2.76-2.24-5-5-5s-5 2.24-5 5 2.24 5 5 5c1.38 0 2.64-.56 3.54-1.47.65.89 1.77 1.47 2.96 1.47 1.97 0 3.5-1.6 3.5-3.57V12c0-5.52-4.48-10-10-10Zm0 13c-1.66 0-3-1.34-3-3s1.34-3 3-3 3 1.34 3 3-1.34 3-3 3Z",
    voiceIn: "M3 9v6h4l5 5V4L7 9H3Zm13.5 3A4.5 4.5 0 0 0 14 7.97v8.05c1.48-.73 2.5-2.25 2.5-4.02ZM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77Z",
    voiceOut: "M16.5 12A4.5 4.5 0 0 0 14 7.97v2.21l2.45 2.45c.03-.2.05-.41.05-.63Zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51A8.8 8.8 0 0 0 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71ZM4.27 3 3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06a8.99 8.99 0 0 0 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3ZM12 4 9.91 6.09 12 8.18V4Z",
    gamepad: "M21.58 16.09l-1.09-7.66A3.996 3.996 0 0 0 16.53 5H7.47C5.48 5 3.79 6.46 3.51 8.43l-1.09 7.66A2.545 2.545 0 0 0 4.94 19c.68 0 1.32-.27 1.8-.75L9 16h6l2.25 2.25c.48.48 1.13.75 1.8.75 1.56 0 2.75-1.37 2.53-2.91ZM11 11H9v2H8v-2H6v-1h2V8h1v2h2v1Zm4-1c-.55 0-1-.45-1-1s.45-1 1-1 1 .45 1 1-.45 1-1 1Zm2 3c-.55 0-1-.45-1-1s.45-1 1-1 1 .45 1 1-.45 1-1 1Z",
    gamepadOff: "M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2Zm4 14H8V8h8v8Z",
    clock: "M11.99 2C6.47 2 2 6.48 2 12s4.47 10 9.99 10C17.52 22 22 17.52 22 12S17.52 2 11.99 2ZM12 20c-4.42 0-8-3.58-8-8s3.58-8 8-8 8 3.58 8 8-3.58 8-8 8Zm.5-13H11v6l5.25 3.15.75-1.23-4.5-2.67V7Z",
    bell: "M12 22c1.1 0 2-.9 2-2h-4a2 2 0 0 0 2 2Zm6-6v-5c0-3.07-1.64-5.64-4.5-6.32V4c0-.83-.67-1.5-1.5-1.5s-1.5.67-1.5 1.5v.68C7.63 5.36 6 7.92 6 11v5l-2 2v1h16v-1l-2-2Z",
    sound: "M12 3v10.55A4 4 0 1 0 14 17V7h4V3h-6Z",
    moon: "M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2Zm5 11H7v-2h10v2Z",
    flash: "M7 2v11h3v9l7-12h-4l4-8H7Z",
    highlight: "M6 14l3 3v5h6v-5l3-3V9H6v5Zm5-12h2v3h-2V2ZM3.5 5.88l1.41-1.41 2.12 2.12L5.62 8 3.5 5.88Zm13.46.71 2.12-2.12 1.41 1.41L18.38 8l-1.42-1.41Z",
    inbox: "M19 3H4.99C3.88 3 3.01 3.9 3.01 5L3 19c0 1.1.88 2 1.99 2H19c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2Zm0 12h-4c0 1.66-1.35 3-3 3s-3-1.34-3-3H4.99V5H19v10Z",
    bookmark: "M17 3H7c-1.1 0-1.99.9-1.99 2L5 21l7-3 7 3V5c0-1.1-.9-2-2-2Z",
    rules: "M3 17v2h6v-2H3ZM3 5v2h10V5H3Zm10 16v-2h8v-2h-8v-2h-2v6h2ZM7 9v2H3v2h4v2h2V9H7Zm14 4v-2H11v2h10Zm-6-4h2V7h4V5h-4V3h-2v6Z",
    trash: "M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12ZM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4Z",
    check: "M9 16.17 4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41L9 16.17Z",
    plus: "M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2Z",
    edit: "M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25ZM20.71 7.04a1 1 0 0 0 0-1.41l-2.34-2.34a1 1 0 0 0-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83Z",
    jump: "M12 4l-1.41 1.41L16.17 11H4v2h12.17l-5.58 5.59L12 20l8-8-8-8Z",
    close: "M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12 19 6.41Z",
    gear: "M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58a.49.49 0 0 0 .12-.61l-1.92-3.32a.49.49 0 0 0-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54a.48.48 0 0 0-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96a.49.49 0 0 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.09.63-.09.94s.02.64.07.94l-2.03 1.58a.49.49 0 0 0-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58ZM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6Z",
    play: "M8 5v14l11-7L8 5Z",
    doneAll: "M18 7l-1.41-1.41-6.34 6.34 1.41 1.41L18 7Zm4.24-1.41L11.66 16.17 7.48 12l-1.41 1.41L11.66 19l12-12-1.42-1.41ZM.41 13.41 6 19l1.41-1.41L1.83 12 .41 13.41Z",
    user: "M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4Zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4Z",
    server: "M4 5h16v4H4V5Zm0 5h16v4H4v-4Zm0 5h16v4H4v-4Zm2-9v2h2V6H6Zm0 5v2h2v-2H6Zm0 5v2h2v-2H6Z",
    image: "M21 19V5c0-1.1-.9-2-2-2H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2ZM8.5 13.5l2.5 3.01L14.5 12l4.5 6H5l3.5-4.5Z",
    file: "M14 2H6c-1.1 0-1.99.9-1.99 2L4 20c0 1.1.89 2 1.99 2H18c1.1 0 2-.9 2-2V8l-6-6Zm2 16H8v-2h8v2Zm0-4H8v-2h8v2Zm-3-5V3.5L18.5 9H13Z",
    download: "M19 9h-4V3H9v6H5l7 7 7-7ZM5 18v2h14v-2H5Z",
    folder: "M10 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2Z",
    copy: "M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1Zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2Zm0 16H8V7h11v14Z",
    chevronLeft: "M15.41 7.41 14 6l-6 6 6 6 1.41-1.41L10.83 12l4.58-4.59Z",
    chevronRight: "M10 6 8.59 7.41 13.17 12l-4.58 4.59L10 18l6-6-6-6Z",
    hash: "M10.99 3.97 10.5 7h4l.49-3.03 1.98.32L16.5 7H20v2h-3.82l-.65 4H19v2h-3.79l-.5 3.03-1.97-.32L13.2 15h-4l-.49 3.03-1.97-.32L7.2 15H4v-2h3.53l.65-4H5V7h3.5l.52-3.35 1.97.32ZM10.18 9l-.65 4h4l.65-4h-4Z"
} satisfies Record<EngineIcon, string> & Record<string, string>;

export type IconName = keyof typeof ICONS;

export function Icon({ name, size = 18, className }: { name: IconName; size?: number; className?: string; }) {
    return (
        <svg viewBox="0 0 24 24" width={size} height={size} className={classes(cl("icon"), className)} aria-hidden>
            <path fill="currentColor" d={ICONS[name]} />
        </svg>
    );
}

/** Logo: radar screen with a rotating sweep */
export function RadarLogo({ size = 20, className, spin }: { size?: number; className?: string; spin?: boolean; }) {
    return (
        <svg viewBox="0 0 24 24" width={size} height={size} className={classes(cl("icon"), cl("logo-svg"), className)} aria-hidden>
            <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeWidth="2" />
            <circle cx="12" cy="12" r="4.5" fill="none" stroke="currentColor" strokeWidth="1.6" opacity="0.6" />
            <g className={spin ? cl("sweep") : undefined}>
                <path d="M12 12 L12 3 A9 9 0 0 1 19.8 7.5 Z" fill="currentColor" opacity="0.35" />
                <line x1="12" y1="12" x2="12" y2="3" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            </g>
            <circle cx="12" cy="12" r="1.6" fill="currentColor" />
            <circle cx="16.2" cy="8.4" r="1.3" fill="currentColor" />
        </svg>
    );
}

// ---------------------------------------------------------------- Switches

export function Toggle({ checked, disabled }: { checked: boolean; disabled?: boolean; }) {
    return (
        <span className={classes(cl("switch"), checked && cl("switch-on"), disabled && cl("switch-disabled"))} aria-hidden>
            <span className={cl("switch-knob")} />
        </span>
    );
}

/** Whole row is clickable, with its own animated switch */
export function ToggleRow({ checked, onChange, label, hint, icon, disabled }: {
    checked: boolean; onChange(v: boolean): void; label: ReactNode; hint?: ReactNode; icon?: IconName; disabled?: boolean;
}) {
    const toggle = () => !disabled && onChange(!checked);
    return (
        <div
            role="switch"
            aria-checked={checked}
            aria-disabled={disabled}
            tabIndex={disabled ? -1 : 0}
            className={classes(cl("row"), disabled && cl("row-disabled"))}
            onClick={toggle}
            onKeyDown={e => {
                if (e.key === " " || e.key === "Enter") {
                    e.preventDefault();
                    toggle();
                }
            }}
        >
            {icon && <span className={classes(cl("row-icon"), checked && cl("row-icon-on"))}><Icon name={icon} size={18} /></span>}
            <span className={cl("row-text")}>
                <span className={cl("row-label")}>{label}</span>
                {hint && <span className={cl("row-hint")}>{hint}</span>}
            </span>
            <Toggle checked={checked} disabled={disabled} />
        </div>
    );
}

/** Measures the position of a child element for sliding indicators (tabs, segments) */
export function useSlider<T extends string>(value: T) {
    const refs = useRef<Record<string, HTMLElement | null>>({});
    const [pos, setPos] = useState<{ left: number; width: number; ready: boolean; }>({ left: 0, width: 0, ready: false });

    useLayoutEffect(() => {
        const measure = () => {
            const node = refs.current[value];
            if (node) setPos(p => ({ left: node.offsetLeft, width: node.offsetWidth, ready: p.ready || p.width > 0 }));
        };
        measure();
        const raf = requestAnimationFrame(() => {
            measure();
            setPos(p => ({ ...p, ready: true }));
        });
        return () => cancelAnimationFrame(raf);
    }, [value]);

    return { refs, pos };
}

export function Segmented<T extends string>({ value, options, onChange, small }: {
    value: T;
    options: { value: T; label: string; }[];
    onChange(v: T): void;
    small?: boolean;
}) {
    const { refs, pos } = useSlider(value);
    return (
        <div className={classes(cl("seg"), small && cl("seg-small"))}>
            <span
                className={classes(cl("seg-thumb"), pos.ready && cl("animated"))}
                style={{ transform: `translateX(${pos.left}px)`, width: pos.width }}
            />
            {options.map(o => (
                <button
                    key={o.value}
                    type="button"
                    ref={n => { refs.current[o.value] = n; }}
                    className={classes(cl("seg-item"), o.value === value && cl("seg-item-active"))}
                    onClick={() => onChange(o.value)}
                >
                    {o.label}
                </button>
            ))}
        </div>
    );
}

export function SectionTitle({ icon, children, right }: { icon?: IconName; children: ReactNode; right?: ReactNode; }) {
    return (
        <div className={cl("section-title")}>
            {icon && <Icon name={icon} size={15} />}
            <span>{children}</span>
            {right && <span className={cl("section-right")}>{right}</span>}
        </div>
    );
}

export function IconButton({ icon, label, onClick, danger, active, disabled }: {
    icon: IconName; label: string; onClick(e: React.MouseEvent): void; danger?: boolean; active?: boolean; disabled?: boolean;
}) {
    return (
        <button
            type="button"
            className={classes(cl("icon-btn"), danger && cl("icon-btn-danger"), active && cl("icon-btn-active"))}
            title={label}
            aria-label={label}
            disabled={disabled}
            onClick={e => {
                e.stopPropagation();
                onClick(e);
            }}
        >
            <Icon name={icon} size={16} />
        </button>
    );
}

export function Button({ children, onClick, variant = "primary", icon, small, disabled }: {
    children: ReactNode; onClick(): void; variant?: "primary" | "secondary" | "danger" | "ghost"; icon?: IconName; small?: boolean; disabled?: boolean;
}) {
    return (
        <button
            type="button"
            disabled={disabled}
            className={classes(cl("btn"), cl(`btn-${variant}`), small && cl("btn-small"))}
            onClick={onClick}
        >
            {icon && <Icon name={icon} size={small ? 14 : 16} />}
            <span>{children}</span>
        </button>
    );
}

export function Empty({ icon, title, hint, children }: { icon: IconName; title: string; hint?: ReactNode; children?: ReactNode; }) {
    return (
        <div className={cl("empty")}>
            <span className={cl("empty-icon")}><Icon name={icon} size={28} /></span>
            <span className={cl("empty-title")}>{title}</span>
            {hint && <span className={cl("row-hint")}>{hint}</span>}
            {children}
        </div>
    );
}

export function Field({ label, hint, children }: { label: ReactNode; hint?: ReactNode; children: ReactNode; }) {
    return (
        <div className={cl("field")}>
            <span className={cl("field-label")}>{label}</span>
            {children}
            {hint && <span className={cl("row-hint")}>{hint}</span>}
        </div>
    );
}

export function Avatar({ src, fallback, size = 32, round = true }: { src?: string; fallback: IconName; size?: number; round?: boolean; }) {
    const [failed, setFailed] = useState(false);
    // A new address (e.g. the saved copy finished loading) gets a fresh chance
    useLayoutEffect(() => setFailed(false), [src]);
    return (
        <span className={classes(cl("avatar"), !round && cl("avatar-square"))} style={{ width: size, height: size }}>
            {src && !failed
                ? <img src={src} width={size} height={size} alt="" onError={() => setFailed(true)} />
                : <Icon name={fallback} size={Math.round(size * 0.55)} />}
        </span>
    );
}

// ---------------------------------------------------------------- Multi-select (servers, channels, people)

export interface PickerOption {
    id: string;
    label: string;
    sub?: string;
    icon?: string;
}

export function MultiPicker({ value, onChange, options, resolve, placeholder, fallbackIcon, allowIds, emptyText }: {
    value: string[];
    onChange(v: string[]): void;
    /** Only computed when opened */
    options(): PickerOption[];
    resolve(id: string): PickerOption;
    placeholder: string;
    fallbackIcon: IconName;
    /** Accept arbitrary IDs (numbers), e.g. for people who aren't friends */
    allowIds?: boolean;
    emptyText?: string;
}) {
    const [query, setQuery] = useState("");
    const [open, setOpen] = useState(false);
    const all = useMemo(() => open ? options() : [], [open]);

    const q = query.trim().toLowerCase();
    const results = all
        .filter(o => !value.includes(o.id) && (!q || o.label.toLowerCase().includes(q) || o.sub?.toLowerCase().includes(q) || o.id === q))
        .slice(0, 60);
    const rawId = allowIds && /^\d{15,21}$/.test(q) && !value.includes(q) && !results.some(r => r.id === q) ? q : null;

    const add = (id: string) => {
        onChange([...value, id]);
        setQuery("");
    };

    return (
        <div className={cl("picker")}>
            {value.length > 0 && (
                <div className={cl("chips")}>
                    {value.map(id => {
                        const o = resolve(id);
                        return (
                            <span key={id} className={cl("chip")}>
                                <Avatar src={o.icon} fallback={fallbackIcon} size={18} />
                                <span className={cl("chip-label")}>{o.label}</span>
                                <button type="button" className={cl("chip-x")} aria-label="Remove" onClick={() => onChange(value.filter(v => v !== id))}>
                                    <Icon name="close" size={12} />
                                </button>
                            </span>
                        );
                    })}
                </div>
            )}
            <div className={cl("picker-box")}>
                <Icon name="search" size={16} className={cl("picker-search")} />
                <input
                    className={cl("input")}
                    value={query}
                    placeholder={placeholder}
                    onFocus={() => setOpen(true)}
                    onBlur={() => setTimeout(() => setOpen(false), 150)}
                    onChange={e => setQuery(e.currentTarget.value)}
                    onKeyDown={e => {
                        if (e.key === "Enter") {
                            e.preventDefault();
                            if (results[0]) add(results[0].id);
                            else if (rawId) add(rawId);
                        } else if (e.key === "Escape") {
                            (e.currentTarget as HTMLInputElement).blur();
                        }
                    }}
                />
            </div>
            {open && (
                <div className={cl("picker-list")} onMouseDown={e => e.preventDefault()}>
                    {rawId && (
                        <button type="button" className={cl("picker-item")} onClick={() => add(rawId)}>
                            <Avatar fallback={fallbackIcon} size={24} />
                            <span className={cl("picker-text")}>
                                <span>Use ID {rawId}</span>
                            </span>
                        </button>
                    )}
                    {results.map(o => (
                        <button type="button" key={o.id} className={cl("picker-item")} onClick={() => add(o.id)}>
                            <Avatar src={o.icon} fallback={fallbackIcon} size={24} />
                            <span className={cl("picker-text")}>
                                <span>{o.label}</span>
                                {o.sub && <span className={cl("row-hint")}>{o.sub}</span>}
                            </span>
                        </button>
                    ))}
                    {!results.length && !rawId && <div className={cl("picker-empty")}>{emptyText ?? "Nothing found"}</div>}
                </div>
            )}
        </div>
    );
}

/** Free-text list (words, game names): Enter or comma adds an entry */
export function TagInput({ value, onChange, placeholder }: { value: string[]; onChange(v: string[]): void; placeholder: string; }) {
    const [text, setText] = useState("");
    const commit = () => {
        const parts = text.split(",").map(t => t.trim()).filter(Boolean).filter(t => !value.includes(t));
        if (parts.length) onChange([...value, ...parts]);
        setText("");
    };
    return (
        <div className={cl("taginput")}>
            {value.map(v => (
                <span key={v} className={cl("chip")}>
                    <span className={cl("chip-label")}>{v}</span>
                    <button type="button" className={cl("chip-x")} aria-label="Remove" onClick={() => onChange(value.filter(x => x !== v))}>
                        <Icon name="close" size={12} />
                    </button>
                </span>
            ))}
            <input
                className={cl("taginput-input")}
                value={text}
                placeholder={value.length ? "" : placeholder}
                onChange={e => setText(e.currentTarget.value)}
                onBlur={commit}
                onKeyDown={e => {
                    if (e.key === "Enter" || e.key === ",") {
                        e.preventDefault();
                        commit();
                    } else if (e.key === "Backspace" && !text && value.length) {
                        onChange(value.slice(0, -1));
                    }
                }}
            />
        </div>
    );
}
