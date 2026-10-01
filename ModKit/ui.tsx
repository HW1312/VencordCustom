/*
 * ModKit – UI: ModNotes window, macro confirmation and quick pick, warning badges,
 * scam notice on messages, and settings (incl. macro editor)
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./ui.css";

import { classNameFactory } from "@api/Styles";
import ErrorBoundary from "@components/ErrorBoundary";
import { Switch } from "@components/Switch";
import { classes } from "@utils/misc";
import { RenderModalProps } from "@vencord/discord-types";
import { ChannelStore, GuildMemberStore, GuildStore, Modal, NavigationRouter, openModal, PermissionsBits, PermissionStore, SelectedGuildStore, showToast, Toasts, useEffect, useMemo, useRef, UserStore, useState, useStateFromStores } from "@webpack/common";
import type { ReactNode } from "react";

import { BadgeMode, settings, unsetNotesChannel } from "./index";
import { BAN_DELETE_OPTIONS, describeStep, getMacros, getScamMacro, hierarchyProblem, Macro, makePresets, messageLink, needsConfirm, RunHandle, runMacro, Step, STEP_LABELS, STEP_TYPES, stepProblem, StepStatus, StepType, Target, targetFromMessage, TIMEOUT_OPTIONS, uid } from "./macros";
import { cancelLoad, canDeleteNote, canWriteNotes, deleteNote, describeError, ensureLoaded, formatDuration, getCounts, getLoadState, getNotesChannelId, getNotesForUser, getVersion, Note, NOTE_EMOJI, NOTE_LABELS, NOTE_TYPES, NoteType, resync, subscribe, writeNote } from "./notes";
import { detectScam } from "./scam";

const cl = classNameFactory("vc-modkit-");

// ---------------------------------------------------------------- Icons

const GAVEL_PATH = "M1 21h12v2H1v-2ZM5.245 8.07l2.83-2.827 14.14 14.142-2.828 2.828L5.245 8.07Zm7.072-7.07 5.657 5.656-2.83 2.83-5.654-5.66L12.317 1ZM3.825 9.485l5.657 5.657-2.828 2.828-5.657-5.657 2.828-2.828Z";
const WARN_PATH = "M1 21h22L12 2 1 21Zm12-3h-2v-2h2v2Zm0-4h-2v-4h2v4Z";

export function ModKitIcon({ height = 20, width = 20, className }: { height?: number | string; width?: number | string; className?: string; }) {
    return (
        <svg viewBox="0 0 24 24" width={width} height={height} className={className} aria-hidden>
            <path fill="currentColor" d={GAVEL_PATH} />
        </svg>
    );
}

function WarnIcon({ size = 12 }: { size?: number; }) {
    return (
        <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden>
            <path fill="currentColor" d={WARN_PATH} />
        </svg>
    );
}

// ---------------------------------------------------------------- Helpers

/** Re-render whenever ModNotes change */
function useNotesVersion() {
    const [, setTick] = useState(0);
    useEffect(() => subscribe(() => setTick(t => t + 1)), []);
    return getVersion();
}

function userName(guildId: string, userId: string) {
    const nick = GuildMemberStore.getNick(guildId, userId);
    const user: any = UserStore.getUser(userId);
    return nick ?? user?.globalName ?? user?.username ?? `Unknown (${userId})`;
}

const formatDate = (ts: number) => new Date(ts).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" });

const LINK_RE = /^https:\/\/(?:ptb\.|canary\.)?discord(?:app)?\.com\/channels\/(\d+|@me)\/(\d+)(?:\/(\d+))?/;

