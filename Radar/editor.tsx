/*
 * Radar – rule editor ("New rule" with presets, trigger and action selection)
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { classes } from "@utils/misc";
import { ChannelStore, GuildChannelStore, GuildStore, IconUtils, RelationshipStore, RunningGameStore, SelectedChannelStore, showToast, UserStore, useState, VoiceStateStore } from "@webpack/common";
import type { ComponentType, ReactNode } from "react";

import { Button, Field, Glyph, Group, IconButton, ICONS, Note, openWindow, Pill, Pills, Row, Section, Segmented, Sheet, Slider, TextField, ToggleRow, UiColor } from "../_ui";
import { ACTION_COLOR, cl, MultiPicker, PickerOption, RadarIcon, RI, TagInput, TRIGGER_COLOR } from "./components";
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
    <MultiPicker value={value} onChange={onChange} options={guildOptions} resolve={resolveGuild} placeholder={placeholder ?? "Search servers…"} fallbackIcon={RI.server} />
);

const ChannelPicker = ({ value, onChange }: { value: string[]; onChange(v: string[]): void; }) => (
    <MultiPicker value={value} onChange={onChange} options={channelOptions} resolve={resolveChannel} placeholder="Search channels or servers…" fallbackIcon={RI.hash} />
);

const UserPicker = ({ value, onChange }: { value: string[]; onChange(v: string[]): void; }) => (
    <MultiPicker
        value={value}
        onChange={onChange}
        options={userOptions}
        resolve={resolveUser}
        placeholder="Search friends or paste a user ID…"
        fallbackIcon={ICONS.user}
        allowIds
        emptyText="No friends found - you can also paste a user ID"
    />
);

// ---------------------------------------------------------------- Small parts

/** Colored square for a trigger type, used in lists and the editor */
export function TriggerGlyph({ type, size }: { type: TriggerType; size?: number; }) {
    return <Glyph path={RI[TRIGGERS[type]?.icon ?? "search"]} color={TRIGGER_COLOR[type] ?? "gray"} size={size} />;
}

function Stack({ children }: { children: ReactNode; }) {
    return <div className={cl("stack")}>{children}</div>;
}

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
                        <TextField className={classes(cl("mono"), error && cl("field-bad"))} value={value.regex ?? ""} placeholder="e.g. giveaway|raffle" onChange={regex => patch({ regex })} />
                    </Field>
                )
                : (
                    <Field label="Words" hint="Enter or comma adds a word. Any one of them is enough.">
                        <TagInput value={value.words ?? []} onChange={words => patch({ words })} placeholder="e.g. giveaway, my name, Project X" />
                    </Field>
                )}
            <Section>
                <ToggleRow checked={!value.caseSensitive} onChange={v => patch({ caseSensitive: !v })} title="Ignore upper/lower case" />
                <ToggleRow checked={!!value.wholeWord} onChange={v => patch({ wholeWord: v })} title="Whole words only" subtitle="“tea” then won’t match “teatime”" />
                <ToggleRow checked={!!value.ignoreSelf} onChange={v => patch({ ignoreSelf: v })} title="Ignore my own messages" />
            </Section>
            <Field label="Where?">
                <Segmented small value={scope.mode} options={SCOPES} onChange={mode => setScope({ mode })} />
            </Field>
            {scope.mode === "guilds" && <GuildPicker value={scope.guildIds ?? []} onChange={guildIds => setScope({ guildIds })} />}
            {scope.mode === "channels" && <ChannelPicker value={scope.channelIds ?? []} onChange={channelIds => setScope({ channelIds })} />}
            <Note>
                Also works in muted servers. However, Discord only sends your client messages from servers and channels it is currently
                subscribed to - in very large servers you haven't opened in a while, a match may therefore be missed.
            </Note>
        </>
    );
};

