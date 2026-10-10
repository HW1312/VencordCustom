/*
 * _ui – shared Apple style UI kit for all own plugins (macOS / iOS look, like AutoQuest).
 * Not a plugin itself (folders starting with "_" are skipped by Vencord); build.mjs copies it next to the plugins,
 * they import it with `from "../_ui"`.
 *
 * Colors live in CSS variables (--vc-ui-*) on :root and follow Discord's light/dark theme, so they can be used in any
 * plugin's CSS as well, e.g. small chips inside the chat.
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./ui.css";

import { classNameFactory } from "@api/Styles";
import ErrorBoundary from "@components/ErrorBoundary";
import { classes } from "@utils/misc";
import { ModalRoot, ModalSize } from "@utils/modal";
import { createRoot, openModal, Tooltip, useEffect, useRef, useState } from "@webpack/common";
import type { CSSProperties, ReactNode } from "react";

export const cl = classNameFactory("vc-ui-");
export { classes };

// ---------------------------------------------------------------- Icons

/** Common 24×24 icon paths, so plugins don't each carry their own copy */
export const ICONS = {
    close: "M17.3 18.7a1 1 0 0 0 1.4-1.4L13.42 12l5.3-5.3a1 1 0 0 0-1.42-1.4L12 10.58l-5.3-5.3a1 1 0 0 0-1.4 1.42L10.58 12l-5.3 5.3a1 1 0 1 0 1.42 1.4L12 13.42l5.3 5.3Z",
    check: "M9 16.2 4.8 12l-1.4 1.4L9 19 21 7l-1.4-1.4L9 16.2Z",
    chevron: "M9.3 5.3a1 1 0 0 0 0 1.4l5.3 5.3-5.3 5.3a1 1 0 1 0 1.4 1.4l6-6a1 1 0 0 0 0-1.4l-6-6a1 1 0 0 0-1.4 0Z",
    back: "M14.7 5.3a1 1 0 0 1 0 1.4L9.4 12l5.3 5.3a1 1 0 1 1-1.4 1.4l-6-6a1 1 0 0 1 0-1.4l6-6a1 1 0 0 1 1.4 0Z",
    plus: "M12 4a1 1 0 0 1 1 1v6h6a1 1 0 1 1 0 2h-6v6a1 1 0 1 1-2 0v-6H5a1 1 0 1 1 0-2h6V5a1 1 0 0 1 1-1Z",
    search: "M10.5 3a7.5 7.5 0 0 1 5.96 12.05l4.25 4.24a1 1 0 0 1-1.42 1.42l-4.24-4.25A7.5 7.5 0 1 1 10.5 3Zm0 2a5.5 5.5 0 1 0 0 11 5.5 5.5 0 0 0 0-11Z",
    refresh: "M17.65 6.35A7.96 7.96 0 0 0 12 4a8 8 0 1 0 7.73 10h-2.08A6 6 0 1 1 12 6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35Z",
    gear: "M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58a.49.49 0 0 0 .12-.61l-1.92-3.32a.49.49 0 0 0-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54a.48.48 0 0 0-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96a.49.49 0 0 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.09.63-.09.94s.02.64.07.94l-2.03 1.58a.49.49 0 0 0-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58ZM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6Z",
    trash: "M9 3h6a1 1 0 0 1 1 1v1h4a1 1 0 1 1 0 2h-1l-.9 12.1A2 2 0 0 1 16.1 21H7.9a2 2 0 0 1-2-1.9L5 7H4a1 1 0 0 1 0-2h4V4a1 1 0 0 1 1-1Zm1 6a1 1 0 0 0-1 1v7a1 1 0 1 0 2 0v-7a1 1 0 0 0-1-1Zm4 0a1 1 0 0 0-1 1v7a1 1 0 1 0 2 0v-7a1 1 0 0 0-1-1Z",
    edit: "M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25ZM20.71 7.04a1 1 0 0 0 0-1.41l-2.34-2.34a1 1 0 0 0-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83Z",
    info: "M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20Zm1 15h-2v-6h2v6Zm0-8h-2V7h2v2Z",
    warning: "M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20Zm1 15h-2v-2h2v2Zm0-4h-2V7h2v6Z",
    bell: "M12 22a2.5 2.5 0 0 0 2.45-2h-4.9A2.5 2.5 0 0 0 12 22Zm7-6V11a7 7 0 0 0-5.5-6.84V3.5a1.5 1.5 0 0 0-3 0v.66A7 7 0 0 0 5 11v5l-2 2v1h18v-1l-2-2Z",
    download: "M12 3a1 1 0 0 1 1 1v9.59l3.3-3.3a1 1 0 1 1 1.4 1.42l-5 5a1 1 0 0 1-1.4 0l-5-5a1 1 0 1 1 1.4-1.42l3.3 3.3V4a1 1 0 0 1 1-1ZM5 19h14a1 1 0 1 1 0 2H5a1 1 0 1 1 0-2Z",
    external: "M14 3h6a1 1 0 0 1 1 1v6a1 1 0 1 1-2 0V6.41l-8.3 8.3a1 1 0 0 1-1.4-1.42L17.58 5H14a1 1 0 1 1 0-2ZM5 7h5a1 1 0 1 1 0 2H5v10h10v-5a1 1 0 1 1 2 0v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2Z",
    copy: "M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1Zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2Zm0 16H8V7h11v14Z",
    user: "M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4Z",
    folder: "M10 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2Z",
    play: "M8 5.14v13.72a1 1 0 0 0 1.5.86l11-6.86a1 1 0 0 0 0-1.72l-11-6.86A1 1 0 0 0 8 5.14Z"
} as const;

