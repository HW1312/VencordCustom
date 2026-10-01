/*
 * ServerTools – FairGiveaway window
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import ErrorBoundary from "@components/ErrorBoundary";
import { copyWithToast, sendMessage } from "@utils/discord";
import { classes } from "@utils/misc";
import { ChannelStore, GuildRoleStore, Modal, openModal, showToast, Toasts, useEffect, useMemo, useRef, useState } from "@webpack/common";

import { Button, Card, cl, Icon, LogList, Notice, NumberField, ProgressBar, QueueBadge, Stat, ToggleRow, useJob } from "./components";
import { applyFilters, draw, DrawResult, emojiKey, emojiLabel, emojiUrl, ensureMembers, fetchReactors, formatResult, GiveawayFilters, Participant, ReactionEmoji, verifyScript } from "./giveaway";
import { describeError, isCancelled } from "./queue";

function EmojiView({ emoji, size = 22 }: { emoji: ReactionEmoji; size?: number; }) {
    const url = emojiUrl(emoji);
    return url
        ? <img src={url} width={size} height={size} alt={emojiLabel(emoji)} className={cl("emoji")} />
        : <span className={cl("emoji")} style={{ fontSize: size * 0.85 }}>{emoji.name}</span>;
}

const shortHash = (h: string) => `${h.slice(0, 16)}…${h.slice(-8)}`;

// ---------------------------------------------------------------- Window

function GiveawayPanel({ message }: { message: any; }) {
    const channel = ChannelStore.getChannel(message.channel_id);
    const guildId: string | null = channel?.guild_id ?? null;
    const reactions: any[] = message.reactions ?? [];

    const [emojiIdx, setEmojiIdx] = useState(() => Math.max(0, reactions.findIndex(r => r.emoji?.name === "🎉")));
    const [winnerCount, setWinnerCount] = useState(1);
    const [filters, setFilters] = useState<GiveawayFilters>({ excludeBots: true, excludeSelf: true, minAccountDays: 0, minMemberDays: 0, requiredRoles: [] });
    const [participants, setParticipants] = useState<Participant[] | null>(null);
    const [loadedKey, setLoadedKey] = useState<string | null>(null);
    const [membersMissing, setMembersMissing] = useState(0);
    const [rounds, setRounds] = useState<DrawResult[]>([]);
    const [phase, setPhase] = useState<"setup" | "rolling" | "done">("setup");
    const [reel, setReel] = useState({ text: "", n: 0 });
    const [revealed, setRevealed] = useState(0);
    const [confirmPost, setConfirmPost] = useState(false);
    const [showHow, setShowHow] = useState(false);
    const job = useJob();

    const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
    useEffect(() => () => timers.current.forEach(clearTimeout), []);
    const later = (fn: () => void, ms: number) => { timers.current.push(setTimeout(fn, ms)); };

    const reaction = reactions[emojiIdx];
    const emoji: ReactionEmoji | null = reaction ? { id: reaction.emoji.id ?? null, name: reaction.emoji.name, animated: !!reaction.emoji.animated } : null;
    const currentKey = emoji ? emojiKey(emoji) : null;
    const loaded = participants != null && loadedKey === currentKey;

    const roles = useMemo(() => guildId
        ? (GuildRoleStore.getSortedRoles(guildId) ?? []).filter((r: any) => r.id !== guildId && !r.managed)
        : [], [guildId]);

    const filtered = useMemo(
        () => loaded ? applyFilters(participants!, guildId, filters) : null,
        [participants, loaded, filters, guildId, membersMissing]
    );

    const names = useMemo(() => new Map((participants ?? []).map(p => [p.id, p.name])), [participants]);
    const usernames = useMemo(() => new Map((participants ?? []).map(p => [p.id, p.username])), [participants]);

    const latest = rounds[rounds.length - 1] ?? null;
    const previousWinners = useMemo(() => new Set(rounds.flatMap(r => r.winners)), [rounds]);
    const pool = filtered ? filtered.eligible.filter(p => !previousWinners.has(p.id)) : [];

    // ---- Load participants
    const load = () => {
        if (!emoji || !reaction) return;
        const withBurst = (reaction.burst_count ?? reaction.count_details?.burst ?? 0) > 0;
        setRounds([]);
        setPhase("setup");
        job.run(async hooks => {
            const list = await fetchReactors(message.channel_id, message.id, emoji, withBurst, {
                token: hooks.token,
                onRateLimit: hooks.onRateLimit,
                onProgress: n => hooks.onProgress(n, Math.max(n, reaction.count ?? n), `${n} participants loaded …`)
            });
            let missing = 0;
            if (guildId && list.length) {
                hooks.onProgress(1, 1, "Fetching member data …");
                missing = await ensureMembers(guildId, list.map(p => p.id), hooks.token);
            }
            return { list, missing };
        })
            .then(res => {
                if (!res) return;
                setParticipants(res.list);
                setLoadedKey(emojiKey(emoji));
                setMembersMissing(res.missing);
            })
            .catch(e => !isCancelled(e) && showToast(`Failed to load reactions: ${describeError(e)}`, Toasts.Type.FAILURE));
    };

    // ---- Drawing & animation
    const animate = (result: DrawResult, candidates: string[]) => {
        timers.current.forEach(clearTimeout);
        timers.current = [];
        setPhase("rolling");
        setRevealed(0);
        setConfirmPost(false);

        const nameOf = (id: string) => names.get(id) ?? id;
        const randomName = () => nameOf(candidates[Math.floor(Math.random() * candidates.length)]);
        const perWinner = result.winners.length <= 5;
        let index = 0;

        const rollOne = () => {
            let elapsed = 0;
            let delay = 45;
            const duration = perWinner ? 1700 : 2600;
            const tick = () => {
                elapsed += delay;
                if (elapsed >= duration) {
                    if (perWinner) {
                        const id = result.winners[index++];
                        setReel(r => ({ text: nameOf(id), n: r.n + 1 }));
                        setRevealed(index);
                        if (index < result.winners.length) later(rollOne, 700);
                        else later(() => setPhase("done"), 500);
                    } else {
                        setReel(r => ({ text: `${result.winners.length} winners!`, n: r.n + 1 }));
                        setRevealed(result.winners.length);
                        later(() => setPhase("done"), 500);
                    }
                    return;
                }
                setReel(r => ({ text: randomName(), n: r.n + 1 }));
                delay *= 1.13;
                later(tick, delay);
            };
            tick();
        };
        rollOne();
    };

    const doDraw = async (reroll: boolean) => {
        const candidates = (reroll ? pool : filtered?.eligible ?? []).map(p => p.id);
        if (!candidates.length) {
            showToast("No valid participants left", Toasts.Type.FAILURE);
            return;
        }
        try {
            const result = await draw(message.id, candidates, winnerCount, reroll ? rounds.length + 1 : 1);
            setRounds(r => reroll ? [...r, result] : [result]);
            animate(result, candidates);
        } catch (e) {
            showToast(`Draw failed: ${describeError(e)}`, Toasts.Type.FAILURE);
        }
    };

    const resultText = latest && emoji ? formatResult(latest, emoji) : "";

    const post = () => {
        if (!confirmPost) {
            setConfirmPost(true);
            return;
        }
        setConfirmPost(false);
        if (resultText.length > 2000) {
            showToast("Result is longer than 2000 characters - please copy it instead", Toasts.Type.FAILURE);
            return;
        }
        Promise.resolve(sendMessage(message.channel_id, { content: resultText }))
            .then(() => showToast("Result posted", Toasts.Type.SUCCESS))
            .catch(e => showToast(`Failed to send: ${describeError(e)}`, Toasts.Type.FAILURE));
    };

    const locked = rounds.length > 0 || job.state.running || phase === "rolling";
    const setFilter = <K extends keyof GiveawayFilters>(key: K, value: GiveawayFilters[K]) => setFilters(f => ({ ...f, [key]: value }));

    if (!reactions.length) {
        return <div className={cl("modal")}><Notice tone="warn">This message has no reactions.</Notice></div>;
    }

    return (
        <div className={cl("modal")}>
            <Card title="Reaction & winners" icon="gift" right={<QueueBadge />}>
                <div className={cl("emoji-picker")}>
                    {reactions.map((r, i) => (
                        <button
                            key={i}
                            disabled={locked}
                            className={classes(cl("emoji-btn"), i === emojiIdx && cl("emoji-btn-active"))}
                            onClick={() => setEmojiIdx(i)}
                        >
                            <EmojiView emoji={{ id: r.emoji.id ?? null, name: r.emoji.name, animated: r.emoji.animated }} />
                            <span>{r.count}</span>
                        </button>
                    ))}
                </div>
                <div className={cl("row-inline")}>
                    <span>Number of winners</span>
                    <NumberField value={winnerCount} min={1} max={100} onChange={setWinnerCount} disabled={locked} />
                </div>
            </Card>

            <Card title="Filter" icon="shield">
                <ToggleRow checked={filters.excludeBots} disabled={locked} onChange={v => setFilter("excludeBots", v)} label="Exclude bots" />
                <ToggleRow checked={filters.excludeSelf} disabled={locked} onChange={v => setFilter("excludeSelf", v)} label="Exclude myself" />
                <div className={cl("row")}>
                    <span className={cl("row-text")}>
                        <span className={cl("row-label")}>Minimum account age</span>
                        <span className={cl("row-hint")}>Calculated from the user ID (0 = off)</span>
                    </span>
                    <NumberField value={filters.minAccountDays} min={0} max={3650} onChange={v => setFilter("minAccountDays", v)} disabled={locked} suffix="days" />
                </div>
                {guildId && (
                    <div className={cl("row")}>
                        <span className={cl("row-text")}>
                            <span className={cl("row-label")}>Minimum time in server</span>
                            <span className={cl("row-hint")}>Join date from Discord's member cache (0 = off)</span>
                        </span>
                        <NumberField value={filters.minMemberDays} min={0} max={3650} onChange={v => setFilter("minMemberDays", v)} disabled={locked} suffix="days" />
                    </div>
                )}
                {guildId && roles.length > 0 && (
                    <div className={cl("row-block")}>
                        <span className={cl("row-label")}>Required role (at least one)</span>
                        <div className={cl("chips")}>
                            {roles.map((r: any) => {
                                const active = filters.requiredRoles.includes(r.id);
                                return (
                                    <button
                                        key={r.id}
                                        disabled={locked}
                                        className={classes(cl("chip"), active && cl("chip-active"))}
                                        style={{ "--vc-st-role": r.colorString ?? "var(--text-muted)" } as React.CSSProperties}
                                        onClick={() => setFilter("requiredRoles", active ? filters.requiredRoles.filter(x => x !== r.id) : [...filters.requiredRoles, r.id])}
                                    >
                                        <span className={cl("chip-dot")} />
                                        {r.name}
                                    </button>
                                );
                            })}
                        </div>
                    </div>
                )}
            </Card>

            <Card title="Participants" icon="table">
                {!loaded && !job.state.running && (
                    <div className={cl("hint")}>
                        Loads all {reaction?.count ?? ""} reactions (100 per request, throttled). The draw only happens afterwards.
                    </div>
                )}
                {job.state.running && <ProgressBar done={job.state.done} total={job.state.total} label={job.state.label} />}
                <LogList entries={job.state.log.filter(e => e.kind !== "ok")} />
                {filtered && (
                    <>
                        <div className={cl("stats")}>
                            <Stat label="Reactions" value={participants!.length} />
                            <Stat label="Valid" value={filtered.eligible.length} />
                            <Stat label="Excluded" value={participants!.length - filtered.eligible.length} />
                        </div>
                        {Object.keys(filtered.excluded).length > 0 && (
                            <ul className={cl("notes")}>
                                {Object.entries(filtered.excluded).map(([reason, n]) => <li key={reason}>{reason}: {n}</li>)}
                            </ul>
                        )}
                        {filtered.memberUnknown > 0 && (
                            <Notice tone="warn">
                                For {filtered.memberUnknown} participants no join date is known (no longer in the server or not loaded) -
                                the minimum-time filter was skipped for them.
                            </Notice>
                        )}
                    </>
                )}
                <div className={cl("actions")}>
                    {job.state.running
                        ? <Button variant="danger" icon="stop" onClick={job.cancel}>Cancel</Button>
                        : (
                            <>
                                <Button variant={loaded ? "ghost" : "primary"} icon="refresh" disabled={phase === "rolling" || rounds.length > 0} onClick={load}>
                                    {loaded ? "Reload" : "Load participants"}
                                </Button>
                                {loaded && rounds.length === 0 && (
                                    <Button icon="dice" disabled={!filtered?.eligible.length} onClick={() => doDraw(false)}>Draw</Button>
                                )}
                            </>
                        )}
                </div>
            </Card>

            {latest && (
                <Card title={latest.round > 1 ? `Redraw ${latest.round - 1}` : "Draw"} icon="dice">
                    <div className={classes(cl("slot"), phase === "rolling" && cl("slot-rolling"), phase === "done" && cl("slot-done"))}>
                        <div className={cl("slot-window")}>
                            <span key={reel.n} className={cl("slot-name")}>{reel.text}</span>
                        </div>
                    </div>

                    <div className={cl("winners")}>
                        {latest.winners.slice(0, revealed).map((id, i) => (
                            <div key={id} className={cl("winner")} style={{ animationDelay: `${latest.winners.length > 5 ? i * 40 : 0}ms` }}>
                                <span className={cl("winner-rank")}>{i + 1}</span>
                                <span className={cl("winner-name")}>{names.get(id) ?? id}</span>
                                <span className={cl("muted")}>@{usernames.get(id) ?? id}</span>
                            </div>
                        ))}
                    </div>

                    {phase === "done" && (
                        <>
                            <div className={cl("proof")}>
                                <div><span className={cl("muted")}>Participants</span><b>{latest.participantCount}</b></div>
                                <div><span className={cl("muted")}>Time</span><code>{latest.drawTimestamp}</code></div>
                                <div title={latest.seed}><span className={cl("muted")}>Seed</span><code>{shortHash(latest.seed)}</code></div>
                                <div title={latest.participantsHash}><span className={cl("muted")}>Participant hash</span><code>{shortHash(latest.participantsHash)}</code></div>
                            </div>

                            <div className={cl("actions")}>
                                <Button icon="copy" variant="ghost" onClick={() => copyWithToast(resultText, "Result copied")}>Copy result</Button>
                                <Button icon="send" variant={confirmPost ? "danger" : "primary"} onClick={post}>
                                    {confirmPost ? "Really post? (pings the winners)" : "Post in channel"}
                                </Button>
                                <Button icon="refresh" variant="ghost" disabled={pool.length === 0} title="New draw excluding previous winners" onClick={() => doDraw(true)}>
                                    Redraw
                                </Button>
                            </div>

                            <button className={cl("link")} onClick={() => setShowHow(v => !v)}>
                                {showHow ? "▾" : "▸"} How to verify it
                            </button>
                            {showHow && (
                                <div className={cl("how")}>
                                    <ol>
                                        <li>Sort all valid participant IDs <b>numerically ascending</b> and join them with “,”. SHA-256 of that = participant hash.</li>
                                        <li>Seed = SHA-256 of <code>messageID:time:IDlist</code> (message {latest.messageId}, time {latest.drawTimestamp}).</li>
                                        <li>Random numbers: block k = SHA-256(<code>seed:k</code>) for k = 0, 1, 2 ...; each block yields 8 numbers of 32 bits (big-endian).</li>
                                        <li>For position i = 0 ... winners−1: draw a number, discard values ≥ ⌊2³²/(N−i)⌋·(N−i), j = i + number mod (N−i), swap positions i and j (Fisher-Yates). The first positions are the winners.</li>
                                    </ol>
                                    <div className={cl("hint")}>
                                        Because the time is only fixed at the click and the participant list is baked into the hash, nobody can know the result
                                        beforehand or change the list afterwards unnoticed. With the verification script anyone can repeat the draw in the browser console.
                                    </div>
                                    <div className={cl("actions")}>
                                        <Button small variant="ghost" icon="copy" onClick={() => copyWithToast(latest.sortedIds.join(","), "Participant list copied")}>Copy participant IDs</Button>
                                        <Button small variant="ghost" icon="copy" onClick={() => copyWithToast(verifyScript(latest, winnerCount), "Verification script copied")}>Copy verification script</Button>
                                    </div>
                                </div>
                            )}

                            {rounds.length > 1 && (
                                <div className={cl("hint")}>
                                    Previous winners (excluded): {rounds.slice(0, -1).flatMap(r => r.winners).map(id => names.get(id) ?? id).join(", ")}
                                </div>
                            )}
                            <div className={cl("actions")}>
                                <Button small variant="ghost" icon="close" onClick={() => { setRounds([]); setPhase("setup"); setRevealed(0); }}>
                                    Reset
                                </Button>
                            </div>
                        </>
                    )}
                </Card>
            )}
            {emoji && <div className={cl("muted")}>Message {message.id} · Reaction <EmojiView emoji={emoji} size={14} /> · <Icon name="shield" size={12} /> nothing is posted automatically</div>}
        </div>
    );
}

export function openGiveawayModal(message: any) {
    openModal(props => (
        <Modal {...props} size="md" title="Draw giveaway" subtitle="Fair, verifiable and without a bot">
            <ErrorBoundary>
                <GiveawayPanel message={message} />
            </ErrorBoundary>
        </Modal>
    ));
}
