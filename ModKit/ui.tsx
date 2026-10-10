/*
 * ModKit – UI: ModNotes window, macro confirmation and quick pick, warning badges,
 * scam notice on messages, and settings (incl. macro editor)
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./ui.css";

import { classNameFactory } from "@api/Styles";
import ErrorBoundary from "@components/ErrorBoundary";
import { classes } from "@utils/misc";
import { ChannelStore, GuildMemberStore, GuildStore, NavigationRouter, PermissionsBits, PermissionStore, SelectedGuildStore, showToast, useEffect, useMemo, useRef, UserStore, useState, useStateFromStores } from "@webpack/common";

import { Badge, Button, confirm, Empty, Group, Icon, IconButton, ICONS, LinkRow, Note as UiNote, openWindow, Pill, Pills, Row, Section, Segmented, Select, Sheet, Spinner, TextArea, TextField, ToggleRow, UiColor, WindowAction } from "../_ui";
import { BadgeMode, settings, unsetNotesChannel } from "./index";
import { BAN_DELETE_OPTIONS, describeStep, getMacros, getScamMacro, hierarchyProblem, Macro, makePresets, messageLink, needsConfirm, RunHandle, runMacro, Step, STEP_LABELS, STEP_TYPES, stepProblem, StepStatus, StepType, Target, targetFromMessage, TIMEOUT_OPTIONS, uid } from "./macros";
import { cancelLoad, canDeleteNote, canWriteNotes, deleteNote, describeError, ensureLoaded, formatDuration, getCounts, getLoadState, getNotesChannelId, getNotesForUser, getVersion, Note, NOTE_EMOJI, NOTE_LABELS, NOTE_TYPES, NoteType, resync, subscribe, writeNote } from "./notes";
import { detectScam } from "./scam";

const cl = classNameFactory("vc-modkit-");

/** App icon color of ModKit */
const APP_COLOR: UiColor = "indigo";

// ---------------------------------------------------------------- Icons

const GAVEL_PATH = "M1 21h12v2H1v-2ZM5.245 8.07l2.83-2.827 14.14 14.142-2.828 2.828L5.245 8.07Zm7.072-7.07 5.657 5.656-2.83 2.83-5.654-5.66L12.317 1ZM3.825 9.485l5.657 5.657-2.828 2.828-5.657-5.657 2.828-2.828Z";
const WARN_PATH = "M1 21h22L12 2 1 21Zm12-3h-2v-2h2v2Zm0-4h-2v-4h2v4Z";
const UP_PATH = "M7.4 15.4 12 10.8l4.6 4.6L18 14l-6-6-6 6 1.4 1.4Z";
const DOWN_PATH = "M7.4 8.6 12 13.2l4.6-4.6L18 10l-6 6-6-6 1.4-1.4Z";

export function ModKitIcon({ height = 20, width = 20, className }: { height?: number | string; width?: number | string; className?: string; }) {
    return (
        <svg viewBox="0 0 24 24" width={width} height={height} className={className} aria-hidden>
            <path fill="currentColor" d={GAVEL_PATH} />
        </svg>
    );
}

const TYPE_COLOR: Record<NoteType, UiColor> = { note: "blue", warn: "yellow", timeout: "orange", kick: "pink", ban: "red", unban: "green" };

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

/** Input that only saves on blur (spares the settings file) */
function DraftInput({ value, onCommit, placeholder, multiline, maxLength, className }: {
    value: string; onCommit(v: string): void; placeholder?: string; multiline?: boolean; maxLength?: number; className?: string;
}) {
    const [v, setV] = useState(value);
    useEffect(() => setV(value), [value]);
    const blur = () => v !== value && onCommit(v);
    return multiline
        ? <TextArea rows={2} className={className} value={v} placeholder={placeholder} maxLength={maxLength} onChange={setV} onBlur={blur} />
        : <TextField type="text" className={className} value={v} placeholder={placeholder} maxLength={maxLength} onChange={setV} onBlur={blur} onKeyDown={e => e.key === "Enter" && e.currentTarget.blur()} />;
}