export function Icon({ path, size = 16, className, style }: { path: string; size?: number; className?: string; style?: CSSProperties; }) {
    return (
        <svg viewBox="0 0 24 24" width={size} height={size} className={className} style={style} aria-hidden>
            <path fill="currentColor" d={path} />
        </svg>
    );
}

// ---------------------------------------------------------------- Colors

/** Apple system colors; used for app icons, glyphs, buttons and states */
export type UiColor = "blue" | "green" | "orange" | "red" | "purple" | "indigo" | "teal" | "yellow" | "pink" | "gray" | "mint";

/** Big rounded app icon, e.g. in a window header */
export function AppIcon({ path, color = "blue", size = 42, children }: { path?: string; color?: UiColor; size?: number; children?: ReactNode; }) {
    return (
        <span className={classes(cl("app-icon"), cl(`fill-${color}`))} style={{ width: size, height: size, borderRadius: size * 0.26 }}>
            {children ?? (path && <Icon path={path} size={Math.round(size * 0.52)} />)}
        </span>
    );
}

/** Small colored square in front of a settings row (like iOS Settings) */
export function Glyph({ path, color = "blue", size = 28 }: { path: string; color?: UiColor; size?: number; }) {
    return (
        <span className={classes(cl("glyph"), cl(`fill-${color}`))} style={{ width: size, height: size, borderRadius: size * 0.25 }}>
            <Icon path={path} size={Math.round(size * 0.58)} />
        </span>
    );
}

// ---------------------------------------------------------------- Controls

/** iOS switch */
export function Toggle({ checked, onChange, label, disabled, color }: {
    checked: boolean; onChange(v: boolean): void; label?: string; disabled?: boolean; color?: UiColor;
}) {
    return (
        <button
            type="button"
            role="switch"
            aria-checked={checked}
            aria-label={label}
            disabled={disabled}
            className={classes(cl("toggle"), checked && cl("toggle-on"))}
            style={checked && color ? { background: `var(--vc-ui-${color})` } : undefined}
            onClick={e => { e.preventDefault(); e.stopPropagation(); if (!disabled) onChange(!checked); }}
        >
            <span className={cl("toggle-knob")} />
        </button>
    );
}

export interface SegmentOption<T extends string> { value: T; label: ReactNode; count?: number; }

/** iOS segmented control with a sliding thumb. A value that matches no option shows nothing selected. */
export function Segmented<T extends string>({ value, options, onChange, small }: {
    value: T | null; options: SegmentOption<T>[]; onChange(v: T): void; small?: boolean;
}) {
    const index = options.findIndex(o => o.value === value);
    return (
        <div className={classes(cl("segmented"), small && cl("segmented-small"))} style={{ "--vc-ui-seg": Math.max(0, index), "--vc-ui-segs": options.length } as CSSProperties} role="tablist">
            {index !== -1 && <span className={cl("segmented-thumb")} />}
            {options.map(o => (
                <button
                    key={o.value}
                    type="button"
                    role="tab"
                    aria-selected={o.value === value}
                    className={classes(cl("segment"), o.value === value && cl("segment-on"))}
                    onClick={() => onChange(o.value)}
                >
                    {o.label}
                    {!!o.count && <span className={cl("segment-count")}>{o.count > 999 ? "999+" : o.count}</span>}
                </button>
            ))}
        </div>
    );
}

