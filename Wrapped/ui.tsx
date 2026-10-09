/*
 * Wrapped – dashboard modal, settings panel & title bar button
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./ui.css";

import ErrorBoundary from "@components/ErrorBoundary";
import { Switch } from "@components/Switch";
import { classes } from "@utils/misc";
import { saveFile } from "@utils/web";
import { findComponentByCodeLazy } from "@webpack";
import { ChannelStore, ConfirmModal, GuildStore, IconUtils, Modal, openModal, showToast, useEffect, useMemo, UserStore, useState } from "@webpack/common";
import type { ReactNode } from "react";

import { AllTimeData, cancelBackfill, clearAllTime, getBackfill, onBackfillChange, runBackfill } from "./backfill";
import { BarChart, cl, Heatmap, MeterRow } from "./charts";
import { settings } from "./index";
import { aggregate, combine, fmtDuration, fmtHours, fmtNum, funFacts, Metric, Period, PERIODS, top } from "./stats";
import { exportJson, flushStats, getStats, isLoaded, onStatsChange, resetStats } from "./store";
import { userName } from "./tracker";

const HeaderBarIcon = findComponentByCodeLazy(".HEADER_BAR_BADGE_BOTTOM,", 'position:"bottom"');

// ---------------------------------------------------------------- Icons

const ICONS = {
    chart: "M5 9.2h3V19H5V9.2ZM10.6 5h2.8v14h-2.8V5Zm5.6 8H19v6h-2.8v-6Z",
    voice: "M12 14a3 3 0 0 0 3-3V5a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3Zm5-3a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.92V21h2v-3.08A7 7 0 0 0 19 11h-2Z",
    message: "M20 2H4a2 2 0 0 0-2 2v18l4-4h14a2 2 0 0 0 2-2V4a2 2 0 0 0-2-2Z",
    clock: "M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20Zm.5 5v5.25l4.5 2.67-.75 1.23L11 13V7h1.5Z",
    game: "M21 6H3a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h18a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2Zm-10 7H8v3H6v-3H3v-2h3V8h2v3h3v2Zm4.5 2a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3Zm4-3a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3Z",
    at: "M12 2a10 10 0 0 0 0 20h5v-2h-5a8 8 0 1 1 8-8v1.43c0 .79-.71 1.57-1.5 1.57s-1.5-.78-1.5-1.57V12a5 5 0 1 0-1.46 3.53A3.7 3.7 0 0 0 18.5 17c1.97 0 3.5-1.6 3.5-3.57V12A10 10 0 0 0 12 2Zm0 13a3 3 0 1 1 0-6 3 3 0 0 1 0 6Z",
    hash: "M10 3 9.3 7H5.5l-.35 2H9l-.7 4H4.5l-.35 2H8l-.7 4h2l.7-4h4l-.7 4h2l.7-4h3.8l.35-2H16.3l.7-4h3.8l.35-2H17.3l.7-4h-2l-.7 4h-4l.7-4h-2Zm1 6h4l-.7 4h-4l.7-4Z",
    search: "M15.5 14h-.79l-.28-.27A6.47 6.47 0 0 0 16 9.5 6.5 6.5 0 1 0 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5Zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14Z"
};

function Icon({ name, size = 20, className }: { name: keyof typeof ICONS; size?: number; className?: string; }) {
    return (
        <svg viewBox="0 0 24 24" width={size} height={size} className={classes(cl("icon"), className)} aria-hidden>
            <path fill="currentColor" d={ICONS[name]} />
        </svg>
    );
}

// ---------------------------------------------------------------- Hooks

function useStats() {
    const [, setTick] = useState(0);
    useEffect(() => onStatsChange(() => setTick(t => t + 1)), []);
    return getStats();
}

function useBackfill() {
    const [, setTick] = useState(0);
    useEffect(() => onBackfillChange(() => setTick(t => t + 1)), []);
    return getBackfill();
}

// ---------------------------------------------------------------- Names & pictures

const cachedName = (id: string) => getStats().names[id];

function userLabel(id: string) {
    return userName(UserStore.getUser(id)) ?? cachedName(id) ?? "Unknown user";
}

function placeLabel(id: string) {
    if (id === "@me") return "Direct messages";
    return GuildStore.getGuild(id)?.name ?? cachedName(id) ?? "Unknown server";
}

function channelLabel(id: string): { name: string; sub?: string; } {
    const c = ChannelStore.getChannel(id);
    if (!c) return { name: cachedName(id) ?? "Unknown channel" };
    if (c.type === 1) return { name: "@" + userLabel(c.recipients?.[0]), sub: "Direct message" };
    if (c.type === 3) return { name: c.name || cachedName(id) || "Group DM", sub: "Group DM" };
    return { name: "#" + c.name, sub: placeLabel(c.guild_id) };
}

function Pic({ src, fallback, round = true }: { src?: string | null; fallback: string; round?: boolean; }) {
    const [failed, setFailed] = useState(false);
    if (src && !failed)
        return <img className={classes(cl("pic"), round && cl("pic-round"))} src={src} alt="" onError={() => setFailed(true)} />;
    return <span className={classes(cl("pic"), cl("pic-fallback"), round && cl("pic-round"))}>{fallback.replace(/^[@#]/, "").slice(0, 1).toUpperCase() || "?"}</span>;
}

function UserPic({ id }: { id: string; }) {
    const user = UserStore.getUser(id);
    let src: string | undefined;
    try { src = user ? user.getAvatarURL(undefined, 64, false) : IconUtils.getDefaultAvatarURL(id); } catch { /* ignore */ }
    return <Pic src={src} fallback={userLabel(id)} />;
}

