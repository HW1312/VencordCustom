/*
 * Radar – own building blocks. Standard parts (switches, buttons, segments, fields, rows …) come from the shared
 * _ui kit; here only what's special to Radar: its icons, the logo and the pickers of the rule editor.
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { classNameFactory } from "@api/Styles";
import { useMemo, useState } from "@webpack/common";

import { Avatar, ICONS, Pill, Pills, SearchField, UiColor } from "../_ui";
import type { IconName as EngineIcon } from "./engine";
import type { ActionType, TriggerType } from "./store";

export const cl = classNameFactory("vc-radar-");

// ---------------------------------------------------------------- Icons

/** Radar's own 24×24 icon paths; everything common comes from the kit's ICONS */
export const RI = {
    search: ICONS.search,
    bell: ICONS.bell,
    at: "M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10h5v-2h-5c-4.34 0-8-3.66-8-8s3.66-8 8-8 8 3.66 8 8v1.43c0 .79-.71 1.57-1.5 1.57s-1.5-.78-1.5-1.57V12c0-2.76-2.24-5-5-5s-5 2.24-5 5 2.24 5 5 5c1.38 0 2.64-.56 3.54-1.47.65.89 1.77 1.47 2.96 1.47 1.97 0 3.5-1.6 3.5-3.57V12c0-5.52-4.48-10-10-10Zm0 13c-1.66 0-3-1.34-3-3s1.34-3 3-3 3 1.34 3 3-1.34 3-3 3Z",
    voiceIn: "M3 9v6h4l5 5V4L7 9H3Zm13.5 3A4.5 4.5 0 0 0 14 7.97v8.05c1.48-.73 2.5-2.25 2.5-4.02ZM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77Z",
    voiceOut: "M16.5 12A4.5 4.5 0 0 0 14 7.97v2.21l2.45 2.45c.03-.2.05-.41.05-.63Zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51A8.8 8.8 0 0 0 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71ZM4.27 3 3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06a8.99 8.99 0 0 0 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3ZM12 4 9.91 6.09 12 8.18V4Z",
    gamepad: "M21.58 16.09l-1.09-7.66A3.996 3.996 0 0 0 16.53 5H7.47C5.48 5 3.79 6.46 3.51 8.43l-1.09 7.66A2.545 2.545 0 0 0 4.94 19c.68 0 1.32-.27 1.8-.75L9 16h6l2.25 2.25c.48.48 1.13.75 1.8.75 1.56 0 2.75-1.37 2.53-2.91ZM11 11H9v2H8v-2H6v-1h2V8h1v2h2v1Zm4-1c-.55 0-1-.45-1-1s.45-1 1-1 1 .45 1 1-.45 1-1 1Zm2 3c-.55 0-1-.45-1-1s.45-1 1-1 1 .45 1 1-.45 1-1 1Z",
    gamepadOff: "M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2Zm4 14H8V8h8v8Z",
    clock: "M11.99 2C6.47 2 2 6.48 2 12s4.47 10 9.99 10C17.52 22 22 17.52 22 12S17.52 2 11.99 2ZM12 20c-4.42 0-8-3.58-8-8s3.58-8 8-8 8 3.58 8 8-3.58 8-8 8Zm.5-13H11v6l5.25 3.15.75-1.23-4.5-2.67V7Z",
    sound: "M12 3v10.55A4 4 0 1 0 14 17V7h4V3h-6Z",
    moon: "M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2Zm5 11H7v-2h10v2Z",
    flash: "M7 2v11h3v9l7-12h-4l4-8H7Z",
    highlight: "M6 14l3 3v5h6v-5l3-3V9H6v5Zm5-12h2v3h-2V2ZM3.5 5.88l1.41-1.41 2.12 2.12L5.62 8 3.5 5.88Zm13.46.71 2.12-2.12 1.41 1.41L18.38 8l-1.42-1.41Z",
    inbox: "M19 3H4.99C3.88 3 3.01 3.9 3.01 5L3 19c0 1.1.88 2 1.99 2H19c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2Zm0 12h-4c0 1.66-1.35 3-3 3s-3-1.34-3-3H4.99V5H19v10Z",
    bookmark: "M17 3H7c-1.1 0-1.99.9-1.99 2L5 21l7-3 7 3V5c0-1.1-.9-2-2-2Z",
    rules: "M3 17v2h6v-2H3ZM3 5v2h10V5H3Zm10 16v-2h8v-2h-8v-2h-2v6h2ZM7 9v2H3v2h4v2h2V9H7Zm14 4v-2H11v2h10Zm-6-4h2V7h4V5h-4V3h-2v6Z",
    jump: "M12 4l-1.41 1.41L16.17 11H4v2h12.17l-5.58 5.59L12 20l8-8-8-8Z",
    doneAll: "M18 7l-1.41-1.41-6.34 6.34 1.41 1.41L18 7Zm4.24-1.41L11.66 16.17 7.48 12l-1.41 1.41L11.66 19l12-12-1.42-1.41ZM.41 13.41 6 19l1.41-1.41L1.83 12 .41 13.41Z",
    server: "M4 5h16v4H4V5Zm0 5h16v4H4v-4Zm0 5h16v4H4v-4Zm2-9v2h2V6H6Zm0 5v2h2v-2H6Zm0 5v2h2v-2H6Z",
    image: "M21 19V5c0-1.1-.9-2-2-2H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2ZM8.5 13.5l2.5 3.01L14.5 12l4.5 6H5l3.5-4.5Z",
    file: "M14 2H6c-1.1 0-1.99.9-1.99 2L4 20c0 1.1.89 2 1.99 2H18c1.1 0 2-.9 2-2V8l-6-6Zm2 16H8v-2h8v2Zm0-4H8v-2h8v2Zm-3-5V3.5L18.5 9H13Z",
    hash: "M10.99 3.97 10.5 7h4l.49-3.03 1.98.32L16.5 7H20v2h-3.82l-.65 4H19v2h-3.79l-.5 3.03-1.97-.32L13.2 15h-4l-.49 3.03-1.97-.32L7.2 15H4v-2h3.53l.65-4H5V7h3.5l.52-3.35 1.97.32ZM10.18 9l-.65 4h4l.65-4h-4Z"
} satisfies Record<EngineIcon, string> & Record<string, string>;

