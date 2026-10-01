/*
 * ServerTools – ChannelHealth window
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import ErrorBoundary from "@components/ErrorBoundary";
import { classes } from "@utils/misc";
import { saveFile } from "@utils/web";
import { GuildStore, Modal, openModal, showToast, Toasts, useEffect, useMemo, useState } from "@webpack/common";

import { formatDuration, GuildIcon, GuildSelect } from "./BackupModal";
import { Button, Card, cl, LogList, Notice, NumberField, ProgressBar, QueueBadge, Segmented, Stat, useJob } from "./components";
import { buildSuggestions, getScanChannels, HealthResult, loadCachedHealth, saveCachedHealth, scanGuild, toCsv, WEEKDAYS } from "./health";
import { settings } from "./index";
import { describeError, isCancelled, queueConfig } from "./queue";

const DAY_OPTIONS = [
    { value: 7, label: "7 days" },
    { value: 30, label: "30 days" },
    { value: 90, label: "90 days" }
];

const formatDate = (ms: number | null) => ms ? new Date(ms).toLocaleDateString(undefined, { day: "2-digit", month: "2-digit", year: "numeric" }) : "–";

function relative(ms: number) {
    const days = Math.floor((Date.now() - ms) / 86400_000);
    if (days <= 0) return "today";
    if (days === 1) return "yesterday";
    return `${days} days ago`;
}

// ---------------------------------------------------------------- Result building blocks

function ChannelTable({ result }: { result: HealthResult; }) {
    const max = Math.max(1, ...result.channels.map(c => c.messages));
    return (
        <div className={cl("table-wrap")}>
            <table className={cl("table")}>
                <thead>
                    <tr>
                        <th>Channel</th>
                        <th className={cl("num")}>Messages</th>
                        <th className={cl("num")}>Authors</th>
                        <th>Last message</th>
                    </tr>
                </thead>
                <tbody>
                    {result.channels.map(c => (
                        <tr key={c.id}>
                            <td>
                                <div className={cl("channel-cell")}>
                                    <span className={cl("channel-name")}>#{c.name}</span>
                                    {c.messages === 0 && !c.error && <span className={classes(cl("badge"), cl("badge-dead"))}>dead</span>}
                                    {c.truncated && <span className={cl("badge")} title={`Limit of ${result.maxPerChannel} reached`}>≥</span>}
                                    {c.error && <span className={classes(cl("badge"), cl("badge-warn"))} title={c.error}>Error</span>}
                                </div>
                                {c.category && <div className={cl("muted")}>{c.category}</div>}
                                <div className={cl("bar")}><div className={cl("bar-fill")} style={{ width: `${c.messages / max * 100}%` }} /></div>
                            </td>
                            <td className={cl("num")}>{c.messages.toLocaleString()}{c.truncated ? "+" : ""}</td>
                            <td className={cl("num")}>{c.authors}</td>
                            <td title={c.lastMessage ? new Date(c.lastMessage).toLocaleString() : undefined}>
                                {formatDate(c.lastMessage)}
                            </td>
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>
    );
}

function Heatmap({ data }: { data: number[]; }) {
    const max = Math.max(1, ...data);
    return (
        <div className={cl("heatmap-wrap")}>
            <div className={cl("heatmap")}>
                <span />
                {Array.from({ length: 24 }, (_, h) => <span key={h} className={cl("heat-hour")}>{h % 3 === 0 ? h : ""}</span>)}
                {WEEKDAYS.flatMap((day, d) => [
                    <span key={`l${d}`} className={cl("heat-day")}>{day}</span>,
                    ...Array.from({ length: 24 }, (_, h) => {
                        const v = data[d * 24 + h];
                        const hh = String(h).padStart(2, "0");
                        return (
                            <span
                                key={`${d}-${h}`}
                                className={cl("heat-cell")}
                                style={{ "--vc-st-heat": v === 0 ? 0 : 0.12 + 0.88 * (v / max) } as React.CSSProperties}
                                title={`${day} ${hh}:00–${hh}:59 · ${v} messages`}
                            />
                        );
                    })
                ])}
            </div>
            <div className={cl("heat-legend")}>
                <span>0</span>
                <span className={cl("heat-scale")} />
                <span>{max} messages / hour (total over the period, local time)</span>
            </div>
        </div>
    );
}

function Results({ result }: { result: HealthResult; }) {
    const suggestions = useMemo(() => buildSuggestions(result), [result]);
    const dead = result.channels.filter(c => c.messages === 0 && !c.error).length;
    const topMax = Math.max(1, ...result.topMembers.map(m => m.count));

    const exportCsv = () => {
        const name = `channel-health-${result.guildName.replace(/[^\w-]+/g, "_")}-${new Date(result.scannedAt).toISOString().slice(0, 10)}.csv`;
        saveFile(new File([toCsv(result)], name, { type: "text/csv;charset=utf-8" }));
    };

    return (
        <>
            <Card title={`Results - last ${result.days} days`} icon="pulse" right={<Button small variant="ghost" icon="download" onClick={exportCsv}>CSV</Button>}>
                <div className={cl("stats")}>
                    <Stat label="Messages" value={result.totalMessages.toLocaleString()} />
                    <Stat label="Active authors" value={result.uniqueAuthors} />
                    <Stat label="Channels" value={result.channels.length} />
                    <Stat label="Dead channels" value={dead} />
                </div>
                <div className={cl("hint")}>As of {new Date(result.scannedAt).toLocaleString()} ({relative(result.scannedAt)}) · {result.requests} requests</div>
            </Card>

            <Card title="Channels by activity" icon="table">
                <ChannelTable result={result} />
            </Card>

            <Card title="When is it busiest?" icon="pulse">
                <Heatmap data={result.heatmap} />
            </Card>

            <div className={cl("grid-2")}>
                <Card title="Top 10 members" icon="gift">
                    {result.topMembers.length === 0
                        ? <div className={cl("muted")}>No messages in the period.</div>
                        : (
                            <ol className={cl("top")}>
                                {result.topMembers.map(m => (
                                    <li key={m.id}>
                                        <span className={cl("top-name")}>{m.name}</span>
                                        <span className={cl("top-bar")}><span style={{ width: `${m.count / topMax * 100}%` }} /></span>
                                        <span className={cl("num")}>{m.count}</span>
                                    </li>
                                ))}
                            </ol>
                        )}
                    <div className={cl("muted")}>Excluding bots and webhooks.</div>
                </Card>

                <Card title="Suggestions" icon="tools">
                    {suggestions.length === 0
                        ? <div className={cl("muted")}>All healthy - nothing unusual.</div>
                        : (
                            <ul className={cl("suggestions")}>
                                {suggestions.map((s, i) => (
                                    <li key={i} className={cl(`sug-${s.kind}`)}>{s.text}</li>
                                ))}
                            </ul>
                        )}
                </Card>
            </div>
        </>
    );
}

// ---------------------------------------------------------------- Window

function HealthPanel({ initialGuildId }: { initialGuildId: string | null; }) {
    const guilds = useMemo(() => Object.values(GuildStore.getGuilds()).sort((a, b) => a.name.localeCompare(b.name)), []);
    const [guildId, setGuildId] = useState<string | null>(initialGuildId);
    const [days, setDays] = useState<number>(settings.store.healthDays);
    const [maxPer, setMaxPer] = useState<number>(settings.store.healthMaxPerChannel);
    const [result, setResult] = useState<HealthResult | null>(null);
    const [fromCache, setFromCache] = useState(false);
    const job = useJob();

    const guild = guildId ? GuildStore.getGuild(guildId) : null;
    const channelCount = useMemo(() => guildId ? getScanChannels(guildId).length : 0, [guildId]);

    useEffect(() => {
        setResult(null);
        if (!guildId) return;
        let alive = true;
        loadCachedHealth(guildId).then(r => {
            if (alive && r) {
                setResult(r);
                setFromCache(true);
            }
        });
        return () => { alive = false; };
    }, [guildId]);

    const start = () => {
        if (!guildId) return;
        settings.store.healthDays = days;
        settings.store.healthMaxPerChannel = maxPer;
        job.run(hooks => scanGuild(guildId, {
            days,
            maxPerChannel: maxPer,
            token: hooks.token,
            onRateLimit: hooks.onRateLimit,
            onProgress: p => hooks.onProgress(p.channelIndex, p.channelCount, `#${p.channelName} - ${p.loaded} loaded · total ${p.totalMessages.toLocaleString()}`)
        }))
            .then(res => {
                if (!res) return;
                setResult(res);
                setFromCache(false);
                saveCachedHealth(res);
            })
            .catch(e => !isCancelled(e) && showToast(`Analysis failed: ${describeError(e)}`, Toasts.Type.FAILURE));
    };

    // Rough upper bound on requests: up to max/100 per channel
    const worstCase = channelCount * Math.ceil(maxPer / 100);

    return (
        <div className={cl("modal")}>
            <Card title="Server & time range" icon="pulse" right={<QueueBadge />}>
                <div className={cl("row-inline")}>
                    {guild && <GuildIcon guild={guild} />}
                    <GuildSelect guilds={guilds} value={guildId} disabled={job.state.running} onChange={setGuildId} />
                </div>
                <div className={cl("row-inline")}>
                    <Segmented<number> value={days} options={DAY_OPTIONS} onChange={setDays} disabled={job.state.running} />
                    <span className={cl("muted")}>max.</span>
                    <NumberField value={maxPer} min={100} max={10000} onChange={setMaxPer} disabled={job.state.running} suffix="messages per channel" />
                </div>
                <div className={cl("hint")}>
                    {channelCount} readable text channels. Channels without messages in the period cost no request. Worst case
                    about {worstCase} requests (~{formatDuration(worstCase * queueConfig.interval / 1000)}), throttled via the shared queue.
                </div>
                <div className={cl("actions")}>
                    {job.state.running
                        ? <Button variant="danger" icon="stop" onClick={job.cancel}>Cancel</Button>
                        : <Button icon="play" disabled={!guildId || channelCount === 0} onClick={start}>{result ? "Analyze again" : "Start analysis"}</Button>}
                </div>
                {job.state.running && <ProgressBar done={job.state.done} total={job.state.total} label={job.state.label} />}
                <LogList entries={job.state.log.filter(e => e.kind !== "ok")} />
            </Card>

            {fromCache && result && !job.state.running && (
                <Notice tone="info">Cached result from {new Date(result.scannedAt).toLocaleString()} - “Analyze again” for current numbers.</Notice>
            )}
            {result && <Results result={result} />}
        </div>
    );
}

export function openHealthModal(guildId: string | null) {
    openModal(props => (
        <Modal {...props} size="xl" title="Channel Health" subtitle="Which channels are alive - and which are not?">
            <ErrorBoundary>
                <HealthPanel initialGuildId={guildId} />
            </ErrorBoundary>
        </Modal>
    ));
}