const MentionEditor: TriggerEditor = ({ value, patch }) => (
    <>
        <Field label="Which servers?" hint="Leave empty = all servers">
            <GuildPicker value={value.guildIds ?? []} onChange={guildIds => patch({ guildIds })} placeholder="All servers - or search servers…" />
        </Field>
        <Section>
            <ToggleRow checked={!!value.roles} onChange={v => patch({ roles: v })} title="Also mentions of my roles" />
            <ToggleRow checked={!!value.everyone} onChange={v => patch({ everyone: v })} title="Also @everyone and @here" />
        </Section>
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
        <Note>Discord only shows you voice activity in servers you share with the person.</Note>
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
                <div className={cl("inline")}>
                    <span className={cl("dim")}>Running now:</span>
                    <Pills>
                        {running.map(n => <Pill key={n} icon={ICONS.plus} onClick={() => patch({ games: [...games, n] })}>{n}</Pill>)}
                    </Pills>
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
                    <TextField type="time" className={cl("time-input")} value={value.time ?? "20:00"} onChange={time => patch({ time: time || "20:00" })} />
                </Field>
                <Field label="Weekdays">
                    <Pills>
                        {[1, 2, 3, 4, 5, 6, 0].map(d => (
                            <Pill key={d} selected={days.includes(d)} onClick={() => patch({ days: days.includes(d) ? days.filter(x => x !== d) : [...days, d] })}>
                                {WEEKDAYS[d]}
                            </Pill>
                        ))}
                    </Pills>
                </Field>
            </div>
            <Field label="Notification text">
                <TextField value={value.note ?? ""} placeholder="e.g. Done for the day! Time for the raid" onChange={note => patch({ note })} />
            </Field>
        </>
    );
};

const GameStatusHint = () => <Note>Tip: Together with the action “Set status → restore afterwards”, your old status is restored as soon as the game ends.</Note>;

export const TRIGGER_EDITORS: Record<TriggerType, TriggerEditor> = {
    keyword: KeywordEditor,
    mention: MentionEditor,
    voiceJoin: VoiceEditor,
    voiceLeave: VoiceEditor,
    gameStart: props => <><GameEditor {...props} /><GameStatusHint /></>,
    gameStop: GameEditor,
    time: TimeEditor
};

// ---------------------------------------------------------------- Action editors (rendered inside the action's group)

/** User-picked highlight colors are rule data (hex), not UI colors */
const HIGHLIGHT_COLORS = ["#f0b232", "#f23f43", "#23a55a", "#5865f2", "#00a8fc", "#eb459e"];

