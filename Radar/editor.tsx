/*
 * Radar – rule editor ("New rule" with presets, trigger and action selection)
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import ErrorBoundary from "@components/ErrorBoundary";
import { classes } from "@utils/misc";
import { RenderModalProps } from "@vencord/discord-types";
import { ChannelStore, GuildChannelStore, GuildStore, IconUtils, Modal, openModal, RelationshipStore, RunningGameStore, SelectedChannelStore, showToast, Toasts, UserStore, useState, VoiceStateStore } from "@webpack/common";
import type { ComponentType } from "react";

import { cl, Field, Icon, IconButton, MultiPicker, PickerOption, SectionTitle, Segmented, TagInput, ToggleRow } from "./components";
import { ACTIONS, avatarUrl, regexError, STATUS_OPTIONS, testRule, TRIGGERS, userName, WEEKDAYS } from "./engine";
import { playSound, SOUND_OPTIONS } from "./sounds";
import { ActionConfig, ActionType, DEFAULT_CONDITIONS, Rule, TriggerConfig, TriggerType, uid, upsertRule } from "./store";

// ---------------------------------------------------------------- Data sources for the pickers

function guildOptions(): PickerOption[] {
    return Object.values(GuildStore.getGuilds() ?? {})
        .map(g => ({ id: g.id, label: g.name, icon: IconUtils.getGuildIconURL({ id: g.id, icon: g.icon ?? undefined, size: 64 }) }))
        .sort((a, b) => a.label.localeCompare(b.label));
}

function resolveGuild(id: string): PickerOption {
    const g = GuildStore.getGuild(id);
    return g ? { id, label: g.name, icon: IconUtils.getGuildIconURL({ id, icon: g.icon ?? undefined, size: 64 }) } : { id, label: `Server ${id}` };
}

function channelOptions(): PickerOption[] {
    const out: PickerOption[] = [];
    for (const guild of Object.values(GuildStore.getGuilds() ?? {})) {
        const list = (GuildChannelStore.getChannels(guild.id)?.SELECTABLE ?? []) as any[];
        for (const item of list) {
            const ch = item?.channel;
            if (!ch?.id) continue;
            out.push({ id: ch.id, label: `#${ch.name}`, sub: guild.name });
        }
    }
    return out;
}

function resolveChannel(id: string): PickerOption {
    const ch = ChannelStore.getChannel(id);
    if (!ch) return { id, label: `Channel ${id}` };
    const guild = ch.guild_id ? GuildStore.getGuild(ch.guild_id) : null;
    return { id, label: `#${ch.name}`, sub: guild?.name };
}

function userOptions(): PickerOption[] {
    const ids = new Set<string>(RelationshipStore.getFriendIDs?.() ?? []);
    // Also offer people from the current voice channel
    const voice = SelectedChannelStore.getVoiceChannelId();
    if (voice) Object.keys(VoiceStateStore.getVoiceStatesForChannel(voice) ?? {}).forEach(id => ids.add(id));
    ids.delete(UserStore.getCurrentUser()?.id);

    return [...ids]
        .map(id => UserStore.getUser(id))
        .filter(Boolean)
        .map(u => ({ id: u.id, label: userName(u), sub: u.username, icon: avatarUrl(u) }))
        .sort((a, b) => a.label.localeCompare(b.label));
}

function resolveUser(id: string): PickerOption {
    const u = UserStore.getUser(id);
    return u ? { id, label: userName(u), sub: u.username, icon: avatarUrl(u) } : { id, label: `User ${id}` };
}

const GuildPicker = ({ value, onChange, placeholder }: { value: string[]; onChange(v: string[]): void; placeholder?: string; }) => (
    <MultiPicker value={value} onChange={onChange} options={guildOptions} resolve={resolveGuild} placeholder={placeholder ?? "Search servers…"} fallbackIcon="server" />
);

const ChannelPicker = ({ value, onChange }: { value: string[]; onChange(v: string[]): void; }) => (
    <MultiPicker value={value} onChange={onChange} options={channelOptions} resolve={resolveChannel} placeholder="Search channels or servers…" fallbackIcon="hash" />
);

const UserPicker = ({ value, onChange }: { value: string[]; onChange(v: string[]): void; }) => (
    <MultiPicker
        value={value}
        onChange={onChange}
        options={userOptions}
        resolve={resolveUser}
        placeholder="Search friends or paste a user ID…"
        fallbackIcon="user"
        allowIds
        emptyText="No friends found - you can also paste a user ID"
    />
);

// ---------------------------------------------------------------- Trigger editors

interface EditorProps<T> {
    value: T;
    patch(p: Partial<T>): void;
}

type TriggerEditor = ComponentType<EditorProps<TriggerConfig>>;
type ActionEditor = ComponentType<EditorProps<ActionConfig> & { trigger: TriggerConfig; }>;

const SCOPES = [
    { value: "all", label: "Everywhere" },
    { value: "guilds", label: "Servers" },
    { value: "channels", label: "Channels" },
    { value: "dms", label: "DMs" }
];

const KeywordEditor: TriggerEditor = ({ value, patch }) => {
    const scope = value.scope ?? { mode: "all", guildIds: [], channelIds: [] };
    const setScope = (p: any) => patch({ scope: { ...scope, ...p } });
    const error = value.useRegex ? regexError(value.regex ?? "") : null;

    return (
        <>
            <Segmented
                small
                value={value.useRegex ? "regex" : "words"}
                options={[{ value: "words", label: "Words" }, { value: "regex", label: "Regular expression" }]}
                onChange={v => patch({ useRegex: v === "regex" })}
            />
            {value.useRegex
                ? (
                    <Field label="Pattern" hint={error ? <span className={cl("text-bad")}>{error}</span> : "Example: (release|update)\\s+v?\\d+"}>
                        <input className={classes(cl("input"), error && cl("input-bad"))} value={value.regex ?? ""} placeholder="e.g. giveaway|raffle" onChange={e => patch({ regex: e.currentTarget.value })} />
                    </Field>
                )
                : (
                    <Field label="Words" hint="Enter or comma adds a word. Any one of them is enough.">
                        <TagInput value={value.words ?? []} onChange={words => patch({ words })} placeholder="e.g. giveaway, my name, Project X" />
                    </Field>
                )}
            <div className={cl("card")}>
                <ToggleRow checked={!value.caseSensitive} onChange={v => patch({ caseSensitive: !v })} label="Ignore upper/lower case" />
                <ToggleRow checked={!!value.wholeWord} onChange={v => patch({ wholeWord: v })} label="Whole words only" hint="“tea” then won’t match “teatime”" />
                <ToggleRow checked={!!value.ignoreSelf} onChange={v => patch({ ignoreSelf: v })} label="Ignore my own messages" />
            </div>
            <Field label="Where?">
                <Segmented small value={scope.mode} options={SCOPES} onChange={mode => setScope({ mode })} />
            </Field>
            {scope.mode === "guilds" && <GuildPicker value={scope.guildIds ?? []} onChange={guildIds => setScope({ guildIds })} />}
            {scope.mode === "channels" && <ChannelPicker value={scope.channelIds ?? []} onChange={channelIds => setScope({ channelIds })} />}
            <div className={cl("note")}>
                Also works in muted servers. However, Discord only sends your client messages from servers and channels it is currently
                subscribed to - in very large servers you haven't opened in a while, a match may therefore be missed.
            </div>
        </>
    );
};

const MentionEditor: TriggerEditor = ({ value, patch }) => (
    <>
        <Field label="Which servers?" hint="Leave empty = all servers">
            <GuildPicker value={value.guildIds ?? []} onChange={guildIds => patch({ guildIds })} placeholder="All servers - or search servers…" />
        </Field>
        <div className={cl("card")}>
            <ToggleRow checked={!!value.roles} onChange={v => patch({ roles: v })} label="Also mentions of my roles" />
            <ToggleRow checked={!!value.everyone} onChange={v => patch({ everyone: v })} label="Also @everyone and @here" />
        </div>
    </>
);

const VoiceEditor: TriggerEditor = ({ value, patch }) => (
    <>
        <Field label="Who?" hint={value.where === "mine" ? "Leave empty = anyone in your channel" : "Select at least one person"}>
            <UserPicker value={value.userIds ?? []} onChange={userIds => patch({ userIds })} />
        </Field>
        <Field label="Which channel?">
            <Segmented
                small
                value={value.where ?? "any"}
                options={[{ value: "any", label: "Any voice channel" }, { value: "mine", label: "My current channel" }]}
                onChange={where => patch({ where })}
            />
        </Field>
        <div className={cl("note")}>Discord only shows you voice activity in servers you share with the person.</div>
    </>
);

const GameEditor: TriggerEditor = ({ value, patch }) => {
    const games = (value.games ?? []) as string[];
    let running: string[] = [];
    try {
        running = RunningGameStore.getRunningGames().map(g => g.name).filter(n => n && !games.includes(n));
    } catch { }
    return (
        <>
            <Field label="Which games?" hint="Leave empty = any detected game. Part of the name is enough.">
                <TagInput value={games} onChange={g => patch({ games: g })} placeholder="e.g. Valorant, Minecraft" />
            </Field>
            {running.length > 0 && (
                <div className={cl("suggest")}>
                    <span className={cl("row-hint")}>Running now:</span>
                    {running.map(n => <button type="button" key={n} className={cl("suggest-chip")} onClick={() => patch({ games: [...games, n] })}>+ {n}</button>)}
                </div>
            )}
        </>
    );
};

const TimeEditor: TriggerEditor = ({ value, patch }) => {
    const days = (value.days ?? []) as number[];
    return (
        <>
            <div className={cl("field-row")}>
                <Field label="Time">
                    <input type="time" className={cl("input")} value={value.time ?? "20:00"} onChange={e => patch({ time: e.currentTarget.value || "20:00" })} />
                </Field>
                <Field label="Weekdays">
                    <div className={cl("days")}>
                        {[1, 2, 3, 4, 5, 6, 0].map(d => (
                            <button
                                type="button"
                                key={d}
                                className={classes(cl("day"), days.includes(d) && cl("day-on"))}
                                onClick={() => patch({ days: days.includes(d) ? days.filter(x => x !== d) : [...days, d] })}
                            >
                                {WEEKDAYS[d]}
                            </button>
                        ))}
                    </div>
                </Field>
            </div>
            <Field label="Notification text">
                <input className={cl("input")} value={value.note ?? ""} placeholder="e.g. Done for the day! Time for the raid" onChange={e => patch({ note: e.currentTarget.value })} />
            </Field>
        </>
    );
};

const GameStatusHint = () => <div className={cl("note")}>Tip: Together with the action “Set status → restore afterwards”, your old status is restored as soon as the game ends.</div>;

export const TRIGGER_EDITORS: Record<TriggerType, TriggerEditor> = {
    keyword: KeywordEditor,
    mention: MentionEditor,
    voiceJoin: VoiceEditor,
    voiceLeave: VoiceEditor,
    gameStart: props => <><GameEditor {...props} /><GameStatusHint /></>,
    gameStop: GameEditor,
    time: TimeEditor
};

// ---------------------------------------------------------------- Action editors

const HIGHLIGHT_COLORS = ["#f0b232", "#f23f43", "#23a55a", "#5865f2", "#00a8fc", "#eb459e"];

export const ACTION_EDITORS: Partial<Record<ActionType, ActionEditor>> = {
    notify: ({ value, patch }) => (
        <ToggleRow checked={!!value.permanent} onChange={v => patch({ permanent: v })} label="Stays until I click it" hint="Applies to Vencord's own notifications" />
    ),
    sound: ({ value, patch }) => (
        <div className={cl("action-body")}>
            <div className={cl("sounds")}>
                {SOUND_OPTIONS.map(o => (
                    <button
                        type="button"
                        key={o.value}
                        className={classes(cl("sound"), value.sound === o.value && cl("sound-on"))}
                        onClick={() => {
                            patch({ sound: o.value });
                            playSound(o.value, value.volume);
                        }}
                    >
                        <Icon name="play" size={12} />
                        {o.label}
                    </button>
                ))}
            </div>
            <div className={cl("range")}>
                <span className={cl("row-hint")}>Volume</span>
                <input type="range" min={5} max={100} step={5} value={value.volume ?? 60} onChange={e => patch({ volume: Number(e.currentTarget.value) })} onMouseUp={() => playSound(value.sound, value.volume)} />
                <span className={cl("range-value")}>{value.volume ?? 60}%</span>
            </div>
        </div>
    ),
    status: ({ value, patch, trigger }) => {
        const endable = !!TRIGGERS[trigger.type]?.testEnd;
        return (
            <div className={cl("action-body")}>
                <Segmented small value={value.status ?? "dnd"} options={STATUS_OPTIONS} onChange={status => patch({ status })} />
                <ToggleRow
                    checked={!!value.restore && endable}
                    disabled={!endable}
                    onChange={v => patch({ restore: v })}
                    label="Restore afterwards"
                    hint={endable ? "Previous status returns as soon as the trigger ends (e.g. game stopped)" : "Only possible for game rules"}
                />
            </div>
        );
    },
    highlight: ({ value, patch }) => (
        <div className={cl("colors")}>
            {HIGHLIGHT_COLORS.map(c => (
                <button type="button" key={c} aria-label={c} className={classes(cl("color"), value.color === c && cl("color-on"))} style={{ background: c }} onClick={() => patch({ color: c })} />
            ))}
            <input type="color" className={cl("color-input")} value={value.color ?? "#f0b232"} onChange={e => patch({ color: e.currentTarget.value })} />
        </div>
    )
};

// ---------------------------------------------------------------- Presets

function newRule(name: string, trigger: TriggerConfig, actions: ActionConfig[]): Rule {
    return { id: uid(), name, enabled: true, trigger, conditions: { ...DEFAULT_CONDITIONS }, actions, createdAt: Date.now() };
}

const act = (type: ActionType, extra: Record<string, any> = {}): ActionConfig => ({ ...ACTIONS[type].create(), ...extra });

interface Preset {
    id: string;
    label: string;
    hint: string;
    icon: "search" | "voiceIn" | "gamepad" | "at";
    build(): Rule;
}

const PRESETS: Preset[] = [
    {
        id: "keyword",
        label: "Keyword alert",
        hint: "Notification + sound + highlight when a word is said - even in muted servers",
        icon: "search",
        build: () => newRule("Keyword alert", TRIGGERS.keyword.create(), [act("notify"), act("sound", { sound: "ping" }), act("highlight"), act("inbox")])
    },
    {
        id: "friendVoice",
        label: "Friend joins voice",
        hint: "Get notified as soon as a specific person joins a voice channel",
        icon: "voiceIn",
        build: () => newRule("Friend joins voice", TRIGGERS.voiceJoin.create(), [act("notify"), act("sound", { sound: "chime" }), act("inbox")])
    },
    {
        id: "gameDnd",
        label: "While gaming: Do Not Disturb",
        hint: "Set status to “Do Not Disturb” when a game starts, then restore it afterwards",
        icon: "gamepad",
        build: () => newRule("While gaming: Do Not Disturb", TRIGGERS.gameStart.create(), [act("status", { status: "dnd", restore: true })])
    },
    {
        id: "mentionFlash",
        label: "Mention in server X → flash taskbar",
        hint: "If you are mentioned in certain servers, Discord flashes in the taskbar",
        icon: "at",
        build: () => newRule("Mention → taskbar", TRIGGERS.mention.create(), [act("flash"), act("notify"), act("inbox")])
    }
];

// ---------------------------------------------------------------- Validation

function validate(rule: Rule): string | null {
    if (!rule.name.trim()) return "Give the rule a name.";
    const t = rule.trigger;
    if (t.type === "keyword") {
        if (t.useRegex && (!t.regex?.trim() || regexError(t.regex))) return "The regular expression is empty or invalid.";
        if (!t.useRegex && !t.words?.length) return "Add at least one word.";
        if (t.scope?.mode === "guilds" && !t.scope.guildIds?.length) return "Select at least one server.";
        if (t.scope?.mode === "channels" && !t.scope.channelIds?.length) return "Select at least one channel.";
    }
    if ((t.type === "voiceJoin" || t.type === "voiceLeave") && t.where !== "mine" && !t.userIds?.length) return "Select at least one person (or “My current channel”).";
    if (t.type === "time" && !t.days?.length) return "Select at least one weekday.";
    if (!rule.actions.length) return "Add at least one action.";
    return null;
}

// ---------------------------------------------------------------- Editor

function PresetPicker({ onPick }: { onPick(rule: Rule): void; }) {
    return (
        <div className={cl("editor")}>
            <SectionTitle icon="flash">Presets</SectionTitle>
            <div className={cl("presets")}>
                {PRESETS.map(p => (
                    <button type="button" key={p.id} className={cl("preset")} onClick={() => onPick(p.build())}>
                        <span className={cl("preset-icon")}><Icon name={p.icon} size={20} /></span>
                        <span className={cl("preset-text")}>
                            <span className={cl("preset-title")}>{p.label}</span>
                            <span className={cl("row-hint")}>{p.hint}</span>
                        </span>
                    </button>
                ))}
            </div>
            <SectionTitle icon="rules">Or build your own - When …</SectionTitle>
            <div className={cl("trigger-grid")}>
                {Object.values(TRIGGERS).filter(t => !t.hidden).map(t => (
                    <button type="button" key={t.type} className={cl("trigger-tile")} title={t.hint} onClick={() => onPick(newRule(t.label, t.create(), [act("notify"), act("inbox")]))}>
                        <Icon name={t.icon} size={20} />
                        <span>{t.label}</span>
                    </button>
                ))}
            </div>
        </div>
    );
}

function RuleForm({ rule, setRule }: { rule: Rule; setRule(r: Rule): void; }) {
    const [showConditions, setShowConditions] = useState(() => {
        const c = rule.conditions ?? DEFAULT_CONDITIONS;
        return c.onlyUnfocused || c.skipWhenDnd || c.hoursEnabled;
    });
    const tDef = TRIGGERS[rule.trigger.type];
    const TEditor = TRIGGER_EDITORS[rule.trigger.type];
    const cond = { ...DEFAULT_CONDITIONS, ...rule.conditions };

    const patchTrigger = (p: Partial<TriggerConfig>) => setRule({ ...rule, trigger: { ...rule.trigger, ...p } });
    const patchCond = (p: Partial<typeof cond>) => setRule({ ...rule, conditions: { ...cond, ...p } });
    const patchAction = (i: number, p: Partial<ActionConfig>) => setRule({ ...rule, actions: rule.actions.map((a, j) => j === i ? { ...a, ...p } : a) });
    const changeTrigger = (type: TriggerType) => {
        if (type === rule.trigger.type) return;
        setRule({
            ...rule,
            trigger: TRIGGERS[type].create(),
            // Restoring only works for triggers that have an end
            actions: rule.actions.map(a => a.type === "status" && !TRIGGERS[type].testEnd ? { ...a, restore: false } : a)
        });
    };

    const missing = (Object.keys(ACTIONS) as ActionType[]).filter(t => !rule.actions.some(a => a.type === t));

    return (
        <div className={cl("editor")}>
            <Field label="Name">
                <input className={cl("input")} value={rule.name} maxLength={80} placeholder="Rule name" onChange={e => setRule({ ...rule, name: e.currentTarget.value })} />
            </Field>

            <SectionTitle icon="search">When …</SectionTitle>
            <div className={cl("trigger-grid")}>
                {Object.values(TRIGGERS).filter(t => !t.hidden).map(t => (
                    <button
                        type="button"
                        key={t.type}
                        title={t.hint}
                        className={classes(cl("trigger-tile"), t.type === rule.trigger.type && cl("trigger-tile-on"))}
                        onClick={() => changeTrigger(t.type)}
                    >
                        <Icon name={t.icon} size={18} />
                        <span>{t.label}</span>
                    </button>
                ))}
            </div>
            <div className={cl("row-hint")}>{tDef?.hint}</div>
            <div className={cl("stack")}>
                {TEditor && <TEditor value={rule.trigger} patch={patchTrigger} />}
            </div>

            <button type="button" className={cl("disclosure")} onClick={() => setShowConditions(v => !v)}>
                <span className={classes(cl("chev"), showConditions && cl("chev-open"))}>›</span>
                Conditions {cond.onlyUnfocused || cond.skipWhenDnd || cond.hoursEnabled ? "(active)" : "(optional)"}
            </button>
            {showConditions && (
                <div className={cl("card")}>
                    <ToggleRow checked={cond.onlyUnfocused} onChange={v => patchCond({ onlyUnfocused: v })} label="Only when Discord is in the background" />
                    <ToggleRow checked={cond.skipWhenDnd} onChange={v => patchCond({ skipWhenDnd: v })} label="Not while on “Do Not Disturb”" />
                    <ToggleRow checked={cond.hoursEnabled} onChange={v => patchCond({ hoursEnabled: v })} label="Only within a time window" />
                    {cond.hoursEnabled && (
                        <div className={cl("hours")}>
                            <span>from</span>
                            <input type="time" className={cl("input")} value={cond.hoursFrom} onChange={e => patchCond({ hoursFrom: e.currentTarget.value })} />
                            <span>to</span>
                            <input type="time" className={cl("input")} value={cond.hoursTo} onChange={e => patchCond({ hoursTo: e.currentTarget.value })} />
                        </div>
                    )}
                </div>
            )}

            <SectionTitle icon="flash">Then …</SectionTitle>
            <div className={cl("stack")}>
                {rule.actions.map((a, i) => {
                    const def = ACTIONS[a.type];
                    const AEditor = ACTION_EDITORS[a.type];
                    if (!def) return null;
                    return (
                        <div key={a.type + i} className={cl("action")}>
                            <div className={cl("action-head")}>
                                <span className={cl("action-icon")}><Icon name={def.icon} size={16} /></span>
                                <span className={cl("row-text")}>
                                    <span className={cl("row-label")}>{def.label}</span>
                                    <span className={cl("row-hint")}>{def.hint}</span>
                                </span>
                                <IconButton icon="trash" label="Remove action" danger onClick={() => setRule({ ...rule, actions: rule.actions.filter((_, j) => j !== i) })} />
                            </div>
                            {AEditor && <AEditor value={a} patch={p => patchAction(i, p)} trigger={rule.trigger} />}
                        </div>
                    );
                })}
            </div>
            {missing.length > 0 && (
                <div className={cl("add-actions")}>
                    {missing.map(t => (
                        <button type="button" key={t} className={cl("add-action")} title={ACTIONS[t].hint} onClick={() => setRule({ ...rule, actions: [...rule.actions, act(t)] })}>
                            <Icon name="plus" size={14} />
                            <Icon name={ACTIONS[t].icon} size={14} />
                            {ACTIONS[t].label}
                        </button>
                    ))}
                </div>
            )}
        </div>
    );
}

function RuleEditorModal({ modalProps, initial }: { modalProps: RenderModalProps; initial?: Rule; }) {
    const [rule, setRule] = useState<Rule | null>(initial ? structuredClone(initial) : null);
    const error = rule ? validate(rule) : null;

    const save = () => {
        if (!rule || error) return;
        upsertRule({ ...rule, name: rule.name.trim() });
        showToast(initial ? "Rule saved" : "Rule created", Toasts.Type.SUCCESS);
        modalProps.onClose();
    };

    return (
        <Modal
            {...modalProps}
            size="md"
            title={initial ? "Edit rule" : "New rule"}
            subtitle={rule ? "Everything runs locally on your side - Radar never sends messages." : "Choose a preset or a trigger."}
            notice={rule && error ? { message: error, type: "warning" } : undefined}
            actions={rule
                ? [
                    ...(!initial ? [{ text: "Back", variant: "secondary", onClick: () => setRule(null) }] : []),
                    { text: "Test", variant: "secondary", onClick: () => testRule(rule), disabled: !rule.actions.some(a => a.type !== "status") },
                    { text: "Save", variant: "primary", onClick: save, disabled: !!error }
                ]
                : [{ text: "Cancel", variant: "secondary", onClick: modalProps.onClose }]}
        >
            <ErrorBoundary>
                <div className={cl("modal-body")}>
                    {rule ? <RuleForm rule={rule} setRule={setRule} /> : <PresetPicker onPick={setRule} />}
                </div>
            </ErrorBoundary>
        </Modal>
    );
}

export function openRuleEditor(rule?: Rule) {
    openModal(props => <RuleEditorModal modalProps={props} initial={rule} />);
}

// ---------------------------------------------------------------- Small helpers for lists

export function TriggerBadge({ type }: { type: TriggerType; }) {
    const def = TRIGGERS[type];
    return (
        <span className={cl("trigger-badge")} title={def?.label}>
            <Icon name={def?.icon ?? "search"} size={16} />
        </span>
    );
}