function PlacePic({ id }: { id: string; }) {
    if (id === "@me") return <span className={classes(cl("pic"), cl("pic-fallback"), cl("pic-round"))}><Icon name="at" size={18} /></span>;
    const g = GuildStore.getGuild(id);
    let src: string | undefined;
    try { if (g?.icon) src = IconUtils.getGuildIconURL({ id, icon: g.icon, size: 64 }); } catch { /* ignore */ }
    return <Pic src={src} fallback={placeLabel(id)} round={false} />;
}

// ---------------------------------------------------------------- Building blocks

function Seg<T extends string>({ value, options, onChange, small }: { value: T; options: { id: T; label: string; }[]; onChange(v: T): void; small?: boolean; }) {
    return (
        <div className={classes(cl("seg"), small && cl("seg-small"))}>
            {options.map(o => (
                <button
                    key={o.id}
                    className={classes(cl("seg-item"), o.id === value && cl("seg-item-active"))}
                    onClick={() => onChange(o.id)}
                >
                    {o.label}
                </button>
            ))}
        </div>
    );
}

function Card({ title, children, className, action }: { title: string; children: ReactNode; className?: string; action?: ReactNode; }) {
    return (
        <section className={classes(cl("card"), className)}>
            <div className={cl("card-head")}>
                <h3 className={cl("card-title")}>{title}</h3>
                {action}
            </div>
            {children}
        </section>
    );
}

function Hero({ icon, value, unit, label, tone }: { icon: keyof typeof ICONS; value: string; unit?: string; label: string; tone: string; }) {
    return (
        <div className={classes(cl("hero"), cl(`hero-${tone}`))}>
            <Icon name={icon} size={22} className={cl("hero-icon")} />
            <div className={cl("hero-value")}>
                {value}
                {unit && <span className={cl("hero-unit")}>{unit}</span>}
            </div>
            <div className={cl("hero-label")}>{label}</div>
        </div>
    );
}

const Empty = ({ children }: { children: ReactNode; }) => <div className={cl("empty")}>{children}</div>;

const METRICS: { id: Metric; label: string; }[] = [
    { id: "messages", label: "Messages" },
    { id: "voice", label: "Voice" },
    { id: "active", label: "Active" }
];

// ---------------------------------------------------------------- All-time (search backfill)