export type ButtonVariant = "filled" | "tinted" | "gray" | "plain" | "destructive";

/** Capsule button. filled = main action, tinted/gray = secondary, plain = text only */
export function Button({ children, onClick, variant = "filled", color = "blue", icon, small, disabled, wide, title }: {
    children?: ReactNode; onClick?(e: React.MouseEvent): void; variant?: ButtonVariant; color?: UiColor;
    icon?: string; small?: boolean; disabled?: boolean; wide?: boolean; title?: string;
}) {
    const tone = variant === "destructive" ? "red" : color;
    return (
        <button
            type="button"
            title={title}
            disabled={disabled}
            className={classes(cl("btn"), cl(`btn-${variant === "destructive" ? "filled" : variant}`), small && cl("btn-small"), wide && cl("btn-wide"), !children && cl("btn-icon-only"))}
            style={{ "--vc-ui-tone": `var(--vc-ui-${tone})` } as CSSProperties}
            onClick={onClick}
        >
            {icon && <Icon path={icon} size={small ? 14 : 16} />}
            {children != null && <span>{children}</span>}
        </button>
    );
}

/** Round gray icon button (refresh, close, more …) with a tooltip */
export function RoundButton({ icon, label, onClick, disabled, size = 30, active, className }: {
    icon: string; label: string; onClick(e: React.MouseEvent): void; disabled?: boolean; size?: number; active?: boolean; className?: string;
}) {
    return (
        <Tooltip text={label}>
            {(tip: any) => (
                <button
                    {...tip}
                    type="button"
                    aria-label={label}
                    disabled={disabled}
                    className={classes(cl("round-btn"), active && cl("round-btn-active"), className)}
                    style={{ width: size, height: size }}
                    onClick={e => { e.stopPropagation(); onClick(e); }}
                >
                    <Icon path={icon} size={Math.round(size * 0.5)} />
                </button>
            )}
        </Tooltip>
    );
}

/** Small icon button for row actions; red when destructive */
export function IconButton({ icon, label, onClick, destructive, disabled, active }: {
    icon: string; label: string; onClick(e: React.MouseEvent): void; destructive?: boolean; disabled?: boolean; active?: boolean;
}) {
    return (
        <Tooltip text={label}>
            {(tip: any) => (
                <button
                    {...tip}
                    type="button"
                    aria-label={label}
                    disabled={disabled}
                    className={classes(cl("icon-btn"), destructive && cl("icon-btn-destructive"), active && cl("icon-btn-active"))}
                    onClick={e => { e.stopPropagation(); onClick(e); }}
                >
                    <Icon path={icon} size={16} />
                </button>
            )}
        </Tooltip>
    );
}

/** iOS activity indicator */
export function Spinner({ size = 14 }: { size?: number; }) {
    return (
        <span className={cl("spinner")} style={{ width: size, height: size, "--vc-ui-spin-size": `${size}px` } as CSSProperties} aria-hidden>
            {Array.from({ length: 8 }, (_, i) => <i key={i} style={{ transform: `rotate(${i * 45}deg)`, animationDelay: `${(i - 8) * 0.1}s` }} />)}
        </span>
    );
}

export function Progress({ value, color = "blue" }: { value: number; color?: UiColor; }) {
    return (
        <div className={cl("progress")}>
            <div style={{ width: `${Math.max(0, Math.min(100, value))}%`, background: `var(--vc-ui-${color})` }} />
        </div>
    );
}

/** Small rounded label, e.g. "NEW", "3 left". Clickable when onClick is given. */
export function Badge({ children, color = "gray", solid, icon, title, onClick }: {
    children?: ReactNode; color?: UiColor; solid?: boolean; icon?: string; title?: string; onClick?(e: React.MouseEvent): void;
}) {
    const Tag = onClick ? "button" : "span";
    return (
        <Tag
            type={onClick ? "button" : undefined}
            title={title}
            className={classes(cl("badge"), solid && cl("badge-solid"), onClick && cl("badge-click"))}
            style={{ "--vc-ui-tone": `var(--vc-ui-${color})` } as CSSProperties}
            onClick={onClick ? (e: React.MouseEvent) => { e.stopPropagation(); onClick(e); } : undefined}
        >
            {icon && <Icon path={icon} size={11} />}
            {children}
        </Tag>
    );
}