function openDiscordLink(link: string, onNavigate?: () => void) {
    const m = LINK_RE.exec(link);
    if (!m) return;
    onNavigate?.();
    NavigationRouter.transitionTo(`/channels/${m[1]}/${m[2]}${m[3] ? `/${m[3]}` : ""}`);
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

// ---------------------------------------------------------------- Building blocks

function Toggle({ checked, onChange, label, hint }: { checked: boolean; onChange(v: boolean): void; label: string; hint?: string; }) {
    return (
        <label className={cl("option")}>
            <span className={cl("option-text")}>
                <span>{label}</span>
                {hint && <span className={cl("muted")}>{hint}</span>}
            </span>
            <Switch checked={checked} onChange={onChange} />
        </label>
    );
}

function Segmented<T extends string>({ value, options, onChange, disabled }: { value: T; options: { value: T; label: ReactNode; }[]; onChange(v: T): void; disabled?: boolean; }) {
    return (
        <div className={classes(cl("segmented"), disabled && cl("disabled"))}>
            {options.map(o => (
                <button
                    key={o.value}
                    type="button"
                    disabled={disabled}
                    className={classes(cl("segment"), o.value === value && cl("segment-on"))}
                    onClick={() => onChange(o.value)}
                >
                    {o.label}
                </button>
            ))}
        </div>
    );
}

function NativeSelect<T extends string | number>({ value, options, onChange, className }: { value: T; options: { value: T; label: string; }[]; onChange(v: T): void; className?: string; }) {
    return (
        <select
            className={classes(cl("select"), className)}
            value={String(value)}
            onChange={e => {
                const o = options.find(o => String(o.value) === e.currentTarget.value);
                if (o) onChange(o.value);
            }}
        >
            {options.map(o => <option key={String(o.value)} value={String(o.value)}>{o.label}</option>)}
        </select>
    );
}

/** Input that only saves on blur (spares the settings file) */
function DraftInput({ value, onCommit, placeholder, multiline, maxLength, className }: {
    value: string; onCommit(v: string): void; placeholder?: string; multiline?: boolean; maxLength?: number; className?: string;
}) {
    const [v, setV] = useState(value);
    useEffect(() => setV(value), [value]);
    const props: any = {
        value: v,
        placeholder,
        maxLength,
        className: classes(cl("input"), className),
        onChange: (e: any) => setV(e.currentTarget.value),
        onBlur: () => v !== value && onCommit(v)
    };
    return multiline
        ? <textarea rows={2} {...props} />
        : <input type="text" {...props} onKeyDown={(e: any) => e.key === "Enter" && e.currentTarget.blur()} />;
}

function Btn({ children, onClick, variant = "secondary", disabled, title, small }: {
    children: ReactNode; onClick(): void; variant?: "primary" | "secondary" | "danger" | "ghost"; disabled?: boolean; title?: string; small?: boolean;
}) {
    return (
        <button
            type="button"
            title={title}
            disabled={disabled}
            className={classes(cl("btn"), cl(`btn-${variant}`), small && cl("btn-small"))}
            onClick={onClick}
        >
            {children}
        </button>
    );
}

const DURATION_OPTIONS = TIMEOUT_OPTIONS.map(v => ({ value: v, label: formatDuration(v) }));
const BAN_OPTIONS = BAN_DELETE_OPTIONS.map(v => ({ value: v, label: v ? `Last ${formatDuration(v)}` : "Delete nothing" }));
const NOTE_TYPE_OPTIONS = NOTE_TYPES.map(t => ({ value: t, label: `${NOTE_EMOJI[t]} ${NOTE_LABELS[t]}` }));

// ---------------------------------------------------------------- Warning badges

function Badge({ guildId, userId }: { guildId: string; userId: string; }) {
    useNotesVersion();
    const { badgeMode } = settings.use(["badgeMode"]);
    useEffect(() => void ensureLoaded(guildId), [guildId]);

    const counts = getCounts(guildId, userId);
    const n = badgeMode === "all" ? counts.all : counts.warn;
    if (!n) return null;

    const label = badgeMode === "all" ? plural(n, "violation", "violations") : plural(n, "warning", "warnings");

    return (
        <span
            role="button"
            className={classes(cl("badge"), n >= 3 && cl("badge-hot"))}
            title={`${label} (ModKit) - click for ModNotes`}
            onClick={e => {
                e.preventDefault();
                e.stopPropagation();
                openNotesModal(guildId, userId);
            }}
        >
            <WarnIcon size={11} />
            {n}
        </span>
    );
}

export const MessageBadge = ErrorBoundary.wrap(({ message, channel }: { message: any; channel: any; }) => {
    const { showBadgeChat } = settings.use(["showBadgeChat", "notesChannels"]);
    const guildId: string | undefined = channel?.guild_id;
    if (!showBadgeChat || !guildId || !message?.author?.id || !getNotesChannelId(guildId)) return null;
    return <Badge guildId={guildId} userId={message.author.id} />;
}, { noop: true });

export const MemberListBadge = ErrorBoundary.wrap(({ userId }: { userId: string; }) => {
    const { showBadgeMemberList } = settings.use(["showBadgeMemberList", "notesChannels"]);
    const guildId = useStateFromStores([SelectedGuildStore], () => SelectedGuildStore.getGuildId());
    if (!showBadgeMemberList || !guildId || !getNotesChannelId(guildId)) return null;
    return <Badge guildId={guildId} userId={userId} />;
}, { noop: true });

// ---------------------------------------------------------------- Scam notice

const dismissed = new Set<string>();

export const ScamAccessory = ErrorBoundary.wrap(({ message }: { message: any; }) => {
    const { scamDetector } = settings.use(["scamDetector"]);
    const [, setTick] = useState(0);
    if (!scamDetector || !message?.author || dismissed.has(message.id)) return null;

    const channel = ChannelStore.getChannel(message.channel_id);
    if (!channel?.guild_id || message.author.id === UserStore.getCurrentUser()?.id) return null;
    // Only for mods with the required permissions
    if (!PermissionStore.can(PermissionsBits.MANAGE_MESSAGES, channel) || !PermissionStore.can(PermissionsBits.BAN_MEMBERS, { id: channel.guild_id })) return null;

    const hit = detectScam(message);
    if (!hit) return null;

    return (
        <div className={cl("scam")}>
            <span className={cl("scam-icon")}><WarnIcon size={16} /></span>
            <span className={cl("scam-text")}>
                <b>Possible scam link</b>
                <span className={cl("scam-detail")}>{hit.host} - {hit.reason}</span>
            </span>
            <Btn small variant="danger" onClick={() => openMacroModal(getScamMacro(), targetFromMessage(message, channel))}>
                Delete + Ban
            </Btn>
            <Btn small variant="ghost" title="Hide the notice for this message" onClick={() => {
                dismissed.add(message.id);
                setTick(t => t + 1);
            }}>
                Ignore
            </Btn>
        </div>
    );
}, { noop: true });

// ---------------------------------------------------------------- ModNotes window

export function openNotesModal(guildId: string, userId: string, target?: Target) {
    openModal(props => (
        <ErrorBoundary>
            <NotesModal modalProps={props} guildId={guildId} userId={userId} target={target} />
        </ErrorBoundary>
    ));
}

function NotesModal({ modalProps, guildId, userId, target }: { modalProps: RenderModalProps; guildId: string; userId: string; target?: Target; }) {
    useNotesVersion();
    useEffect(() => void ensureLoaded(guildId), [guildId]);

    const notes = getNotesForUser(guildId, userId);
    const guild = GuildStore.getGuild(guildId);

    return (
        <Modal
            {...modalProps}
            size="md"
            title={`ModNotes - ${userName(guildId, userId)}`}
            subtitle={`${guild?.name ?? "Server"} · ID ${userId}`}
            actions={[{ text: "Close", variant: "secondary", onClick: modalProps.onClose }]}
        >
            <div className={cl("notes")}>
                <LoadBanner guildId={guildId} />
                <Summary notes={notes} />
                <AddNoteForm guildId={guildId} userId={userId} target={target} />
                <Timeline guildId={guildId} notes={notes} onNavigate={modalProps.onClose} />
            </div>
        </Modal>
    );
}

function LoadBanner({ guildId }: { guildId: string; }) {
    const state = getLoadState(guildId);
    if (!state || state.loaded) return null;

    if (state.loading) return (
        <div className={cl("banner")}>
            <span className={cl("spinner")} />
            <span className={cl("grow")}>Loading ModNotes history ... {state.progress ? `${state.progress} messages` : ""}</span>
            <Btn small onClick={() => cancelLoad(guildId)}>Cancel</Btn>
        </div>
    );

    return (
        <div className={classes(cl("banner"), state.error && cl("banner-error"))}>
            <span className={cl("grow")}>
                {state.error ? `Loading failed: ${state.error}` : "Loading cancelled - the list may be incomplete."}
            </span>
            <Btn small onClick={() => void ensureLoaded(guildId, true)}>Reload</Btn>
        </div>
    );
}

function Summary({ notes }: { notes: Note[]; }) {
    if (!notes.length) return null;
    const counts = NOTE_TYPES.map(t => [t, notes.filter(n => n.type === t).length] as const).filter(([, n]) => n);
    return (
        <div className={cl("summary")}>
            {counts.map(([t, n]) => (
                <span key={t} className={classes(cl("type"), cl(`type-${t}`))}>{NOTE_EMOJI[t]} {n}× {NOTE_LABELS[t]}</span>
            ))}
        </div>
    );
}

function AddNoteForm({ guildId, userId, target }: { guildId: string; userId: string; target?: Target; }) {
    const targetLink = target && target.userId === userId ? messageLink(target) : undefined;
    const [type, setType] = useState<NoteType>("warn");
    const [reason, setReason] = useState("");
    const [duration, setDuration] = useState(3600);
    const [ref, setRef] = useState(targetLink ?? "");
    const [saving, setSaving] = useState(false);

    const problem = canWriteNotes(guildId);
    const refInvalid = ref.trim() !== "" && !LINK_RE.test(ref.trim());
    const disabled = !!problem || saving || !reason.trim() || refInvalid;

    async function save() {
        setSaving(true);
        try {
            const r = ref.trim();
            await writeNote(guildId, {
                type,
                userId,
                reason: reason.trim(),
                duration: type === "timeout" ? duration : undefined,
                ref: r || undefined,
                excerpt: r && r === targetLink ? target?.excerpt : undefined
            });
            setReason("");
            showToast("ModKit: Note saved", Toasts.Type.SUCCESS);
        } catch (e) {
            showToast(`ModKit: Could not save note - ${describeError(e)}`, Toasts.Type.FAILURE);
        } finally {
            setSaving(false);
        }
    }

    return (
        <div className={cl("card")}>
            <div className={cl("card-title")}>Add note</div>
            {problem && <div className={cl("warning")}>{problem}</div>}
            <Segmented<NoteType>
                value={type}
                disabled={!!problem}
                onChange={setType}
                options={NOTE_TYPES.map(t => ({ value: t, label: <>{NOTE_EMOJI[t]} {NOTE_LABELS[t]}</> }))}
            />
            {type === "timeout" && (
                <div className={cl("row")}>
                    <span className={cl("label")}>Duration</span>
                    <NativeSelect<number> value={duration} options={DURATION_OPTIONS} onChange={setDuration} />
                    <span className={cl("muted")}>Record only - does not apply a timeout.</span>
                </div>
            )}
            <textarea
                className={cl("input")}
                rows={3}
                maxLength={900}
                placeholder="Reason / description"
                value={reason}
                disabled={!!problem}
                onChange={e => setReason(e.currentTarget.value)}
            />
            <input
                type="text"
                className={classes(cl("input"), refInvalid && cl("input-invalid"))}
                placeholder="Message link as evidence (optional)"
                value={ref}
                disabled={!!problem}
                onChange={e => setRef(e.currentTarget.value)}
            />
            {refInvalid && <div className={cl("muted")}>Discord message links only (https://discord.com/channels/...)</div>}
            <div className={cl("actions")}>
                <span className={cl("muted")}>Saved as a message in the ModNotes channel.</span>
                <Btn variant="primary" disabled={disabled} onClick={save}>{saving ? "Saving ..." : "Save"}</Btn>
            </div>
        </div>
    );
}

function Timeline({ guildId, notes, onNavigate }: { guildId: string; notes: Note[]; onNavigate(): void; }) {
    if (!notes.length) return <div className={cl("empty")}>No entries for this person yet.</div>;
    return (
        <div className={cl("timeline")}>
            {notes.map(n => <NoteItem key={n.id} note={n} guildId={guildId} onNavigate={onNavigate} />)}
        </div>
    );
}

function NoteItem({ note, guildId, onNavigate }: { note: Note; guildId: string; onNavigate(): void; }) {
    const [armed, setArmed] = useState(false);
    const [busy, setBusy] = useState(false);

    async function remove() {
        if (!armed) {
            setArmed(true);
            setTimeout(() => setArmed(false), 4000);
            return;
        }
        setBusy(true);
        try {
            await deleteNote(note);
            showToast("ModKit: Note deleted", Toasts.Type.SUCCESS);
        } catch (e) {
            showToast(`ModKit: Could not delete note - ${describeError(e)}`, Toasts.Type.FAILURE);
            setBusy(false);
        }
    }

    return (
        <div className={classes(cl("note"), cl(`note-${note.type}`))}>
            <div className={cl("note-head")}>
                <span className={classes(cl("type"), cl(`type-${note.type}`))}>
                    {NOTE_EMOJI[note.type]} {NOTE_LABELS[note.type]}{note.duration ? ` · ${formatDuration(note.duration)}` : ""}
                </span>
                <span className={cl("note-meta")}>by {userName(guildId, note.authorId)} · {formatDate(note.timestamp)}</span>
                {canDeleteNote(note) && (
                    <Btn small variant={armed ? "danger" : "ghost"} disabled={busy} onClick={remove} title="Deletes the message in the ModNotes channel">
                        {armed ? "Really delete?" : "Delete"}
                    </Btn>
                )}
            </div>
            <div className={cl("note-reason")}>{note.reason || <i className={cl("muted")}>no reason given</i>}</div>
            {note.excerpt && <div className={cl("excerpt")}>{note.excerpt}</div>}
            <div className={cl("note-links")}>
                {note.ref && LINK_RE.test(note.ref) && (
                    <a className={cl("link")} onClick={() => openDiscordLink(note.ref!, onNavigate)}>↪ Go to message</a>
                )}
                <a className={cl("link")} onClick={() => openDiscordLink(`https://discord.com/channels/${guildId}/${note.channelId}/${note.id}`, onNavigate)}>
                    In ModNotes channel
                </a>
            </div>
        </div>
    );
}

// ---------------------------------------------------------------- Run macro

export function runOrConfirm(macro: Macro, target: Target) {
    if (needsConfirm(macro, target)) openMacroModal(macro, target);
    else void runMacro(macro, target, macro.reason);
}

export function openMacroModal(macro: Macro, target: Target) {
    openModal(props => (
        <ErrorBoundary>
            <MacroModal modalProps={props} macro={macro} target={target} />
        </ErrorBoundary>
    ));
}

const STATUS_ICON: Record<StepStatus, string> = {
    pending: "•",
    running: "…",
    done: "✓",
    skipped: "–",
    failed: "✕"
};

function MacroModal({ modalProps, macro, target }: { modalProps: RenderModalProps; macro: Macro; target: Target; }) {
    const [reason, setReason] = useState(macro.reason);
    const [phase, setPhase] = useState<"idle" | "running" | "done">("idle");
    const [status, setStatus] = useState<{ s: StepStatus; info?: string; }[]>(() => macro.steps.map(() => ({ s: "pending" })));
    const handle = useRef<RunHandle>({ cancelled: false });

    const problems = useMemo(() => macro.steps.map(s => stepProblem(s, target)), [macro, target]);
    const runnable = problems.some(p => p == null);
    const needsHierarchy = macro.steps.some(s => s.type === "timeout" || s.type === "kick" || s.type === "ban");
    const hierarchy = needsHierarchy ? hierarchyProblem(target.guildId, target.userId) : null;

    // Window closed -> don't run the remaining steps
    useEffect(() => () => void (handle.current.cancelled = true), []);

    async function run() {
        setPhase("running");
        const res = await runMacro(macro, target, reason.trim(), (i, s, info) => {
            setStatus(prev => {
                const next = [...prev];
                next[i] = { s, info };
                return next;
            });
        }, handle.current);
        setPhase("done");
        if (!res.failed && !handle.current.cancelled) setTimeout(modalProps.onClose, 700);
    }

    const actions = phase === "idle"
        ? [
            { text: "Cancel", variant: "secondary", onClick: modalProps.onClose },
            { text: "Run", variant: "critical-primary", disabled: !runnable, onClick: run }
        ]
        : phase === "running"
            ? [{ text: "Stop", variant: "secondary", onClick: () => void (handle.current.cancelled = true) }]
            : [{ text: "Close", variant: "secondary", onClick: modalProps.onClose }];

    return (
        <Modal
            {...modalProps}
            size="md"
            title={`${macro.emoji} Run ${macro.name}?`}
            subtitle={`Target: ${userName(target.guildId, target.userId)} (${target.userId})`}
            actions={actions}
        >
            <div className={cl("notes")}>
                {target.excerpt && <div className={cl("excerpt")}>{target.excerpt}</div>}
                {hierarchy && <div className={cl("warning")}>{hierarchy} Timeout, kick and ban will be skipped.</div>}

                <div className={cl("card")}>
                    <div className={cl("card-title")}>What will happen</div>
                    <ol className={cl("steps")}>
                        {macro.steps.map((step, i) => {
                            const st = status[i];
                            const blocked = problems[i];
                            const state = phase === "idle" ? (blocked ? "skipped" : "pending") : st.s;
                            return (
                                <li key={step.id} className={classes(cl("step"), cl(`step-${state}`))}>
                                    <span className={cl("step-icon")}>{STATUS_ICON[state]}</span>
                                    <span className={cl("step-text")}>
                                        <span className={blocked ? cl("strike") : undefined}>{describeStep(step)}</span>
                                        {(blocked || st.info) && <span className={cl("muted")}>{st.info ?? `Will be skipped: ${blocked}`}</span>}
                                    </span>
                                </li>
                            );
                        })}
                    </ol>
                    {!macro.steps.length && <div className={cl("muted")}>This macro has no steps.</div>}
                </div>

                <div className={cl("card")}>
                    <div className={cl("card-title")}>Reason (audit log & note)</div>
                    <input
                        type="text"
                        className={cl("input")}
                        maxLength={400}
                        value={reason}
                        disabled={phase !== "idle"}
                        placeholder={macro.name}
                        onChange={e => setReason(e.currentTarget.value)}
                    />
                </div>
            </div>
        </Modal>
    );
}

// ---------------------------------------------------------------- Quick pick (message button)

export function openQuickPick(message: any, channel: any) {
    const target = targetFromMessage(message, channel);
    openModal(props => (
        <ErrorBoundary>
            <QuickPick modalProps={props} target={target} />
        </ErrorBoundary>
    ));
}

function QuickPick({ modalProps, target }: { modalProps: RenderModalProps; target: Target; }) {
    useNotesVersion();
    const hasNotes = !!getNotesChannelId(target.guildId);
    useEffect(() => void (hasNotes && ensureLoaded(target.guildId)), [target.guildId]);
    const macros = getMacros();

    return (
        <Modal
            {...modalProps}
            size="sm"
            title="ModKit"
            subtitle={`Target: ${userName(target.guildId, target.userId)}`}
            actions={[{ text: "Close", variant: "secondary", onClick: modalProps.onClose }]}
        >
            <div className={cl("pick")}>
                {macros.map(m => {
                    const problems = m.steps.map(s => stepProblem(s, target));
                    const blocked = !m.steps.length || problems.every(Boolean);
                    return (
                        <button
                            key={m.id}
                            type="button"
                            className={cl("pick-item")}
                            disabled={blocked}
                            title={blocked ? problems.find(Boolean) ?? "No steps" : undefined}
                            onClick={() => {
                                modalProps.onClose();
                                runOrConfirm(m, target);
                            }}
                        >
                            <span className={cl("pick-emoji")}>{m.emoji}</span>
                            <span className={cl("pick-text")}>
                                <span className={cl("pick-name")}>{m.name}{m.confirm && <span className={cl("chip")}>Confirm</span>}</span>
                                <span className={cl("muted")}>{m.steps.map(s => STEP_LABELS[s.type]).join(" → ") || "No steps"}</span>
                            </span>
                        </button>
                    );
                })}
                {!macros.length && <div className={cl("empty")}>No macros - create some in the plugin settings.</div>}
                {hasNotes && (
                    <button
                        type="button"
                        className={classes(cl("pick-item"), cl("pick-notes"))}
                        onClick={() => {
                            modalProps.onClose();
                            openNotesModal(target.guildId, target.userId, target);
                        }}
                    >
                        <span className={cl("pick-emoji")}>📝</span>
                        <span className={cl("pick-text")}>
                            <span className={cl("pick-name")}>ModNotes ({getNotesForUser(target.guildId, target.userId).length})</span>
                            <span className={cl("muted")}>View history & add note</span>
                        </span>
                    </button>
                )}
            </div>
        </Modal>
    );
}

// ---------------------------------------------------------------- Settings: ModNotes channels

function ChannelList() {
    useNotesVersion();
    const { notesChannels } = settings.use(["notesChannels"]);
    const entries = Object.entries(notesChannels ?? {});

    if (!entries.length) return (
        <div className={cl("empty")}>
            No ModNotes channel yet. Right-click a private mod channel → <b>"Set as ModNotes channel"</b>.
        </div>
    );

    return (
        <div className={cl("list")}>
            {entries.map(([guildId, channelId]) => {
                const guild = GuildStore.getGuild(guildId);
                const channel = ChannelStore.getChannel(channelId);
                const state = getLoadState(guildId);
                const status = !state ? "" :
                    state.loading ? `loading ... ${state.progress} messages` :
                        state.error ? `Error: ${state.error}` :
                            state.loaded ? plural(state.count, "note", "notes") : "not loaded yet";
                return (
                    <div key={guildId} className={cl("list-item")}>
                        <span className={cl("grow")}>
                            <span className={cl("strong")}>{guild?.name ?? `Server ${guildId}`}</span>
                            <span className={cl("muted")}>#{channel?.name ?? "unknown channel"} · {status}</span>
                        </span>
                        {state?.loading
                            ? <Btn small onClick={() => cancelLoad(guildId)}>Cancel</Btn>
                            : state?.loaded
                                ? <Btn small onClick={() => void resync(guildId)} title="Discard cache and reload everything">Resync</Btn>
                                : <Btn small onClick={() => void ensureLoaded(guildId, true)}>Load</Btn>}
                        <Btn small variant="danger" onClick={() => unsetNotesChannel(guildId)}>Remove</Btn>
                    </div>
                );
            })}
        </div>
    );
}

// ---------------------------------------------------------------- Settings: macro editor

function saveMacros(list: Macro[]) {
    settings.store.macros = list;
}

function updateMacro(id: string, fn: (m: Macro) => Macro) {
    saveMacros(getMacros().map(m => m.id === id ? fn({ ...m, steps: [...m.steps] }) : m));
}

function move<T>(arr: T[], from: number, to: number) {
    if (to < 0 || to >= arr.length) return arr;
    const next = [...arr];
    const [item] = next.splice(from, 1);
    next.splice(to, 0, item);
    return next;
}

function defaultStep(type: StepType): Step {
    switch (type) {
        case "timeout": return { id: uid(), type, duration: 3600 };
        case "ban": return { id: uid(), type, deleteSeconds: 86400 };
        case "reply": return { id: uid(), type, text: "{user} please follow our rules: {rule}", rule: "" };
        case "note": return { id: uid(), type, noteType: "warn", reason: "" };
        default: return { id: uid(), type };
    }
}

function StepEditor({ step, index, count, onChange, onMove, onRemove }: {
    step: Step; index: number; count: number; onChange(s: Step): void; onMove(to: number): void; onRemove(): void;
}) {
    return (
        <div className={cl("step-edit")}>
            <div className={cl("row")}>
                <span className={cl("step-num")}>{index + 1}</span>
                <NativeSelect
                    value={step.type}
                    options={STEP_TYPES.map(t => ({ value: t, label: STEP_LABELS[t] }))}
                    onChange={t => onChange(defaultStep(t))}
                />
                {step.type === "timeout" && (
                    <NativeSelect value={step.duration ?? 3600} options={DURATION_OPTIONS} onChange={v => onChange({ ...step, duration: v })} />
                )}
                {step.type === "ban" && (
                    <NativeSelect value={step.deleteSeconds ?? 0} options={BAN_OPTIONS} onChange={v => onChange({ ...step, deleteSeconds: v })} />
                )}
                {step.type === "note" && (
                    <NativeSelect value={step.noteType ?? "note"} options={NOTE_TYPE_OPTIONS} onChange={v => onChange({ ...step, noteType: v })} />
                )}
                <span className={cl("grow")} />
                <Btn small variant="ghost" disabled={index === 0} onClick={() => onMove(index - 1)} title="Move up">↑</Btn>
                <Btn small variant="ghost" disabled={index === count - 1} onClick={() => onMove(index + 1)} title="Move down">↓</Btn>
                <Btn small variant="ghost" onClick={onRemove} title="Remove step">✕</Btn>
            </div>
            {step.type === "reply" && (
                <div className={cl("step-fields")}>
                    <DraftInput multiline value={step.text ?? ""} maxLength={1800} placeholder="Reply text - {user} = mention, {rule} = rule text" onCommit={v => onChange({ ...step, text: v })} />
                    <DraftInput value={step.rule ?? ""} maxLength={300} placeholder="Rule text for {rule}" onCommit={v => onChange({ ...step, rule: v })} />
                </div>
            )}
            {step.type === "note" && (
                <div className={cl("step-fields")}>
                    <DraftInput value={step.reason ?? ""} maxLength={400} placeholder="Custom note reason (empty = macro reason)" onCommit={v => onChange({ ...step, reason: v })} />
                </div>
            )}
        </div>
    );
}

function MacroCard({ macro, index, count, open, onToggle }: { macro: Macro; index: number; count: number; open: boolean; onToggle(): void; }) {
    const update = (fn: (m: Macro) => Macro) => updateMacro(macro.id, fn);
    const setSteps = (steps: Step[]) => update(m => ({ ...m, steps }));
    const [confirmDelete, setConfirmDelete] = useState(false);

    return (
        <div className={classes(cl("macro"), open && cl("macro-open"))}>
            <div className={cl("macro-head")} onClick={onToggle}>
                <span className={cl("macro-emoji")}>{macro.emoji || "⚙️"}</span>
                <span className={cl("grow")}>
                    <span className={cl("strong")}>{macro.name || "Unnamed"}</span>
                    <span className={cl("muted")}>{macro.steps.map(s => STEP_LABELS[s.type]).join(" → ") || "No steps"}</span>
                </span>
                {macro.confirm && <span className={cl("chip")}>Confirm</span>}
                <span className={classes(cl("chevron"), open && cl("chevron-open"))}>▾</span>
            </div>

            {open && (
                <div className={cl("macro-body")}>
                    <div className={cl("row")}>
                        <DraftInput className={cl("emoji-input")} value={macro.emoji} maxLength={8} placeholder="🔨" onCommit={v => update(m => ({ ...m, emoji: v.trim() }))} />
                        <DraftInput className={cl("grow")} value={macro.name} maxLength={40} placeholder="Name" onCommit={v => update(m => ({ ...m, name: v.trim() || m.name }))} />
                    </div>
                    <DraftInput value={macro.reason} maxLength={400} placeholder="Default reason (audit log & notes)" onCommit={v => update(m => ({ ...m, reason: v }))} />
                    <Toggle
                        checked={macro.confirm}
                        onChange={v => update(m => ({ ...m, confirm: v }))}
                        label="Confirm before running"
                        hint="Shows exactly what will happen. If permissions are missing for individual steps, it always asks first."
                    />

                    <div className={cl("steps-edit")}>
                        {macro.steps.map((step, i) => (
                            <StepEditor
                                key={step.id}
                                step={step}
                                index={i}
                                count={macro.steps.length}
                                onChange={s => setSteps(macro.steps.map((x, j) => j === i ? s : x))}
                                onMove={to => setSteps(move(macro.steps, i, to))}
                                onRemove={() => setSteps(macro.steps.filter((_, j) => j !== i))}
                            />
                        ))}
                    </div>

                    <div className={cl("row")}>
                        <span className={cl("label")}>Add step:</span>
                        {STEP_TYPES.map(t => (
                            <Btn key={t} small onClick={() => setSteps([...macro.steps, defaultStep(t)])}>+ {STEP_LABELS[t]}</Btn>
                        ))}
                    </div>

                    <div className={cl("row")}>
                        <Btn small variant="ghost" disabled={index === 0} onClick={() => saveMacros(move(getMacros(), index, index - 1))}>Move macro up</Btn>
                        <Btn small variant="ghost" disabled={index === count - 1} onClick={() => saveMacros(move(getMacros(), index, index + 1))}>Move macro down</Btn>
                        <span className={cl("grow")} />
                        <Btn small variant="danger" onClick={() => {
                            if (!confirmDelete) {
                                setConfirmDelete(true);
                                setTimeout(() => setConfirmDelete(false), 4000);
                                return;
                            }
                            saveMacros(getMacros().filter(m => m.id !== macro.id));
                        }}>
                            {confirmDelete ? "Really delete?" : "Delete macro"}
                        </Btn>
                    </div>
                </div>
            )}
        </div>
    );
}

function MacroEditor() {
    settings.use(["macros"]);
    const macros = getMacros();
    const [openId, setOpenId] = useState<string | null>(null);

    function addMacro() {
        const m: Macro = { id: uid(), name: "New macro", emoji: "⚙️", confirm: true, reason: "", steps: [defaultStep("delete")] };
        saveMacros([...macros, m]);
        setOpenId(m.id);
    }

    function restorePresets() {
        const have = new Set(macros.map(m => m.id));
        const missing = makePresets().filter(p => !have.has(p.id));
        if (!missing.length) return showToast("ModKit: All presets already exist", Toasts.Type.MESSAGE);
        saveMacros([...macros, ...missing]);
        showToast(`ModKit: ${plural(missing.length, "preset", "presets")} restored`, Toasts.Type.SUCCESS);
    }

    return (
        <>
            <div className={cl("list")}>
                {macros.map((m, i) => (
                    <MacroCard
                        key={m.id}
                        macro={m}
                        index={i}
                        count={macros.length}
                        open={openId === m.id}
                        onToggle={() => setOpenId(openId === m.id ? null : m.id)}
                    />
                ))}
            </div>
            <div className={cl("row")}>
                <Btn variant="primary" onClick={addMacro}>+ New macro</Btn>
                <Btn onClick={restorePresets}>Restore presets</Btn>
            </div>
            <div className={cl("muted")}>
                You can find macros by right-clicking a message under <b>ModKit</b> or via the hammer button on messages.
                All actions only run after your click. The scam quick action uses the "Scam link" macro.
            </div>
        </>
    );
}

// ---------------------------------------------------------------- Settings

function Section({ title, children }: { title: string; children: ReactNode; }) {
    return (
        <div className={cl("card")}>
            <div className={cl("card-title")}>{title}</div>
            {children}
        </div>
    );
}

export const SettingsPanel = ErrorBoundary.wrap(() => {
    const s = settings.use(["showBadgeChat", "showBadgeMemberList", "badgeMode", "showPopoverButton", "scamDetector"]);

    return (
        <div className={cl("settings")}>
            <div className={cl("header")}>
                <span className={cl("logo")}><ModKitIcon width={22} height={22} /></span>
                <span className={cl("header-text")}>
                    <span className={cl("title")}>ModKit</span>
                    <span className={cl("muted")}>ModNotes in your own mod channel, macros for routine actions, scam quick action.</span>
                </span>
            </div>

            <Section title="ModNotes channels">
                <ChannelList />
                <div className={cl("muted")}>
                    Each note is a message in this channel - readable by other mods even without the plugin.
                    Deleting a note = deleting that message.
                </div>
            </Section>

            <Section title="Macros">
                <MacroEditor />
            </Section>

            <Section title="Display">
                <Toggle checked={s.showBadgeChat} onChange={v => settings.store.showBadgeChat = v} label="Warning badge next to names in chat" />
                <Toggle checked={s.showBadgeMemberList} onChange={v => settings.store.showBadgeMemberList = v} label="Warning badge in the member list" />
                <div className={cl("option")}>
                    <span className={cl("option-text")}>
                        <span>Badge counts</span>
                        <span className={cl("muted")}>Violations = warnings, timeouts, kicks and bans</span>
                    </span>
                    <Segmented<BadgeMode>
                        value={s.badgeMode as BadgeMode}
                        onChange={v => settings.store.badgeMode = v}
                        options={[{ value: "warn", label: "Warnings" }, { value: "all", label: "All violations" }]}
                    />
                </div>
                <Toggle checked={s.showPopoverButton} onChange={v => settings.store.showPopoverButton = v} label="ModKit button on messages" hint="Appears when hovering a message if you have mod permissions." />
                <Toggle checked={s.scamDetector} onChange={v => settings.store.scamDetector = v} label="Flag possible scam links" hint="Discord/Steam lookalikes, free-Nitro bait, punycode. Only visible if you can delete and ban." />
            </Section>
        </div>
    );
}, { noop: true });