function AllTime() {
    const bf = useBackfill();
    const data: AllTimeData | null = bf.result;
    const totalMine = data ? data.guilds.reduce((a, g) => a + g.mine, 0) + data.dms.reduce((a, d) => a + d.mine, 0) : 0;
    const guilds = data?.guilds.filter(g => g.mine > 0).slice(0, 8) ?? [];
    const dms = data?.dms.filter(d => (d.total ?? 0) > 0).slice(0, 8) ?? [];
    const gMax = Math.max(1, ...guilds.map(g => g.mine));
    const dMax = Math.max(1, ...dms.map(d => d.total ?? 0));

    const button = bf.running
        ? <button className={classes(cl("btn"), cl("btn-ghost"))} onClick={cancelBackfill}>Stop</button>
        : <button className={cl("btn")} onClick={() => void runBackfill()}><Icon name="search" size={16} />{data ? "Count again" : "Count my messages"}</button>;

    return (
        <Card title="All-time (from Discord search)" className={cl("alltime")} action={button}>
            <div className={cl("hint")}>
                Counts every message you ever sent per server and in your 25 most recent DMs, using Discord's search. Runs slowly on purpose
                (one request every ~1.5 s) to respect rate limits. These numbers are separate from the tracked stats above.
            </div>

            {bf.running && (
                <div className={cl("progress")}>
                    <div className={cl("progress-track")}>
                        <div className={cl("progress-fill")} style={{ width: `${bf.total ? bf.done / bf.total * 100 : 0}%` }} />
                    </div>
                    <div className={cl("hint")}>
                        {bf.done} / {bf.total} · {bf.waiting ? `Waiting ${bf.waiting}s (rate limit or search index)…` : bf.label}
                    </div>
                </div>
            )}
            {bf.error && <div className={cl("error")}>{bf.error}</div>}

            {data && !bf.running && (
                <>
                    <div className={cl("alltime-total")}>
                        <span className={cl("alltime-num")}>{fmtNum(totalMine)}</span>
                        <span className={cl("hint")}>messages sent in total · counted {new Date(data.at).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" })}</span>
                    </div>
                    <div className={cl("cols")}>
                        <div className={cl("list")}>
                            <div className={cl("sub-title")}>Servers</div>
                            {guilds.map(g => <MeterRow key={g.id} icon={<PlacePic id={g.id} />} name={GuildStore.getGuild(g.id)?.name ?? g.name} value={g.mine} max={gMax} label={fmtNum(g.mine)} />)}
                            {!guilds.length && <Empty>No messages found.</Empty>}
                        </div>
                        <div className={cl("list")}>
                            <div className={cl("sub-title")}>DMs (messages exchanged)</div>
                            {dms.map(d => (
                                <MeterRow
                                    key={d.id}
                                    icon={d.userId ? <UserPic id={d.userId} /> : undefined}
                                    name={d.userId ? userLabel(d.userId) : d.name}
                                    sub={`${fmtNum(d.mine)} by you · ${fmtNum((d.total ?? 0) - d.mine)} by them`}
                                    value={d.total ?? 0}
                                    max={dMax}
                                    label={fmtNum(d.total ?? 0)}
                                />
                            ))}
                            {!dms.length && <Empty>No DMs counted.</Empty>}
                        </div>
                    </div>
                </>
            )}
        </Card>
    );
}

// ---------------------------------------------------------------- Dashboard

function Dashboard() {
    const stats = useStats();
    const [period, setPeriod] = useState<Period>("30");
    const [metric, setMetric] = useState<Metric>("messages");

    // Re-aggregate when data changes (stats object is mutated in place → depend on a counter)
    const [version, setVersion] = useState(0);
    useEffect(() => onStatsChange(() => setVersion(v => v + 1)), []);
    const agg = useMemo(() => aggregate(period), [period, version, stats]);

    const games = top(agg.games, 6);
    const people = top(agg.voiceWith, 8);
    const dms = combine(agg.dmSent, agg.dmReceived, 8);
    const places = combine(agg.msgPlaces, agg.voicePlaces, 8);
    const channels = top(agg.msgChannels, 6);
    const voiceChannels = top(agg.voiceChannels, 4);
    const facts = useMemo(() => funFacts(agg, games[0]), [agg]);

    const since = new Date(stats.since);
    const hasData = agg.messages + agg.voice + agg.active > 0;
    const max = (rows: [string, number][]) => Math.max(1, ...rows.map(r => r[1]));
    const dmMax = Math.max(1, ...dms.map(d => d.a + d.b));
    const placeMsgMax = Math.max(1, ...places.map(p => p.a));

    return (
        <div className={cl("dash")}>
            <header className={cl("top")}>
                <div className={cl("top-text")}>
                    <div className={cl("kicker")}>Your Discord</div>
                    <div className={cl("headline")}>Wrapped</div>
                    <div className={cl("hint")}>
                        Tracking since {since.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" })} · stored only on this device
                    </div>
                </div>
                <Seg<Period> value={period} options={PERIODS} onChange={setPeriod} />
            </header>

            {!isLoaded() && <Empty>Loading…</Empty>}

            <div className={cl("heroes")}>
                <Hero tone="voice" icon="voice" value={fmtHours(agg.voice)} unit="h" label="in voice" />
                <Hero tone="msg" icon="message" value={fmtNum(agg.messages)} label="messages sent" />
                <Hero tone="active" icon="clock" value={fmtHours(agg.active)} unit="h" label="active on Discord" />
                <Hero tone="game" icon="game" value={games[0]?.[0] ?? "–"} label={games[0] ? `top game · ${fmtDuration(games[0][1])}` : "no games tracked"} />
            </div>

            {!hasData && isLoaded() && (
                <Empty>
                    Nothing tracked in this period yet. Stats are collected from now on while Discord is open – check back in a few days.
                </Empty>
            )}

            <Card title="Activity" action={<Seg<Metric> small value={metric} options={METRICS} onChange={setMetric} />}>
                <BarChart days={agg.days} metric={metric} />
                <div className={cl("sub-title")}>When you are on Discord</div>
                <Heatmap agg={agg} metric={metric} />
            </Card>

            <div className={cl("cols")}>
                <Card title="Top people in voice">
                    <div className={cl("list")}>
                        {people.map(([id, secs]) => <MeterRow key={id} icon={<UserPic id={id} />} name={userLabel(id)} value={secs} max={max(people)} label={fmtDuration(secs)} />)}
                        {!people.length && <Empty>No voice time with others yet.</Empty>}
                    </div>
                </Card>
                <Card title="Top DMs">
                    <div className={cl("list")}>
                        {dms.map(d => (
                            <MeterRow
                                key={d.id}
                                icon={<UserPic id={d.id} />}
                                name={userLabel(d.id)}
                                sub={`${fmtNum(d.a)} sent · ${fmtNum(d.b)} received`}
                                value={d.a + d.b}
                                max={dmMax}
                                label={fmtNum(d.a + d.b)}
                            />
                        ))}
                        {!dms.length && <Empty>No DMs yet.</Empty>}
                    </div>
                </Card>
            </div>

            <div className={cl("cols")}>
                <Card title="Top servers">
                    <div className={cl("list")}>
                        {places.map(p => (
                            <MeterRow
                                key={p.id}
                                icon={<PlacePic id={p.id} />}
                                name={placeLabel(p.id)}
                                sub={p.b ? `${fmtDuration(p.b)} in voice` : undefined}
                                value={p.a}
                                max={placeMsgMax}
                                label={`${fmtNum(p.a)} msgs`}
                            />
                        ))}
                        {!places.length && <Empty>No server activity yet.</Empty>}
                    </div>
                </Card>
                <Card title="Top channels">
                    <div className={cl("list")}>
                        {channels.map(([id, n]) => {
                            const { name, sub } = channelLabel(id);
                            return <MeterRow key={id} icon={<span className={classes(cl("pic"), cl("pic-fallback"))}><Icon name="hash" size={16} /></span>} name={name} sub={sub} value={n} max={max(channels)} label={fmtNum(n)} />;
                        })}
                        {voiceChannels.length > 0 && <div className={cl("sub-title")}>Voice channels</div>}
                        {voiceChannels.map(([id, secs]) => {
                            const { name, sub } = channelLabel(id);
                            return <MeterRow key={id} icon={<span className={classes(cl("pic"), cl("pic-fallback"))}><Icon name="voice" size={16} /></span>} name={name.replace(/^#/, "")} sub={sub} value={secs} max={max(voiceChannels)} label={fmtDuration(secs)} />;
                        })}
                        {!channels.length && !voiceChannels.length && <Empty>No channel activity yet.</Empty>}
                    </div>
                </Card>
            </div>

            {games.length > 0 && (
                <Card title="Games">
                    <div className={cl("list")}>
                        {games.map(([name, secs]) => <MeterRow key={name} icon={<span className={classes(cl("pic"), cl("pic-fallback"))}><Icon name="game" size={16} /></span>} name={name} value={secs} max={max(games)} label={fmtDuration(secs)} />)}
                    </div>
                </Card>
            )}

            {facts.length > 0 && (
                <Card title="Fun facts">
                    <div className={cl("facts")}>
                        {facts.map(f => (
                            <div key={f.text} className={cl("fact")}>
                                <span className={cl("fact-emoji")}>{f.emoji}</span>
                                <span>{f.text}</span>
                            </div>
                        ))}
                    </div>
                </Card>
            )}

            <AllTime />
        </div>
    );
}

export function openWrappedModal() {
    void flushStats();
    openModal(props => (
        <Modal {...props} size="lg" title="Wrapped" actions={[{ text: "Close", variant: "secondary", onClick: props.onClose }]}>
            <ErrorBoundary noop>
                <Dashboard />
            </ErrorBoundary>
        </Modal>
    ));
}

// ---------------------------------------------------------------- Settings

function exportData() {
    const json = exportJson(getBackfill().result);
    const filename = `wrapped-${new Date().toISOString().slice(0, 10)}.json`;
    const data = new TextEncoder().encode(json);
    if (IS_DISCORD_DESKTOP) DiscordNative.fileManager.saveWithDialog(data, filename);
    else saveFile(new File([data], filename, { type: "application/json" }));
}

function confirmReset() {
    openModal(props => (
        <ConfirmModal
            {...props}
            title="Reset Wrapped?"
            subtitle="All tracked statistics and the all-time counts will be deleted. Tracking starts over from today."
            confirmText="Reset"
            cancelText="Cancel"
            variant="critical-primary"
            onConfirm={() => {
                Promise.all([resetStats(), clearAllTime()])
                    .then(() => showToast("Wrapped was reset", "success"))
                    .catch(() => showToast("Reset failed", "failure"));
            }}
        />
    ));
}

const TOGGLES = [
    { key: "trackMessages", label: "Messages", hint: "Messages you send (per server, channel, hour) and DMs you receive." },
    { key: "trackVoice", label: "Voice time", hint: "Time in voice channels and calls, and who was there with you." },
    { key: "trackActive", label: "Active time", hint: "Time Discord is focused and you are not idle." },
    { key: "trackGames", label: "Games", hint: "Time per game from your own activity status." },
    { key: "showTitleBarButton", label: "Show icon in the title bar", hint: "Opens the dashboard. Also available in the Vencord toolbox." }
] as const;

function Panel() {
    const s = settings.use(["trackMessages", "trackVoice", "trackActive", "trackGames", "showTitleBarButton", "idleMinutes"]);
    const stats = useStats();
    const days = Object.keys(stats.days).length;

    return (
        <div className={cl("settings")}>
            <div className={cl("settings-head")}>
                <span className={cl("logo")}><Icon name="chart" size={22} /></span>
                <div>
                    <div className={cl("settings-title")}>Wrapped</div>
                    <div className={cl("hint")}>
                        Tracking since {new Date(stats.since).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" })} · {days} {days === 1 ? "day" : "days"} with data ·
                        stored only on this device (last 366 days).
                    </div>
                </div>
            </div>
            <button className={cl("btn")} onClick={openWrappedModal}><Icon name="chart" size={16} />Open dashboard</button>

            {TOGGLES.map(t => (
                <label key={t.key} className={cl("option")}>
                    <span>
                        <span className={cl("option-label")}>{t.label}</span>
                        <span className={cl("hint")}>{t.hint}</span>
                    </span>
                    <Switch checked={s[t.key]} onChange={v => settings.store[t.key] = v} />
                </label>
            ))}

            <label className={cl("option")}>
                <span>
                    <span className={cl("option-label")}>Idle after</span>
                    <span className={cl("hint")}>Minutes without mouse or keyboard input before active time stops counting.</span>
                </span>
                <select className={cl("select")} value={s.idleMinutes} onChange={e => settings.store.idleMinutes = Number(e.currentTarget.value)}>
                    {[2, 5, 10, 15, 30].map(m => <option key={m} value={m}>{m} min</option>)}
                </select>
            </label>

            <div className={cl("row-inline")}>
                <button className={classes(cl("btn"), cl("btn-ghost"))} onClick={exportData}>Export JSON</button>
                <button className={classes(cl("btn"), cl("btn-danger"))} onClick={confirmReset}>Reset all data</button>
            </div>
        </div>
    );
}

export const SettingsPanel = ErrorBoundary.wrap(Panel, { noop: true });

// ---------------------------------------------------------------- Title bar

function TitleBarButton() {
    const { showTitleBarButton } = settings.use(["showTitleBarButton"]);
    if (!showTitleBarButton) return null;

    return (
        <HeaderBarIcon
            className={cl("btn-titlebar")}
            onClick={openWrappedModal}
            tooltip="Wrapped"
            icon={() => <Icon name="chart" />}
        />
    );
}

export function renderTitleBarButton() {
    return (
        <ErrorBoundary key="vc-wrapped-titlebar" noop>
            <TitleBarButton />
        </ErrorBoundary>
    );
}