export const ACTION_EDITORS: Partial<Record<ActionType, ActionEditor>> = {
    notify: ({ value, patch }) => (
        <ToggleRow checked={!!value.permanent} onChange={v => patch({ permanent: v })} title="Stays until I click it" subtitle="Applies to Vencord's own notifications" />
    ),
    sound: ({ value, patch }) => (
        <div className={cl("action-body")}>
            <Pills>
                {SOUND_OPTIONS.map(o => (
                    <Pill
                        key={o.value}
                        icon={ICONS.play}
                        selected={value.sound === o.value}
                        onClick={() => {
                            patch({ sound: o.value });
                            playSound(o.value, value.volume);
                        }}
                    >
                        {o.label}
                    </Pill>
                ))}
            </Pills>
            {/* Preview when the slider is let go */}
            <div className={cl("inline")} onMouseUp={() => playSound(value.sound, value.volume)}>
                <span className={cl("dim")}>Volume</span>
                <Slider value={value.volume ?? 60} min={5} max={100} step={5} format={v => `${v}%`} onChange={volume => patch({ volume })} />
            </div>
        </div>
    ),
    status: ({ value, patch, trigger }) => {
        const endable = !!TRIGGERS[trigger.type]?.testEnd;
        return (
            <>
                <div className={cl("action-body")}>
                    <Segmented small value={value.status ?? "dnd"} options={STATUS_OPTIONS} onChange={status => patch({ status })} />
                </div>
                <ToggleRow
                    checked={!!value.restore && endable}
                    disabled={!endable}
                    onChange={v => patch({ restore: v })}
                    title="Restore afterwards"
                    subtitle={endable ? "Previous status returns as soon as the trigger ends (e.g. game stopped)" : "Only possible for game rules"}
                />
            </>
        );
    },
    highlight: ({ value, patch }) => (
        <div className={classes(cl("action-body"), cl("wrap"))}>
            {HIGHLIGHT_COLORS.map(c => (
                <button type="button" key={c} aria-label={c} aria-pressed={value.color === c} className={classes(cl("swatch"), value.color === c && cl("swatch-on"))} style={{ background: c }} onClick={() => patch({ color: c })} />
            ))}
            <input type="color" className={cl("swatch-input")} title="Own color" value={value.color ?? "#f0b232"} onChange={e => patch({ color: e.currentTarget.value })} />
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
    icon: RadarIcon;
    color: UiColor;
    build(): Rule;
}

const PRESETS: Preset[] = [
    {
        id: "keyword",
        label: "Keyword alert",
        hint: "Notification + sound + highlight when a word is said - even in muted servers",
        icon: "search",
        color: TRIGGER_COLOR.keyword,
        build: () => newRule("Keyword alert", TRIGGERS.keyword.create(), [act("notify"), act("sound", { sound: "ping" }), act("highlight"), act("inbox")])
    },
    {
        id: "friendVoice",
        label: "Friend joins voice",
        hint: "Get notified as soon as a specific person joins a voice channel",
        icon: "voiceIn",
        color: TRIGGER_COLOR.voiceJoin,
        build: () => newRule("Friend joins voice", TRIGGERS.voiceJoin.create(), [act("notify"), act("sound", { sound: "chime" }), act("inbox")])
    },
    {
        id: "gameDnd",
        label: "While gaming: Do Not Disturb",
        hint: "Set status to “Do Not Disturb” when a game starts, then restore it afterwards",
        icon: "gamepad",
        color: TRIGGER_COLOR.gameStart,
        build: () => newRule("While gaming: Do Not Disturb", TRIGGERS.gameStart.create(), [act("status", { status: "dnd", restore: true })])
    },
    {
        id: "mentionFlash",
        label: "Mention in server X → flash taskbar",
        hint: "If you are mentioned in certain servers, Discord flashes in the taskbar",
        icon: "at",
        color: TRIGGER_COLOR.mention,
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

function TriggerTiles({ selected, onPick }: { selected?: TriggerType; onPick(type: TriggerType): void; }) {
    return (
        <div className={cl("tiles")}>
            {Object.values(TRIGGERS).filter(t => !t.hidden).map(t => (
                <button
                    type="button"
                    key={t.type}
                    title={t.hint}
                    aria-pressed={t.type === selected}
                    className={classes(cl("tile"), t.type === selected && cl("tile-on"))}
                    onClick={() => onPick(t.type)}
                >
                    <TriggerGlyph type={t.type} size={30} />
                    <span>{t.label}</span>
                </button>
            ))}
        </div>
    );
}

function PresetPicker({ onPick }: { onPick(rule: Rule): void; }) {
    return (
        <>
            <Section title="Presets">
                {PRESETS.map(p => (
                    <Row key={p.id} leading={<Glyph path={RI[p.icon]} color={p.color} />} title={p.label} subtitle={p.hint} chevron onClick={() => onPick(p.build())} />
                ))}
            </Section>
            <Section title="Or build your own - When …" plain>
                <TriggerTiles onPick={type => onPick(newRule(TRIGGERS[type].label, TRIGGERS[type].create(), [act("notify"), act("inbox")]))} />
            </Section>
        </>
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
    const condActive = cond.onlyUnfocused || cond.skipWhenDnd || cond.hoursEnabled;

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
        <>
            <Field label="Name">
                <TextField value={rule.name} maxLength={80} placeholder="Rule name" onChange={name => setRule({ ...rule, name })} />
            </Field>

            <Section title="When …" footer={tDef?.hint} plain>
                <TriggerTiles selected={rule.trigger.type} onPick={changeTrigger} />
            </Section>
            {TEditor && <Stack><TEditor value={rule.trigger} patch={patchTrigger} /></Stack>}

            <Section
                title={`Conditions ${condActive ? "(active)" : "(optional)"}`}
                right={showConditions && <Button small variant="plain" onClick={() => setShowConditions(false)}>Hide</Button>}
            >
                {showConditions
                    ? (
                        <>
                            <ToggleRow checked={cond.onlyUnfocused} onChange={v => patchCond({ onlyUnfocused: v })} title="Only when Discord is in the background" />
                            <ToggleRow checked={cond.skipWhenDnd} onChange={v => patchCond({ skipWhenDnd: v })} title="Not while on “Do Not Disturb”" />
                            <ToggleRow checked={cond.hoursEnabled} onChange={v => patchCond({ hoursEnabled: v })} title="Only within a time window" />
                            {cond.hoursEnabled && (
                                <Row
                                    title="Between"
                                    trailing={
                                        <span className={cl("inline")}>
                                            <TextField type="time" className={cl("time-input")} value={cond.hoursFrom} onChange={hoursFrom => patchCond({ hoursFrom })} />
                                            <span>and</span>
                                            <TextField type="time" className={cl("time-input")} value={cond.hoursTo} onChange={hoursTo => patchCond({ hoursTo })} />
                                        </span>
                                    }
                                />
                            )}
                        </>
                    )
                    : <Row title="Add conditions" subtitle="Background only, not on Do Not Disturb, time window" chevron onClick={() => setShowConditions(true)} />}
            </Section>

            <Section title="Then …" plain>
                <Stack>
                    {rule.actions.map((a, i) => {
                        const def = ACTIONS[a.type];
                        const AEditor = ACTION_EDITORS[a.type];
                        if (!def) return null;
                        return (
                            <Group key={a.type + i}>
                                <Row
                                    leading={<Glyph path={RI[def.icon]} color={ACTION_COLOR[a.type]} />}
                                    title={def.label}
                                    subtitle={def.hint}
                                    trailing={<IconButton icon={ICONS.trash} label="Remove action" destructive onClick={() => setRule({ ...rule, actions: rule.actions.filter((_, j) => j !== i) })} />}
                                />
                                {AEditor && <AEditor value={a} patch={p => patchAction(i, p)} trigger={rule.trigger} />}
                            </Group>
                        );
                    })}
                    {missing.length > 0 && (
                        <div className={cl("buttons")}>
                            {missing.map(t => (
                                <Button key={t} small variant="gray" icon={ICONS.plus} title={ACTIONS[t].hint} onClick={() => setRule({ ...rule, actions: [...rule.actions, act(t)] })}>
                                    {ACTIONS[t].label}
                                </Button>
                            ))}
                        </div>
                    )}
                </Stack>
            </Section>
        </>
    );
}

function RuleEditor({ close, initial }: { close(): void; initial?: Rule; }) {
    const [rule, setRule] = useState<Rule | null>(initial ? structuredClone(initial) : null);
    const error = rule ? validate(rule) : null;

    const save = () => {
        if (!rule || error) return;
        upsertRule({ ...rule, name: rule.name.trim() });
        showToast(initial ? "Rule saved" : "Rule created", "success");
        close();
    };

    return (
        <Sheet
            onClose={close}
            height={rule ? "min(760px, 88vh)" : undefined}
            header={{
                title: initial ? "Edit rule" : "New rule",
                subtitle: rule ? "Everything runs locally on your side - Radar never sends messages." : "Choose a preset or a trigger.",
                icon: RI.rules,
                iconColor: "green"
            }}
            notice={rule && error ? error : undefined}
            actions={rule
                ? [
                    ...(!initial ? [{ label: "Back", onClick: () => setRule(null), variant: "gray" as const }] : []),
                    { label: "Test", onClick: () => testRule(rule), variant: "gray" as const, disabled: !rule.actions.some(a => a.type !== "status") },
                    { label: "Save", onClick: save, disabled: !!error }
                ]
                : [{ label: "Cancel", onClick: close, variant: "gray" }]}
        >
            <div className={cl("form")}>
                {rule ? <RuleForm rule={rule} setRule={setRule} /> : <PresetPicker onPick={setRule} />}
            </div>
        </Sheet>
    );
}

export function openRuleEditor(rule?: Rule) {
    openWindow(close => <RuleEditor close={close} initial={rule} />);
}