function TypeBadge({ type, children }: { type: NoteType; children: React.ReactNode; }) {
    return <Badge color={TYPE_COLOR[type]}>{children}</Badge>;
}

function Emoji({ children }: { children: React.ReactNode; }) {
    return <span className={cl("emoji")}>{children}</span>;
}

const DURATION_OPTIONS = TIMEOUT_OPTIONS.map(v => ({ value: v, label: formatDuration(v) }));
const BAN_OPTIONS = BAN_DELETE_OPTIONS.map(v => ({ value: v, label: v ? `Last ${formatDuration(v)}` : "Delete nothing" }));
const NOTE_TYPE_OPTIONS = NOTE_TYPES.map(t => ({ value: t as string, label: `${NOTE_EMOJI[t]} ${NOTE_LABELS[t]}` }));

// ---------------------------------------------------------------- Warning badges

function WarnBadge({ guildId, userId }: { guildId: string; userId: string; }) {
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
            <Icon path={WARN_PATH} size={10} />
            {n}
        </span>
    );
}

export const MessageBadge = ErrorBoundary.wrap(({ message, channel }: { message: any; channel: any; }) => {
    const { showBadgeChat } = settings.use(["showBadgeChat", "notesChannels"]);
    const guildId: string | undefined = channel?.guild_id;
    if (!showBadgeChat || !guildId || !message?.author?.id || !getNotesChannelId(guildId)) return null;
    return <WarnBadge guildId={guildId} userId={message.author.id} />;
}, { noop: true });

export const MemberListBadge = ErrorBoundary.wrap(({ userId }: { userId: string; }) => {
    const { showBadgeMemberList } = settings.use(["showBadgeMemberList", "notesChannels"]);
    const guildId = useStateFromStores([SelectedGuildStore], () => SelectedGuildStore.getGuildId());
    if (!showBadgeMemberList || !guildId || !getNotesChannelId(guildId)) return null;
    return <WarnBadge guildId={guildId} userId={userId} />;
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
            <span className={cl("scam-icon")}><Icon path={WARN_PATH} size={14} /></span>
            <span className={cl("scam-text")}>
                <b>Possible scam link</b>
                <span className={cl("scam-detail")}>{hit.host} - {hit.reason}</span>
            </span>
            <Button small variant="destructive" onClick={() => openMacroModal(getScamMacro(), targetFromMessage(message, channel))}>
                Delete + Ban
            </Button>
            <Button small variant="gray" title="Hide the notice for this message" onClick={() => {
                dismissed.add(message.id);
                setTick(t => t + 1);
            }}>
                Ignore
            </Button>
        </div>
    );
}, { noop: true });

// ---------------------------------------------------------------- ModNotes window

export function openNotesModal(guildId: string, userId: string, target?: Target) {
    openWindow(close => (
        <ErrorBoundary>
            <NotesModal onClose={close} guildId={guildId} userId={userId} target={target} />
        </ErrorBoundary>
    ));
}

function NotesModal({ onClose, guildId, userId, target }: { onClose(): void; guildId: string; userId: string; target?: Target; }) {
    useNotesVersion();
    useEffect(() => void ensureLoaded(guildId), [guildId]);

    const notes = getNotesForUser(guildId, userId);
    const guild = GuildStore.getGuild(guildId);

    return (
        <Sheet
            onClose={onClose}
            header={{
                title: `ModNotes - ${userName(guildId, userId)}`,
                subtitle: `${guild?.name ?? "Server"} · ID ${userId}`,
                icon: GAVEL_PATH,
                iconColor: APP_COLOR
            }}
            actions={[{ label: "Close", variant: "gray", onClick: onClose }]}
        >
            <LoadBanner guildId={guildId} />
            <Summary notes={notes} />
            <AddNoteForm guildId={guildId} userId={userId} target={target} />
            <Timeline guildId={guildId} notes={notes} onNavigate={onClose} />
        </Sheet>
    );
}