/** Rounded filter / choice pill (tags, quick picks). With onRemove it shows a small × (removable chip). */
export function Pill({ children, selected, onClick, onRemove, icon, leading, title }: {
    children: ReactNode; selected?: boolean; onClick?(e: React.MouseEvent): void; onRemove?(): void; icon?: string; leading?: ReactNode; title?: string;
}) {
    return (
        <span
            className={classes(cl("pill"), selected && cl("pill-on"), onClick && cl("pill-click"))}
            title={title}
            role={onClick ? "button" : undefined}
            tabIndex={onClick ? 0 : undefined}
            onClick={onClick ? e => { e.stopPropagation(); onClick(e); } : undefined}
            onKeyDown={onClick ? e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onClick(e as any); } } : undefined}
        >
            {leading}
            {icon && <Icon path={icon} size={12} />}
            <span className={cl("pill-label")}>{children}</span>
            {onRemove && (
                <button type="button" className={cl("pill-x")} aria-label="Remove" onClick={e => { e.stopPropagation(); onRemove(); }}>
                    <Icon path={ICONS.close} size={9} />
                </button>
            )}
        </span>
    );
}

/** Wrapping row of pills */
export function Pills({ children }: { children: ReactNode; }) {
    return <div className={cl("pills")}>{children}</div>;
}

/** Slider with the value shown at the right */
export function Slider({ value, onChange, min = 0, max = 100, step = 1, format }: {
    value: number; onChange(v: number): void; min?: number; max?: number; step?: number; format?(v: number): ReactNode;
}) {
    const pct = (value - min) / (max - min || 1) * 100;
    return (
        <span className={cl("slider")}>
            <input
                type="range"
                min={min}
                max={max}
                step={step}
                value={value}
                style={{ "--vc-ui-fill": `${pct}%` } as CSSProperties}
                onChange={e => onChange(Number(e.currentTarget.value))}
            />
            {format && <span className={cl("slider-value")}>{format(value)}</span>}
        </span>
    );
}

/** Colored status text with an optional check / spinner, for the right side of rows */
export function State({ children, tone, spinner, check }: { children: ReactNode; tone?: "ok" | "warn" | "bad"; spinner?: boolean; check?: boolean; }) {
    return (
        <span className={classes(cl("state"), tone && cl(`state-${tone}`))}>
            {spinner && <Spinner />}
            {check && <span className={cl("check")}><Icon path={ICONS.check} size={11} /></span>}
            {children}
        </span>
    );
}

// ---------------------------------------------------------------- Text fields

type InputProps = Omit<React.InputHTMLAttributes<HTMLInputElement>, "onChange" | "value"> & { value: string | number; onChange(v: string): void; };

export function SearchField({ value, onChange, placeholder = "Search", className, ...rest }: InputProps & { value: string; }) {
    return (
        <label className={classes(cl("search"), className)}>
            <Icon path={ICONS.search} size={15} />
            <input {...rest} value={value} placeholder={placeholder} onChange={e => onChange(e.currentTarget.value)} />
            {value && (
                <button type="button" className={cl("search-clear")} aria-label="Clear" onClick={() => onChange("")}>
                    <Icon path={ICONS.close} size={10} />
                </button>
            )}
        </label>
    );
}

export function TextField({ value, onChange, className, ...rest }: InputProps) {
    return <input {...rest} className={classes(cl("field"), className)} value={value} onChange={e => onChange(e.currentTarget.value)} />;
}

type AreaProps = Omit<React.TextareaHTMLAttributes<HTMLTextAreaElement>, "onChange" | "value"> & { value: string; onChange(v: string): void; };

export function TextArea({ value, onChange, className, ...rest }: AreaProps) {
    return <textarea {...rest} className={classes(cl("field"), cl("textarea"), className)} value={value} onChange={e => onChange(e.currentTarget.value)} />;
}

