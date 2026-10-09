/*
 * HomeOrganizer – "Requests" tab: review, score and bulk-answer friend requests
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { openUserProfile } from "@utils/discord";
import { classes } from "@utils/misc";
import {
    GuildStore, RelationshipStore, showToast, useMemo, UserProfileStore,
    UserStore, useState, useStateFromStores
} from "@webpack/common";

import { Avatar, Button, Checkbox, Chip, cl, ConfirmItem, Icon, JobBar, Notice, NumberField, openConfirm, QueueBadge, Segmented, useJob } from "./components";
import { acceptRequest, collectRequests, loadMutual, mutualCache, mutualTotal, relative, removeRequest, RequestEntry } from "./data";
import { settings } from "./index";
import { describeError, INTERVAL, isCancelled } from "./queue";

type Dir = "in" | "out";
type Sort = "newest" | "oldest" | "score" | "mutual";

const SORTS: { value: Sort; label: string; }[] = [
    { value: "newest", label: "Newest" },
    { value: "oldest", label: "Oldest" },
    { value: "score", label: "Spam-Score" },
    { value: "mutual", label: "Mutuals" }
];

const sameRequests = (a: RequestEntry[], b: RequestEntry[]) =>
    a.length === b.length && a.every((x, i) => x.id === b[i].id && x.name === b[i].name && x.avatar === b[i].avatar && x.mutual === b[i].mutual && x.score === b[i].score);

const guildName = (id: string) => GuildStore.getGuild(id)?.name ?? `Server ${id}`;

function ageLabel(days: number) {
    if (days < 1) return "created today";
    if (days < 60) return `${days} days old`;
    if (days < 730) return `${Math.round(days / 30.4)} months old`;
    return `${Math.floor(days / 365)} years old`;
}

const toItem = (r: RequestEntry): ConfirmItem => ({ id: r.id, name: r.name, avatar: r.avatar, detail: `${ageLabel(r.ageDays)} · Score ${r.score}` });

function scoreTone(score: number) {
    return score >= 60 ? "bad" : score >= 30 ? "warn" : "good";
}

// ---------------------------------------------------------------- Row

function MutualCell({ r, onLoad, busy }: { r: RequestEntry; onLoad(): void; busy: boolean; }) {
    if (r.mutual === "error") return <button className={cl("link")} disabled={busy} onClick={onLoad} title="Failed to load - try again">Error · retry</button>;
    if (!r.mutual) return <button className={cl("link")} disabled={busy} onClick={onLoad}>load</button>;
    const { guilds, friends } = r.mutual;
    const title = guilds.length ? guilds.map(g => guildName(g.id)).join("\n") : "No mutual servers";
    return (
        <span className={classes(cl("mutual"), !guilds.length && !friends && cl("text-warn"))} title={title}>
            {guilds.length} servers · {friends} friends
        </span>
    );
}

function RequestRow({ r, selected, onSelect, onAccept, onRemove, onLoad, busy }: {
    r: RequestEntry;
    selected: boolean;
    busy: boolean;
    onSelect(v: boolean): void;
    onAccept(): void;
    onRemove(): void;
    onLoad(): void;
}) {
    const young = r.ageDays < settings.store.spamAccountDays;
    return (
        <div className={classes(cl("item"), selected && cl("item-selected"))} onClick={() => onSelect(!selected)}>
            <Checkbox checked={selected} onChange={onSelect} />
            <Avatar src={r.avatar} name={r.name} />
            <div className={cl("item-main")}>
                <div className={cl("item-title")}>
                    <span className={cl("ellipsis")}>{r.name}</span>
                    <span className={cl("muted")}>@{r.username}</span>
                </div>
                <div className={cl("item-sub")}>
                    {r.reasons.map(x => <Chip key={x.id} tone={x.tone}>{x.label}</Chip>)}
                    {!r.reasons.length && <Chip tone="good">Looks fine</Chip>}
                </div>
            </div>
            <div className={cl("item-date")}>
                <span className={classes(young && cl("text-warn"))} title={`Account created on ${new Date(r.createdAt).toLocaleString()}`}>{ageLabel(r.ageDays)}</span>
                <span className={cl("muted")} title={r.since ? new Date(r.since).toLocaleString() : undefined}>
                    {r.since ? `Requested ${relative(r.since)}` : "Date unknown"}
                </span>
            </div>
            <div className={cl("item-mutual")} onClick={e => e.stopPropagation()}>
                <MutualCell r={r} onLoad={onLoad} busy={busy} />
            </div>
            <span className={classes(cl("score"), cl(`score-${scoreTone(r.score)}`))} title="Spam score (0-100)">{r.score}</span>
            <div className={cl("item-actions")} onClick={e => e.stopPropagation()}>
                {r.incoming && <Button small variant="success" icon="check" disabled={busy} onClick={onAccept}>Accept</Button>}
                <Button small variant="ghost" icon="close" disabled={busy} onClick={onRemove}>{r.incoming ? "Ignore" : "Withdraw"}</Button>
                <button className={cl("icon-btn")} title="Open profile" onClick={() => openUserProfile(r.id).catch(() => showToast("Could not open profile", "failure"))}>
                    <Icon name="person" size={16} />
                </button>
            </div>
        </div>
    );
}

// ---------------------------------------------------------------- Tab

export function RequestsTab() {
    const { spamAccountDays } = settings.use(["spamAccountDays"]);
    const [mutualVersion, setMutualVersion] = useState(0);
    const all = useStateFromStores([RelationshipStore, UserStore, UserProfileStore], collectRequests, [spamAccountDays, mutualVersion], sameRequests);

    const [dir, setDir] = useState<Dir>("in");
    const [sort, setSort] = useState<Sort>("newest");
    const [query, setQuery] = useState("");
    const [youngerThan, setYoungerThan] = useState(30);
    const [guildFilter, setGuildFilter] = useState("");
    const [selected, setSelected] = useState<Set<string>>(() => new Set());
    const job = useJob();
    const busy = job.state.running;

    const incoming = all.filter(r => r.incoming);
    const outgoing = all.filter(r => !r.incoming);
    const current = dir === "in" ? incoming : outgoing;

    const visible = useMemo(() => {
        const q = query.trim().toLowerCase();
        const list = current.filter(r => !q || r.name.toLowerCase().includes(q) || r.username.toLowerCase().includes(q) || r.id === q);
        const since = (r: RequestEntry) => r.since ?? 0;
        switch (sort) {
            case "newest": return list.sort((a, b) => since(b) - since(a));
            case "oldest": return list.sort((a, b) => since(a) - since(b));
            case "score": return list.sort((a, b) => b.score - a.score || since(b) - since(a));
            case "mutual": return list.sort((a, b) => mutualTotal(b.mutual) - mutualTotal(a.mutual) || a.score - b.score);
        }
    }, [current, sort, query]);

    const byId = useMemo(() => new Map(current.map(r => [r.id, r])), [current]);
    const selectedEntries = [...selected].map(id => byId.get(id)).filter(Boolean) as RequestEntry[];
    const unloaded = current.filter(r => !r.mutual || r.mutual === "error");

    // Servers shared with requesters (loaded ones only)
    const guildOptions = useMemo(() => {
        const counts = new Map<string, number>();
        for (const r of current) {
            if (!r.mutual || r.mutual === "error") continue;
            for (const g of r.mutual.guilds) counts.set(g.id, (counts.get(g.id) ?? 0) + 1);
        }
        return [...counts].map(([id, n]) => ({ id, n, name: guildName(id) })).sort((a, b) => b.n - a.n || a.name.localeCompare(b.name));
    }, [current]);

    const setSel = (id: string, v: boolean) => setSelected(s => {
        const n = new Set(s);
        if (v) n.add(id); else n.delete(id);
        return n;
    });
    const addSel = (list: RequestEntry[], label: string) => {
        if (!list.length) return showToast(`No matches for “${label}”`, "message");
        setSelected(s => new Set([...s, ...list.map(r => r.id)]));
        showToast(`${list.length} selected (${label})`, "success");
    };

    const switchDir = (d: Dir) => {
        setDir(d);
        setSelected(new Set());
    };

    // ------------------------------------------------ Load mutuals

    const loadOne = (r: RequestEntry) => {
        mutualCache.delete(r.id);
        loadMutual(r.id)
            .then(res => res === "error" && showToast("Could not load profile", "failure"))
            .finally(() => setMutualVersion(v => v + 1));
    };

    const loadAll = () => job.run(async ({ token, progress, onRateLimit }) => {
        const list = unloaded;
        let failed = 0;
        for (let i = 0; i < list.length; i++) {
            progress(i, list.length, `Loading profile of ${list[i].name} ...`);
            mutualCache.delete(list[i].id);
            if (await loadMutual(list[i].id, token, onRateLimit) === "error") failed++;
            if (i % 3 === 2) setMutualVersion(v => v + 1);
        }
        setMutualVersion(v => v + 1);
        return `Loaded ${list.length - failed} profiles${failed ? `, ${failed} failed` : ""}.`;
    });

    // ------------------------------------------------ Actions

    const single = (r: RequestEntry, accept: boolean) => {
        const p = accept ? acceptRequest(r.id) : removeRequest(r.id);
        p.then(() => {
            setSel(r.id, false);
            showToast(accept ? `Accepted ${r.name}` : r.incoming ? `Ignored request from ${r.name}` : `Withdrew request to ${r.name}`, "success");
        }).catch(e => showToast(`Action failed: ${describeError(e)}`, "failure"));
    };

    const bulk = (accept: boolean) => {
        const list = selectedEntries;
        if (!list.length) return;
        const verb = accept ? "accept" : dir === "in" ? "ignore" : "withdraw";
        const seconds = Math.ceil(list.length * INTERVAL.relationship / 1000);
        openConfirm({
            title: `${verb[0].toUpperCase()}${verb.slice(1)} ${list.length} requests?`,
            text: (
                <>
                    {accept
                        ? <div>Everyone listed below will be added to your friends.</div>
                        : <div>The requests will be removed. These people won't be notified, but they can send you a request again.</div>}
                    <div className={cl("muted")}>Throttled to ~1 action / {INTERVAL.relationship / 1000} s, takes about {seconds} s. Can be cancelled at any time.</div>
                </>
            ),
            items: list.map(toItem),
            confirmText: `${verb[0].toUpperCase()}${verb.slice(1)} ${list.length}`,
            danger: !accept,
            onConfirm: () => job.run(async ({ token, progress, onRateLimit }) => {
                let ok = 0, failed = 0;
                for (let i = 0; i < list.length; i++) {
                    progress(i, list.length, `Working on ${list[i].name} ...`);
                    try {
                        if (accept) await acceptRequest(list[i].id, token, onRateLimit);
                        else await removeRequest(list[i].id, token, onRateLimit);
                        ok++;
                        setSel(list[i].id, false);
                    } catch (e) {
                        if (isCancelled(e)) throw e;
                        failed++;
                    }
                }
                progress(list.length, list.length, "Done");
                if (failed) showToast(`${failed} requests failed`, "failure");
                return `${ok} requests ${accept ? "accepted" : dir === "in" ? "ignored" : "withdrawn"}${failed ? `, ${failed} failed` : ""}.`;
            })
        });
    };

    const young = current.filter(r => r.ageDays < spamAccountDays).length;
    const noAvatar = current.filter(r => r.noAvatar).length;
    const suspicious = current.filter(r => r.score >= 60).length;

    return (
        <div className={cl("tab")}>
            <div className={cl("toolbar")}>
                <Segmented<Dir> value={dir} onChange={switchDir} options={[
                    { value: "in", label: `Incoming · ${incoming.length}` },
                    { value: "out", label: `Outgoing · ${outgoing.length}` }
                ]} />
                <span className={cl("spacer")} />
                <QueueBadge />
            </div>

            <div className={cl("quick")}>
                <div className={cl("quick-card")}>
                    <Icon name="warning" size={20} />
                    <div className={cl("quick-body")}>
                        <b>{suspicious} suspicious</b>
                        <span className={cl("muted")}>Spam score ≥ 60</span>
                    </div>
                    <Button small variant="ghost" disabled={!suspicious} onClick={() => addSel(current.filter(r => r.score >= 60), "Score ≥ 60")}>Select</Button>
                </div>
                <div className={cl("quick-card")}>
                    <Icon name="person" size={20} />
                    <div className={cl("quick-body")}>
                        <b>{young} new accounts</b>
                        <span className={cl("muted")}>{noAvatar} without avatar</span>
                    </div>
                </div>
                <div className={cl("quick-card")}>
                    <Icon name="group" size={20} />
                    <div className={cl("quick-body")}>
                        <b>{current.length - unloaded.length}/{current.length} checked</b>
                        <span className={cl("muted")}>Mutuals</span>
                    </div>
                    <Button small variant="ghost" icon="refresh" disabled={busy || !unloaded.length} onClick={loadAll}
                        title={`~${Math.ceil(unloaded.length * INTERVAL.profile / 1000)} s, throttled`}>
                        {unloaded.length ? `Load ${unloaded.length}` : "All loaded"}
                    </Button>
                </div>
            </div>

            <JobBar job={job} />

            <div className={cl("toolbar")}>
                <div className={cl("search")}>
                    <Icon name="search" size={16} />
                    <input className={cl("search-input")} placeholder="Name, username or ID ..." value={query} onChange={e => setQuery(e.currentTarget.value)} />
                </div>
                <Segmented<Sort> value={sort} options={SORTS} onChange={setSort} />
            </div>

            <div className={cl("filterbox")}>
                <span className={cl("filter-title")}>Select by filter</span>
                <button className={cl("chip-btn")} onClick={() => addSel(current.filter(r => r.mutual && r.mutual !== "error" && mutualTotal(r.mutual) === 0), "without mutuals")}
                    title="Only requests whose mutuals are already loaded">
                    All without mutual friends/servers
                </button>
                <span className={cl("chip-group")}>
                    <button className={cl("chip-btn")} onClick={() => addSel(current.filter(r => r.ageDays < youngerThan), `younger than ${youngerThan} days`)}>Accounts younger than</button>
                    <NumberField value={youngerThan} min={1} max={3650} onChange={setYoungerThan} suffix="days" />
                </span>
                <span className={cl("chip-group")}>
                    <select className={cl("select")} value={guildFilter} onChange={e => setGuildFilter(e.currentTarget.value)} disabled={!guildOptions.length}>
                        <option value="">{guildOptions.length ? "Select server ..." : "Server: load mutuals first"}</option>
                        {guildOptions.map(g => <option key={g.id} value={g.id}>{g.name} ({g.n})</option>)}
                    </select>
                    <button className={cl("chip-btn")} disabled={!guildFilter}
                        onClick={() => addSel(current.filter(r => r.mutual && r.mutual !== "error" && r.mutual.guilds.some(g => g.id === guildFilter)), `from ${guildName(guildFilter)}`)}>
                        All from this server
                    </button>
                </span>
            </div>

            <div className={cl("selbar")}>
                <span className={cl("muted")}>{selectedEntries.length} selected</span>
                <button className={cl("link")} onClick={() => setSelected(new Set(visible.map(r => r.id)))}>Select visible</button>
                <button className={cl("link")} onClick={() => setSelected(new Set())}>Clear selection</button>
                <span className={cl("spacer")} />
                {dir === "in" && (
                    <Button small variant="success" icon="check" disabled={!selectedEntries.length || busy} onClick={() => bulk(true)}>
                        Accept ({selectedEntries.length})
                    </Button>
                )}
                <Button small variant="danger" icon="close" disabled={!selectedEntries.length || busy} onClick={() => bulk(false)}>
                    {dir === "in" ? "Ignore" : "Withdraw"} ({selectedEntries.length})
                </Button>
            </div>

            {dir === "in" && unloaded.length > 0 && current.length > 0 && (
                <Notice tone="info">
                    “No mutuals” only counts toward the spam score once the profiles are loaded. This only happens on click and is throttled (~1 profile / {INTERVAL.profile / 1000} s).
                </Notice>
            )}

            <div className={cl("list")}>
                {visible.map(r => (
                    <RequestRow
                        key={r.id}
                        r={r}
                        busy={busy}
                        selected={selected.has(r.id)}
                        onSelect={v => setSel(r.id, v)}
                        onAccept={() => single(r, true)}
                        onRemove={() => single(r, false)}
                        onLoad={() => loadOne(r)}
                    />
                ))}
                {!visible.length && <div className={cl("empty")}>{current.length ? "No matches." : dir === "in" ? "No pending requests." : "No outgoing requests."}</div>}
            </div>
            <div className={cl("muted")}>Accounts younger than {spamAccountDays} days are highlighted in yellow. Request date according to Discord (RelationshipStore).</div>
        </div>
    );
}