function LoadBanner({ guildId }: { guildId: string; }) {
    const state = getLoadState(guildId);
    if (!state || state.loaded) return null;

    if (state.loading) return (
        <Section>
            <Row
                leading={<Spinner />}
                title={`Loading ModNotes history ... ${state.progress ? `${state.progress} messages` : ""}`}
                trailing={<Button small variant="gray" onClick={() => cancelLoad(guildId)}>Cancel</Button>}
            />
        </Section>
    );

    return (
        <Section>
            <Row
                leading={<Icon path={WARN_PATH} size={16} className={state.error ? cl("red") : cl("orange")} />}
                title={state.error ? `Loading failed: ${state.error}` : "Loading cancelled - the list may be incomplete."}
                trailing={<Button small variant="gray" onClick={() => void ensureLoaded(guildId, true)}>Reload</Button>}
            />
        </Section>
    );
}

function Summary({ notes }: { notes: Note[]; }) {
    if (!notes.length) return null;
    const counts = NOTE_TYPES.map(t => [t, notes.filter(n => n.type === t).length] as const).filter(([, n]) => n);
    return (
        <Pills>
            {counts.map(([t, n]) => <TypeBadge key={t} type={t}>{NOTE_EMOJI[t]} {n}× {NOTE_LABELS[t]}</TypeBadge>)}
        </Pills>
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
            showToast("ModKit: Note saved", "success");
        } catch (e) {
            showToast(`ModKit: Could not save note - ${describeError(e)}`, "failure");
        } finally {
            setSaving(false);
        }
    }

    return (
        <Section title="Add note" footer="Saved as a message in the ModNotes channel.">
            <div className={cl("form")}>
                {problem && <UiNote tone="warn">{problem}</UiNote>}
                <Pills>
                    {NOTE_TYPES.map(t => (
                        <Pill key={t} selected={type === t} onClick={problem ? undefined : () => setType(t)}>{NOTE_EMOJI[t]} {NOTE_LABELS[t]}</Pill>
                    ))}
                </Pills>
                {type === "timeout" && (
                    <div className={cl("inline")}>
                        <span className={cl("label")}>Duration</span>
                        <Select<number> value={duration} options={DURATION_OPTIONS} onChange={setDuration} />
                        <span className={cl("dim")}>Record only - does not apply a timeout.</span>
                    </div>
                )}
                <TextArea
                    rows={3}
                    maxLength={900}
                    placeholder="Reason / description"
                    value={reason}
                    disabled={!!problem}
                    onChange={setReason}
                />
                <TextField
                    type="text"
                    className={refInvalid ? cl("invalid") : undefined}
                    placeholder="Message link as evidence (optional)"
                    value={ref}
                    disabled={!!problem}
                    onChange={setRef}
                />
                {refInvalid && <div className={cl("dim")}>Discord message links only (https://discord.com/channels/...)</div>}
                <div className={cl("inline")}>
                    <span className={cl("grow")} />
                    <Button disabled={disabled} onClick={save}>{saving ? "Saving ..." : "Save"}</Button>
                </div>
            </div>
        </Section>
    );
}

function Timeline({ guildId, notes, onNavigate }: { guildId: string; notes: Note[]; onNavigate(): void; }) {
    if (!notes.length) return <Empty icon={GAVEL_PATH} title="No entries for this person yet." />;
    return (
        <Section title="History">
            {notes.map(n => <NoteItem key={n.id} note={n} guildId={guildId} onNavigate={onNavigate} />)}
        </Section>
    );
}

function NoteItem({ note, guildId, onNavigate }: { note: Note; guildId: string; onNavigate(): void; }) {
    const [busy, setBusy] = useState(false);

    async function remove() {
        if (!await confirm({ title: "Delete note?", body: "Deletes the message in the ModNotes channel.", confirmText: "Delete", destructive: true })) return;
        setBusy(true);
        try {
            await deleteNote(note);
            showToast("ModKit: Note deleted", "success");
        } catch (e) {
            showToast(`ModKit: Could not delete note - ${describeError(e)}`, "failure");
            setBusy(false);
        }
    }

    return (
        <Row
            align="top"
            className={cl("note")}
            leading={<span className={cl("note-bar")} style={{ background: `var(--vc-ui-${TYPE_COLOR[note.type]})` }} />}
            title={<span className={cl("inline")}>
                <TypeBadge type={note.type}>
                    {NOTE_EMOJI[note.type]} {NOTE_LABELS[note.type]}{note.duration ? ` · ${formatDuration(note.duration)}` : ""}
                </TypeBadge>
                <span className={cl("dim")}>by {userName(guildId, note.authorId)} · {formatDate(note.timestamp)}</span>
            </span>}
            trailing={canDeleteNote(note) && (
                <IconButton icon={ICONS.trash} destructive disabled={busy} label="Delete (deletes the message in the ModNotes channel)" onClick={remove} />
            )}
        >
            <div className={cl("note-reason")}>{note.reason || <i className={cl("dim")}>no reason given</i>}</div>
            {note.excerpt && <div className={cl("excerpt")}>{note.excerpt}</div>}
            <div className={cl("inline")}>
                {note.ref && LINK_RE.test(note.ref) && (
                    <Button small variant="plain" onClick={() => openDiscordLink(note.ref!, onNavigate)}>↪ Go to message</Button>
                )}
                <Button small variant="plain" onClick={() => openDiscordLink(`https://discord.com/channels/${guildId}/${note.channelId}/${note.id}`, onNavigate)}>
                    In ModNotes channel
                </Button>
            </div>
        </Row>
    );
}

// ---------------------------------------------------------------- Run macro

export function runOrConfirm(macro: Macro, target: Target) {
    if (needsConfirm(macro, target)) openMacroModal(macro, target);
    else void runMacro(macro, target, macro.reason);
}

export function openMacroModal(macro: Macro, target: Target) {
    openWindow(close => (
        <ErrorBoundary>
            <MacroModal onClose={close} macro={macro} target={target} />
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

function MacroModal({ onClose, macro, target }: { onClose(): void; macro: Macro; target: Target; }) {
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
        if (!res.failed && !handle.current.cancelled) setTimeout(onClose, 700);
    }

    const actions: WindowAction[] = phase === "idle"
        ? [
            { label: "Cancel", onClick: onClose },
            { label: "Run", variant: "destructive", disabled: !runnable, onClick: run }
        ]
        : phase === "running"
            ? [{ label: "Stop", variant: "gray", onClick: () => void (handle.current.cancelled = true) }]
            : [{ label: "Close", variant: "gray", onClick: onClose }];

    return (
        <Sheet
            onClose={onClose}
            header={{
                title: `${macro.emoji} Run ${macro.name}?`,
                subtitle: `Target: ${userName(target.guildId, target.userId)} (${target.userId})`,
                icon: GAVEL_PATH,
                iconColor: APP_COLOR
            }}
            notice={hierarchy ? `${hierarchy} Timeout, kick and ban will be skipped.` : undefined}
            actions={actions}
        >
            {target.excerpt && <div className={cl("excerpt")}>{target.excerpt}</div>}

            <Section title="What will happen">
                {macro.steps.map((step, i) => {
                    const st = status[i];
                    const blocked = problems[i];
                    const state = phase === "idle" ? (blocked ? "skipped" : "pending") : st.s;
                    return (
                        <Row
                            key={step.id}
                            leading={<span className={classes(cl("step-icon"), cl(`step-${state}`))}>{STATUS_ICON[state]}</span>}
                            title={<span className={blocked ? cl("strike") : undefined}>{describeStep(step)}</span>}
                            subtitle={(blocked || st.info) ? st.info ?? `Will be skipped: ${blocked}` : undefined}
                            dim={state === "skipped"}
                        />
                    );
                })}
                {!macro.steps.length && <Row title="This macro has no steps." dim />}
            </Section>

            <Section title="Reason (audit log & note)">
                <div className={cl("form")}>
                    <TextField
                        type="text"
                        maxLength={400}
                        value={reason}
                        disabled={phase !== "idle"}
                        placeholder={macro.name}
                        onChange={setReason}
                    />
                </div>
            </Section>
        </Sheet>
    );
}

// ---------------------------------------------------------------- Quick pick (message button)

export function openQuickPick(message: any, channel: any) {
    const target = targetFromMessage(message, channel);
    openWindow(close => (
        <ErrorBoundary>
            <QuickPick onClose={close} target={target} />
        </ErrorBoundary>
    ), { size: "small" });
}

function QuickPick({ onClose, target }: { onClose(): void; target: Target; }) {
    useNotesVersion();
    const hasNotes = !!getNotesChannelId(target.guildId);
    useEffect(() => void (hasNotes && ensureLoaded(target.guildId)), [target.guildId]);
    const macros = getMacros();

    return (
        <Sheet
            onClose={onClose}
            header={{ title: "ModKit", subtitle: `Target: ${userName(target.guildId, target.userId)}`, icon: GAVEL_PATH, iconColor: APP_COLOR }}
            actions={[{ label: "Close", variant: "gray", onClick: onClose }]}
        >
            {macros.length > 0
                ? (
                    <Section title="Macros">
                        {macros.map(m => {
                            const problems = m.steps.map(s => stepProblem(s, target));
                            const blocked = !m.steps.length || problems.every(Boolean);
                            return (
                                <div key={m.id} title={blocked ? problems.find(Boolean) ?? "No steps" : undefined}>
                                    <Row
                                        leading={<Emoji>{m.emoji}</Emoji>}
                                        title={<span className={cl("inline")}>{m.name}{m.confirm && <Badge color="orange">Confirm</Badge>}</span>}
                                        subtitle={m.steps.map(s => STEP_LABELS[s.type]).join(" → ") || "No steps"}
                                        dim={blocked}
                                        chevron={!blocked}
                                        onClick={blocked ? undefined : () => {
                                            onClose();
                                            runOrConfirm(m, target);
                                        }}
                                    />
                                </div>
                            );
                        })}
                    </Section>
                )
                : <Empty icon={GAVEL_PATH} title="No macros - create some in the plugin settings." />}
            {hasNotes && (
                <Section>
                    <Row
                        leading={<Emoji>📝</Emoji>}
                        title={`ModNotes (${getNotesForUser(target.guildId, target.userId).length})`}
                        subtitle="View history & add note"
                        chevron
                        onClick={() => {
                            onClose();
                            openNotesModal(target.guildId, target.userId, target);
                        }}
                    />
                </Section>
            )}
        </Sheet>
    );
}

// ---------------------------------------------------------------- Settings: ModNotes channels

function ChannelList() {
    useNotesVersion();
    const { notesChannels } = settings.use(["notesChannels"]);
    const entries = Object.entries(notesChannels ?? {});

    if (!entries.length) return (
        <Row dim title={<>No ModNotes channel yet. Right-click a private mod channel → <b>"Set as ModNotes channel"</b>.</>} />
    );

    return (
        <>
            {entries.map(([guildId, channelId]) => {
                const guild = GuildStore.getGuild(guildId);
                const channel = ChannelStore.getChannel(channelId);
                const state = getLoadState(guildId);
                const status = !state ? "" :
                    state.loading ? `loading ... ${state.progress} messages` :
                        state.error ? `Error: ${state.error}` :
                            state.loaded ? plural(state.count, "note", "notes") : "not loaded yet";
                return (
                    <Row
                        key={guildId}
                        title={guild?.name ?? `Server ${guildId}`}
                        subtitle={`#${channel?.name ?? "unknown channel"} · ${status}`}
                        trailing={<>
                            {state?.loading
                                ? <Button small variant="gray" onClick={() => cancelLoad(guildId)}>Cancel</Button>
                                : state?.loaded
                                    ? <Button small variant="gray" onClick={() => void resync(guildId)} title="Discard cache and reload everything">Resync</Button>
                                    : <Button small variant="gray" onClick={() => void ensureLoaded(guildId, true)}>Load</Button>}
                            <Button small variant="destructive" onClick={() => unsetNotesChannel(guildId)}>Remove</Button>
                        </>}
                    />
                );
            })}
        </>
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
            <div className={cl("inline")}>
                <span className={cl("step-num")}>{index + 1}</span>
                <Select<string>
                    value={step.type}
                    options={STEP_TYPES.map(t => ({ value: t as string, label: STEP_LABELS[t] }))}
                    onChange={t => onChange(defaultStep(t as StepType))}
                />
                {step.type === "timeout" && (
                    <Select<number> value={step.duration ?? 3600} options={DURATION_OPTIONS} onChange={v => onChange({ ...step, duration: v })} />
                )}
                {step.type === "ban" && (
                    <Select<number> value={step.deleteSeconds ?? 0} options={BAN_OPTIONS} onChange={v => onChange({ ...step, deleteSeconds: v })} />
                )}
                {step.type === "note" && (
                    <Select<string> value={step.noteType ?? "note"} options={NOTE_TYPE_OPTIONS} onChange={v => onChange({ ...step, noteType: v as NoteType })} />
                )}
                <span className={cl("grow")} />
                <IconButton icon={UP_PATH} label="Move up" disabled={index === 0} onClick={() => onMove(index - 1)} />
                <IconButton icon={DOWN_PATH} label="Move down" disabled={index === count - 1} onClick={() => onMove(index + 1)} />
                <IconButton icon={ICONS.close} label="Remove step" destructive onClick={onRemove} />
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

    async function remove() {
        if (await confirm({ title: `Delete ${macro.name || "macro"}?`, confirmText: "Delete macro", destructive: true }))
            saveMacros(getMacros().filter(m => m.id !== macro.id));
    }

    return (
        <Group className={open ? cl("macro-open") : undefined}>
            <Row
                leading={<Emoji>{macro.emoji || "⚙️"}</Emoji>}
                title={macro.name || "Unnamed"}
                subtitle={macro.steps.map(s => STEP_LABELS[s.type]).join(" → ") || "No steps"}
                trailing={<>
                    {macro.confirm && <Badge color="orange">Confirm</Badge>}
                    <Icon path={ICONS.chevron} size={14} className={classes(cl("chevron"), open && cl("chevron-open"))} />
                </>}
                onClick={onToggle}
            />

            {open && (
                <div className={cl("macro-body")}>
                    <div className={cl("inline")}>
                        <DraftInput className={cl("emoji-input")} value={macro.emoji} maxLength={8} placeholder="🔨" onCommit={v => update(m => ({ ...m, emoji: v.trim() }))} />
                        <DraftInput className={cl("grow")} value={macro.name} maxLength={40} placeholder="Name" onCommit={v => update(m => ({ ...m, name: v.trim() || m.name }))} />
                    </div>
                    <DraftInput value={macro.reason} maxLength={400} placeholder="Default reason (audit log & notes)" onCommit={v => update(m => ({ ...m, reason: v }))} />
                    <Group>
                        <ToggleRow
                            checked={macro.confirm}
                            onChange={v => update(m => ({ ...m, confirm: v }))}
                            title="Confirm before running"
                            subtitle="Shows exactly what will happen. If permissions are missing for individual steps, it always asks first."
                        />
                    </Group>

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

                    <div className={cl("inline")}>
                        <span className={cl("label")}>Add step:</span>
                        <Pills>
                            {STEP_TYPES.map(t => (
                                <Pill key={t} icon={ICONS.plus} onClick={() => setSteps([...macro.steps, defaultStep(t)])}>{STEP_LABELS[t]}</Pill>
                            ))}
                        </Pills>
                    </div>

                    <div className={cl("inline")}>
                        <Button small variant="plain" disabled={index === 0} onClick={() => saveMacros(move(getMacros(), index, index - 1))}>Move macro up</Button>
                        <Button small variant="plain" disabled={index === count - 1} onClick={() => saveMacros(move(getMacros(), index, index + 1))}>Move macro down</Button>
                        <span className={cl("grow")} />
                        <Button small variant="destructive" onClick={remove}>Delete macro</Button>
                    </div>
                </div>
            )}
        </Group>
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
        if (!missing.length) return showToast("ModKit: All presets already exist", "message");
        saveMacros([...macros, ...missing]);
        showToast(`ModKit: ${plural(missing.length, "preset", "presets")} restored`, "success");
    }

    return (
        <Section
            plain
            title="Macros"
            footer={<>
                You can find macros by right-clicking a message under <b>ModKit</b> or via the hammer button on messages.
                All actions only run after your click. The scam quick action uses the "Scam link" macro.
            </>}
        >
            <div className={cl("macros")}>
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
                <Group>
                    <LinkRow icon={ICONS.plus} onClick={addMacro}>New macro</LinkRow>
                    <LinkRow icon={ICONS.refresh} onClick={restorePresets}>Restore presets</LinkRow>
                </Group>
            </div>
        </Section>
    );
}

// ---------------------------------------------------------------- Settings

export const SettingsPanel = ErrorBoundary.wrap(() => {
    const s = settings.use(["showBadgeChat", "showBadgeMemberList", "badgeMode", "showPopoverButton", "scamDetector"]);

    return (
        <Sheet
            embedded
            header={{
                title: "ModKit",
                subtitle: "ModNotes in your own mod channel, macros for routine actions, scam quick action.",
                icon: GAVEL_PATH,
                iconColor: APP_COLOR
            }}
        >
            <Section
                title="ModNotes channels"
                footer="Each note is a message in this channel - readable by other mods even without the plugin. Deleting a note = deleting that message."
            >
                <ChannelList />
            </Section>

            <MacroEditor />

            <Section title="Display">
                <ToggleRow icon={WARN_PATH} color="yellow" checked={s.showBadgeChat} onChange={v => settings.store.showBadgeChat = v} title="Warning badge next to names in chat" />
                <ToggleRow icon={WARN_PATH} color="orange" checked={s.showBadgeMemberList} onChange={v => settings.store.showBadgeMemberList = v} title="Warning badge in the member list" />
                <Row
                    title="Badge counts"
                    subtitle="Violations = warnings, timeouts, kicks and bans"
                    trailing={
                        <Segmented<BadgeMode>
                            small
                            value={s.badgeMode as BadgeMode}
                            onChange={v => settings.store.badgeMode = v}
                            options={[{ value: "warn", label: "Warnings" }, { value: "all", label: "All violations" }]}
                        />
                    }
                />
                <ToggleRow icon={GAVEL_PATH} color={APP_COLOR} checked={s.showPopoverButton} onChange={v => settings.store.showPopoverButton = v} title="ModKit button on messages" subtitle="Appears when hovering a message if you have mod permissions." />
                <ToggleRow icon={ICONS.warning} color="red" checked={s.scamDetector} onChange={v => settings.store.scamDetector = v} title="Flag possible scam links" subtitle="Discord/Steam lookalikes, free-Nitro bait, punycode. Only visible if you can delete and ban." />
            </Section>
        </Sheet>
    );
}, { noop: true });