export function Select<T extends string | number>({ value, options, onChange, width, className, disabled }: {
    value: T; options: { value: T; label: string; }[]; onChange(v: T): void; width?: number | string; className?: string; disabled?: boolean;
}) {
    return (
        <select
            className={classes(cl("field"), cl("select"), className)}
            style={width != null ? { width } : undefined}
            disabled={disabled}
            value={String(value)}
            onChange={e => onChange(options.find(o => String(o.value) === e.currentTarget.value)!.value)}
        >
            {options.map(o => <option key={String(o.value)} value={String(o.value)}>{o.label}</option>)}
        </select>
    );
}

/** Label + control, stacked (forms in dialogs) */
export function Field({ label, hint, children }: { label: ReactNode; hint?: ReactNode; children: ReactNode; }) {
    return (
        <div className={cl("form-field")}>
            <span className={cl("form-label")}>{label}</span>
            {children}
            {hint && <span className={cl("form-hint")}>{hint}</span>}
        </div>
    );
}

// ---------------------------------------------------------------- Grouped lists (iOS Settings)

/** Titled group of rows with an optional explanation below */
export function Section({ title, footer, children, right, plain }: {
    title?: ReactNode; footer?: ReactNode; children: ReactNode; right?: ReactNode;
    /** No rounded group background, e.g. for a grid of cards */
    plain?: boolean;
}) {
    return (
        <section className={cl("section")}>
            {(title || right) && (
                <div className={cl("section-head")}>
                    {title && <h3 className={cl("section-title")}>{title}</h3>}
                    {right && <span className={cl("section-right")}>{right}</span>}
                </div>
            )}
            {plain ? children : <div className={cl("group")}>{children}</div>}
            {footer && <p className={cl("section-footer")}>{footer}</p>}
        </section>
    );
}

/** Rounded group of rows without a section around it (e.g. several cards in one section) */
export function Group({ children, className }: { children: ReactNode; className?: string; }) {
    return <div className={classes(cl("group"), className)}>{children}</div>;
}

/** One row of a group: leading picture, title + subtitle, trailing content */
export function Row({ leading, title, subtitle, note, trailing, onClick, chevron, className, dim, align, children }: {
    leading?: ReactNode; title: ReactNode; subtitle?: ReactNode; note?: ReactNode; trailing?: ReactNode;
    onClick?(e: React.MouseEvent): void; chevron?: boolean; className?: string; dim?: boolean;
    /** "top" for rows with several lines (picture and trailing stay at the top) */
    align?: "center" | "top";
    children?: ReactNode;
}) {
    return (
        <div
            className={classes(cl("row"), onClick && cl("row-click"), dim && cl("row-dim"), !leading && cl("row-flat"), align === "top" && cl("row-top"), className)}
            onClick={onClick}
            role={onClick ? "button" : undefined}
            tabIndex={onClick ? 0 : undefined}
            onKeyDown={onClick ? e => {
                if ((e.key === "Enter" || e.key === " ") && e.target === e.currentTarget) {
                    e.preventDefault();
                    onClick(e as any);
                }
            } : undefined}
        >
            {leading && <span className={cl("row-leading")}>{leading}</span>}
            <div className={cl("row-main")}>
                <div className={cl("row-title")}>{title}</div>
                {subtitle && <div className={cl("row-sub")}>{subtitle}</div>}
                {note && <div className={cl("row-note")}>{note}</div>}
                {children}
            </div>
            {trailing != null && <div className={cl("row-trailing")}>{trailing}</div>}
            {chevron && <Icon path={ICONS.chevron} size={14} className={cl("row-chevron")} />}
        </div>
    );
}

/** Settings row with a switch; the whole row toggles */
export function ToggleRow({ icon, color, title, subtitle, checked, onChange, disabled, leading }: {
    icon?: string; color?: UiColor; title: ReactNode; subtitle?: ReactNode; checked: boolean; onChange(v: boolean): void; disabled?: boolean; leading?: ReactNode;
}) {
    return (
        <Row
            leading={leading ?? (icon && <Glyph path={icon} color={color} />)}
            title={title}
            subtitle={subtitle}
            dim={disabled}
            onClick={disabled ? undefined : () => onChange(!checked)}
            trailing={<Toggle checked={checked} onChange={onChange} disabled={disabled} label={typeof title === "string" ? title : undefined} />}
        />
    );
}