export type RadarIcon = keyof typeof RI;

/** Glyph colors per trigger and action, so rules read at a glance */
export const TRIGGER_COLOR: Record<TriggerType, UiColor> = {
    keyword: "blue",
    mention: "purple",
    voiceJoin: "green",
    voiceLeave: "orange",
    gameStart: "indigo",
    gameStop: "gray",
    time: "teal"
};

export const ACTION_COLOR: Record<ActionType, UiColor> = {
    notify: "red",
    sound: "pink",
    status: "indigo",
    flash: "yellow",
    highlight: "orange",
    inbox: "blue"
};

/** Logo: radar screen with a rotating sweep */
export function RadarLogo({ size = 20, className, spin }: { size?: number; className?: string; spin?: boolean; }) {
    return (
        <svg viewBox="0 0 24 24" width={size} height={size} className={className} aria-hidden>
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
    /** Icon path when there is no picture */
    fallbackIcon: string;
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
                <Pills>
                    {value.map(id => {
                        const o = resolve(id);
                        return <Pill key={id} leading={<Avatar src={o.icon} fallback={fallbackIcon} size={18} />} onRemove={() => onChange(value.filter(v => v !== id))}>{o.label}</Pill>;
                    })}
                </Pills>
            )}
            <SearchField
                value={query}
                placeholder={placeholder}
                onFocus={() => setOpen(true)}
                onBlur={() => setTimeout(() => setOpen(false), 150)}
                onChange={setQuery}
                onKeyDown={e => {
                    if (e.key === "Enter") {
                        e.preventDefault();
                        if (results[0]) add(results[0].id);
                        else if (rawId) add(rawId);
                    } else if (e.key === "Escape") {
                        e.currentTarget.blur();
                    }
                }}
            />
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
                                {o.sub && <small>{o.sub}</small>}
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
            {value.map(v => <Pill key={v} onRemove={() => onChange(value.filter(x => x !== v))}>{v}</Pill>)}
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