/** Blue text row, e.g. "Add rule…" at the end of a group */
export function LinkRow({ children, onClick, icon, destructive }: { children: ReactNode; onClick(): void; icon?: string; destructive?: boolean; }) {
    return (
        <button type="button" className={classes(cl("link-row"), destructive && cl("link-row-destructive"))} onClick={onClick}>
            {icon && <Icon path={icon} size={16} />}
            {children}
        </button>
    );
}

/** Row of big numbers (widgets) */
export function Stats({ items }: { items: { value: ReactNode; label: ReactNode; color?: UiColor; title?: string; }[]; }) {
    return (
        <div className={cl("stats")} style={{ gridTemplateColumns: `repeat(${items.length}, 1fr)` }}>
            {items.map((s, i) => (
                <div key={i} className={cl("stat")} title={s.title}>
                    <span className={cl("stat-value")} style={s.color ? { color: `var(--vc-ui-${s.color})` } : undefined}>{s.value}</span>
                    <span className={cl("stat-label")}>{s.label}</span>
                </div>
            ))}
        </div>
    );
}

export function Empty({ icon, title, hint, children }: { icon?: string; title: ReactNode; hint?: ReactNode; children?: ReactNode; }) {
    return (
        <div className={cl("empty")}>
            {icon && <span className={cl("empty-icon")}><Icon path={icon} size={28} /></span>}
            <b>{title}</b>
            {hint && <span>{hint}</span>}
            {children}
        </div>
    );
}

/** Gray explanation box */
export function Note({ children, tone }: { children: ReactNode; tone?: "warn" | "bad" | "ok"; }) {
    return <div className={classes(cl("note"), tone && cl(`note-${tone}`))}>{children}</div>;
}

export function Avatar({ src, size = 32, fallback = ICONS.user, square }: { src?: string; size?: number; fallback?: string; square?: boolean; }) {
    const [failed, setFailed] = useState(false);
    useEffect(() => setFailed(false), [src]);
    return (
        <span className={classes(cl("avatar"), square && cl("avatar-square"))} style={{ width: size, height: size }}>
            {src && !failed
                ? <img src={src} width={size} height={size} alt="" onError={() => setFailed(true)} />
                : <Icon path={fallback} size={Math.round(size * 0.55)} />}
        </span>
    );
}

// ---------------------------------------------------------------- Windows

export interface WindowHeader {
    title: ReactNode;
    subtitle?: ReactNode;
    /** Green subtitle, e.g. while something runs */
    live?: boolean;
    icon?: string;
    iconColor?: UiColor;
    /** Own picture instead of icon + color */
    iconNode?: ReactNode;
    /** Buttons left of the close button */
    actions?: ReactNode;
}

export interface WindowAction {
    label: ReactNode;
    onClick(): void;
    variant?: ButtonVariant;
    color?: UiColor;
    disabled?: boolean;
}

/**
 * Content of a window: header with app icon, fixed area (segments, stats …), scrolling body, buttons at the bottom.
 * Use inside openWindow(); can also stand alone (e.g. in a settings panel) with `embedded`.
 */
export function Sheet({ header, onClose, top, children, footer, notice, actions, embedded, height, paused, className }: {
    header?: WindowHeader; onClose?(): void; top?: ReactNode; children?: ReactNode;
    /** Free content above the action buttons */
    footer?: ReactNode;
    /** Warning above the action buttons (e.g. why Save is disabled) */
    notice?: ReactNode;
    actions?: WindowAction[];
    /** Inside a page (settings panel) instead of a window: no fixed height, no own scroll */
    embedded?: boolean;
    /** Fixed window height; default fits the content up to 82% of the screen */
    height?: number | string;
    /** Grays out the app icon (plugin paused) */
    paused?: boolean;
    className?: string;
}) {
    return (
        <div
            className={classes(cl("sheet"), embedded && cl("sheet-embedded"), paused && cl("sheet-paused"), className)}
            style={height != null ? { height } : undefined}
        >
            {header && (
                <header className={cl("header")}>
                    {header.iconNode ?? (header.icon && <AppIcon path={header.icon} color={header.iconColor} />)}
                    <div className={cl("header-text")}>
                        <h2 className={cl("title")}>{header.title}</h2>
                        {header.subtitle && <span className={classes(cl("subtitle"), header.live && cl("subtitle-live"))}>{header.subtitle}</span>}
                    </div>
                    {header.actions}
                    {onClose && !embedded && <RoundButton icon={ICONS.close} label="Close" onClick={onClose} className={cl("close")} />}
                </header>
            )}
            {top}
            <div className={cl("body")}>{children}</div>
            {(footer || notice || actions?.length) && (
                <footer className={cl("footer")}>
                    {notice && <Note tone="warn">{notice}</Note>}
                    {footer}
                    {!!actions?.length && (
                        <div className={cl("actions")}>
                            {actions.map((a, i) => (
                                <Button key={i} variant={a.variant ?? (i === actions.length - 1 ? "filled" : "gray")} color={a.color} disabled={a.disabled} onClick={a.onClick}>
                                    {a.label}
                                </Button>
                            ))}
                        </div>
                    )}
                </footer>
            )}
        </div>
    );
}

export type WindowSize = "small" | "medium" | "large" | "dynamic";

const SIZES: Record<WindowSize, ModalSize> = {
    small: ModalSize.SMALL,
    medium: ModalSize.MEDIUM,
    large: ModalSize.LARGE,
    dynamic: ModalSize.DYNAMIC
};

/** Vencord types it as never */
const Root = ModalRoot as any;

/** Opens a glass window (Discord modal). render gets close() and should return a <Sheet>. */
export function openWindow(render: (close: () => void) => ReactNode, { size = "medium", className }: { size?: WindowSize; className?: string; } = {}) {
    return openModal(props => (
        <Root {...props} size={SIZES[size]} className={classes(cl("window"), cl(`window-${size}`), className)}>
            <ErrorBoundary noop>
                {render(props.onClose)}
            </ErrorBoundary>
        </Root>
    ));
}

/** macOS alert: icon, title, text and up to three buttons. Resolves with the clicked index (-1 = closed). */
export function openAlert({ title, body, icon, iconColor = "blue", buttons }: {
    title: ReactNode; body?: ReactNode; icon?: string; iconColor?: UiColor;
    buttons: { label: ReactNode; variant?: ButtonVariant; color?: UiColor; }[];
}) {
    return new Promise<number>(resolve => {
        let done = false;
        const finish = (i: number) => { if (!done) { done = true; resolve(i); } };
        openModal(props => (
            <Root {...props} size={ModalSize.SMALL} className={classes(cl("window"), cl("alert-window"))}>
                <div className={cl("alert")}>
                    {icon && <AppIcon path={icon} color={iconColor} size={56} />}
                    <h2 className={cl("alert-title")}>{title}</h2>
                    {body && <div className={cl("alert-body")}>{body}</div>}
                    <div className={classes(cl("alert-buttons"), buttons.length > 2 && cl("alert-buttons-stacked"))}>
                        {buttons.map((b, i) => (
                            <Button key={i} wide variant={b.variant ?? (i === buttons.length - 1 ? "filled" : "gray")} color={b.color} onClick={() => { finish(i); props.onClose(); }}>
                                {b.label}
                            </Button>
                        ))}
                    </div>
                </div>
            </Root>
        ), { onCloseCallback: () => finish(-1) });
    });
}

/** Yes/no question; true if confirmed */
export async function confirm({ title, body, confirmText = "OK", cancelText = "Cancel", destructive, icon, iconColor }: {
    title: ReactNode; body?: ReactNode; confirmText?: string; cancelText?: string; destructive?: boolean; icon?: string; iconColor?: UiColor;
}) {
    const i = await openAlert({
        title, body, icon, iconColor: iconColor ?? (destructive ? "red" : "blue"),
        buttons: [{ label: cancelText }, { label: confirmText, variant: destructive ? "destructive" : "filled" }]
    });
    return i === 1;
}

// ---------------------------------------------------------------- Popover (glass card for popouts)

/** Glass card for Discord Popouts and own floating panels */
export function Popover({ children, className, width, style }: { children: ReactNode; className?: string; width?: number; style?: CSSProperties; }) {
    return <div className={classes(cl("popover"), className)} style={{ width, ...style }}>{children}</div>;
}

// ---------------------------------------------------------------- Notifications (top right, macOS style)

export type NotifyKind = "success" | "attention" | "info" | "error";

export interface NotifyOptions {
    title: ReactNode;
    body?: ReactNode;
    kind?: NotifyKind;
    /** Picture at the left instead of the kind icon */
    image?: string;
    /** Own icon path (with the kind's color) */
    icon?: string;
    /** Name of the plugin, shown small like the app name in macOS */
    app?: string;
    /** Shown below the text, e.g. a reward */
    side?: ReactNode;
    onClick?(): void;
    /** ms, default 6000 */
    duration?: number;
}

interface NotifyItem extends NotifyOptions { id: number; }

const MAX_NOTIFICATIONS = 4;
let notifications: NotifyItem[] = [];
let nextNotifyId = 1;
const notifyListeners = new Set<() => void>();
const emitNotify = () => notifyListeners.forEach(l => l());
let notifyRoot: ReturnType<typeof createRoot> | null = null;

function mountNotifications() {
    if (notifyRoot) return;
    const host = document.createElement("div");
    host.className = cl("notify-host");
    document.body.appendChild(host);
    notifyRoot = createRoot(host);
    notifyRoot.render(<ErrorBoundary noop><Notifications /></ErrorBoundary>);
}

/** Shows a macOS style notification at the top right inside Discord */
export function notify(options: NotifyOptions) {
    mountNotifications();
    notifications = [...notifications, { ...options, id: nextNotifyId++ }].slice(-MAX_NOTIFICATIONS);
    emitNotify();
}

function dismissNotification(id: number) {
    notifications = notifications.filter(t => t.id !== id);
    emitNotify();
}

const KIND_ICON: Record<NotifyKind, string> = {
    success: ICONS.check,
    attention: ICONS.warning,
    info: ICONS.info,
    error: ICONS.warning
};

function Notification({ item }: { item: NotifyItem; }) {
    const kind = item.kind ?? "info";
    const [leaving, setLeaving] = useState(false);
    const [broken, setBroken] = useState(false);
    const hovered = useRef(false);
    const left = useRef(item.duration ?? 6000);

    const close = () => {
        setLeaving(true);
        setTimeout(() => dismissNotification(item.id), 180);
    };

    // Counts down only while not hovered
    useEffect(() => {
        let last = Date.now();
        const t = setInterval(() => {
            const now = Date.now();
            if (!hovered.current) left.current -= now - last;
            last = now;
            if (left.current <= 0) {
                clearInterval(t);
                close();
            }
        }, 50);
        return () => clearInterval(t);
    }, []);

    return (
        <div
            className={classes(cl("notify"), cl(`notify-${kind}`), leaving && cl("notify-leave"), item.onClick && cl("notify-click"))}
            onMouseEnter={() => hovered.current = true}
            onMouseLeave={() => hovered.current = false}
            onClick={() => {
                if (!item.onClick) return;
                item.onClick();
                close();
            }}
        >
            <button type="button" className={cl("notify-close")} aria-label="Close" onClick={e => { e.stopPropagation(); close(); }}>
                <Icon path={ICONS.close} size={10} />
            </button>
            {item.image && !broken
                ? <img className={cl("notify-img")} src={item.image} alt="" onError={() => setBroken(true)} />
                : <div className={cl("notify-icon")}><Icon path={item.icon ?? KIND_ICON[kind]} size={20} /></div>}
            <div className={cl("notify-main")}>
                <div className={cl("notify-head")}>
                    <span className={cl("notify-title")}>{item.title}</span>
                    <span className={cl("notify-when")}>{item.app ?? "now"}</span>
                </div>
                {item.body && <div className={cl("notify-body")}>{item.body}</div>}
                {item.side && <div className={cl("notify-side")}>{item.side}</div>}
            </div>
        </div>
    );
}

function Notifications() {
    const [, setTick] = useState(0);
    useEffect(() => {
        const l = () => setTick(t => t + 1);
        notifyListeners.add(l);
        return () => void notifyListeners.delete(l);
    }, []);
    return <div className={cl("notify-stack")}>{notifications.map(t => <Notification key={t.id} item={t} />)}</div>;
}

// ---------------------------------------------------------------- Hooks

/** Re-renders when a plain listener set fires (simple stores) */
export function useListener(listeners: Set<() => void>) {
    const [, setTick] = useState(0);
    useEffect(() => {
        const l = () => setTick(t => t + 1);
        listeners.add(l);
        return () => void listeners.delete(l);
    }, [listeners]);
}

// ---------------------------------------------------------------- Title bar (arrangeable icons)

export { startArranging, titleBarSlot } from "./titlebar";
