/*
 * ServerDeclutter – Overview window: table of all servers, filters, suggestions and (bulk) actions
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import ErrorBoundary from "@components/ErrorBoundary";
import { classes } from "@utils/misc";
import { ConfirmModal, GuildReadStateStore, GuildStore, Modal, NavigationRouter, openModal, showToast, SortedGuildStore, Toasts, useEffect, useMemo, UserGuildSettingsStore, useState } from "@webpack/common";
import type { ReactNode } from "react";

import { BulkResult, canWriteFolders, describeError, isOwnedGuild, leaveGuild, markGuildRead, moveToFolder, runBulk, setGuildMuted } from "./actions";
import { Button, cl, GuildIcon, Icon, IconButton, IconName, LogEntry, Notice, ProgressBar, useJob } from "./components";
import { buildRows, buildSuggestions, FilterId, filterLabel, FILTERS, formatDate, GuildRow, matchesFilter, relative, SortKey, sortRows } from "./data";
import { settings } from "./index";
import { getActivity, onActivityChange } from "./store";

type ActionKind = "mute" | "unmute" | "read" | "archive" | "leave";

// ---------------------------------------------------------------- Data hook

/** Recompute rows when relevant stores change (debounced) */
function useRows() {
    const [tick, setTick] = useState(0);

    useEffect(() => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const bump = () => {
            if (timer) return;
            timer = setTimeout(() => {
                timer = undefined;
                setTick(t => t + 1);
            }, 600);
        };
        const stores = [GuildStore, UserGuildSettingsStore, GuildReadStateStore, SortedGuildStore] as any[];
        stores.forEach(s => s?.addChangeListener?.(bump));
        const offActivity = onActivityChange(bump);
        return () => {
            clearTimeout(timer);
            stores.forEach(s => s?.removeChangeListener?.(bump));
            offActivity();
        };
    }, []);

    const rows = useMemo(() => {
        try {
            return buildRows();
        } catch (e) {
            showToast(`Server list could not be read: ${describeError(e)}`, Toasts.Type.FAILURE);
            return [];
        }
    }, [tick]);

    return { rows, refresh: () => setTick(t => t + 1) };
}

// ---------------------------------------------------------------- Confirmations

function NameList({ rows }: { rows: GuildRow[]; }) {
    const shown = rows.slice(0, 40);
    return (
        <div className={cl("confirm-list")}>
            {shown.map(r => (
                <div key={r.id} className={cl("confirm-item")}>
                    <GuildIcon id={r.id} icon={r.icon} name={r.name} size={20} />
                    <span>{r.name}</span>
                </div>
            ))}
            {rows.length > shown.length && <div className={cl("muted")}>… and {rows.length - shown.length} more</div>}
        </div>
    );
}

function confirm(opts: { title: string; subtitle?: string; confirmText: string; danger?: boolean; children?: ReactNode; }) {
    return new Promise<boolean>(resolve => {
        let done = false;
        const finish = (v: boolean) => {
            if (done) return;
            done = true;
            resolve(v);
        };
        openModal(props => (
            <ConfirmModal
                {...props}
                title={opts.title}
                subtitle={opts.subtitle}
                confirmText={opts.confirmText}
                cancelText="Cancel"
                variant={opts.danger ? "critical-primary" : "primary"}
                onConfirm={() => finish(true)}
                onCancel={() => finish(false)}
                onCloseCallback={() => finish(false)}
            >
                <ErrorBoundary noop>{opts.children}</ErrorBoundary>
            </ConfirmModal>
        ));
    });
}

const ACTION_INFO: Record<ActionKind, { title: string; verb: string; icon: IconName; }> = {
    mute: { title: "Mute", verb: "muted", icon: "bellOff" },
    unmute: { title: "Unmute", verb: "unmuted", icon: "bell" },
    read: { title: "Mark all as read", verb: "marked as read", icon: "check" },
    archive: { title: "Move to archive folder", verb: "moved", icon: "folder" },
    leave: { title: "Leave server", verb: "left", icon: "leave" }
};

/** Which of the selected servers the action applies to at all */
function applicable(kind: ActionKind, rows: GuildRow[], archiveName: string) {
    switch (kind) {
        case "mute": return rows.filter(r => !r.muted);
        case "unmute": return rows.filter(r => r.muted);
        case "read": return rows.filter(r => r.unreadChannels > 0 || r.mentions > 0);
        case "archive": return rows.filter(r => r.folderName !== archiveName);
        case "leave": return rows.filter(r => !r.owner && !isOwnedGuild(r.id));
    }
}

// ---------------------------------------------------------------- Table

const COLUMNS: { key: SortKey; label: string; title?: string; num?: boolean; }[] = [
    { key: "name", label: "Server" },
    { key: "members", label: "Members", num: true },
    { key: "joined", label: "Joined" },
    { key: "opened", label: "Last opened", title: "Tracked since installation. \"~\" = estimate from Discord's read state (newest read message)" },
    { key: "wrote", label: "Last written", title: "Tracked since installation" },
    { key: "activity", label: "Server activity", title: "Age of the newest message in a channel visible to you" },
    { key: "muted", label: "Muted" },
    { key: "unread", label: "Unread" },
    { key: "folder", label: "Folder" }
];

function Row({ r, selected, onToggle, onAction, onOpen, busy, deadDays }: {
    r: GuildRow;
    selected: boolean;
    onToggle(): void;
    onAction(kind: ActionKind, ids: string[]): void;
    onOpen(): void;
    busy: boolean;
    deadDays: number;
}) {
    const dead = (r.lastActivity ?? 0) < Date.now() - deadDays * 86400_000;
    return (
        <tr className={classes(selected && cl("row-selected"))} onClick={onToggle}>
            <td className={cl("col-check")}>
                <input type="checkbox" checked={selected} onChange={onToggle} onClick={e => e.stopPropagation()} />
            </td>
            <td>
                <div className={cl("name-cell")}>
                    <button className={cl("icon-link")} title="Open server" onClick={e => { e.stopPropagation(); onOpen(); }}>
                        <GuildIcon id={r.id} icon={r.icon} name={r.name} />
                    </button>
                    <span className={cl("name")} title={r.name}>{r.name}</span>
                    {r.owner && <span className={classes(cl("badge"), cl("badge-owner"))} title="Your server"><Icon name="crown" size={12} /></span>}
                </div>
            </td>
            <td className={cl("num")}>{r.memberCount != null ? r.memberCount.toLocaleString() : "–"}</td>
            <td title={r.joinedAt ? new Date(r.joinedAt).toLocaleString() : undefined}>{formatDate(r.joinedAt)}</td>
            <td title={r.opened ? new Date(r.opened).toLocaleString() : r.readEstimate ? `Estimated: newest read message from ${new Date(r.readEstimate).toLocaleString()}` : "Never opened since tracking began"}>
                {r.opened
                    ? relative(r.opened)
                    : r.readEstimate
                        ? <span className={cl("muted")}>~ {relative(r.readEstimate)}</span>
                        : <span className={cl("muted")}>never</span>}
            </td>
            <td title={r.wrote ? new Date(r.wrote).toLocaleString() : undefined}>
                {r.wrote ? relative(r.wrote) : <span className={cl("muted")}>–</span>}
            </td>
            <td title={r.lastActivity ? new Date(r.lastActivity).toLocaleString() : "No message known"}>
                <span className={classes(dead && cl("text-bad"))}>{r.lastActivity ? relative(r.lastActivity) : "unknown"}</span>
            </td>
            <td>{r.muted ? <span className={cl("badge")}>muted</span> : <span className={cl("muted")}>–</span>}</td>
            <td>
                <div className={cl("unread-cell")}>
                    {r.mentions > 0 && <span className={classes(cl("badge"), cl("badge-mention"))} title="Mentions">@{r.mentions}</span>}
                    {r.unreadChannels > 0
                        ? <span title="Channels with unread messages">{r.unreadChannels}</span>
                        : r.mentions === 0 && <span className={cl("muted")}>–</span>}
                </div>
            </td>
            <td className={cl("folder")} title={r.folderName ?? undefined}>{r.folderName ?? <span className={cl("muted")}>–</span>}</td>
            <td className={cl("col-actions")}>
                <div className={cl("row-actions")}>
                    <IconButton disabled={busy} icon={r.muted ? "bell" : "bellOff"} title={r.muted ? "Unmute" : "Mute"} onClick={() => onAction(r.muted ? "unmute" : "mute", [r.id])} />
                    <IconButton disabled={busy || (r.unreadChannels === 0 && r.mentions === 0)} icon="check" title="Mark as read" onClick={() => onAction("read", [r.id])} />
                    <IconButton disabled={busy} icon="folder" title="Move to archive folder" onClick={() => onAction("archive", [r.id])} />
                    <IconButton disabled={busy || r.owner} icon="leave" danger title={r.owner ? "You cannot leave servers you own" : "Leave server"} onClick={() => onAction("leave", [r.id])} />
                </div>
            </td>
        </tr>
    );
}

function LogList({ entries }: { entries: LogEntry[]; }) {
    if (!entries.length) return null;
    return (
        <div className={cl("log")}>
            {entries.map(e => <div key={e.id} className={cl(`log-${e.kind}`)}>{e.text}</div>)}
        </div>
    );
}

// ---------------------------------------------------------------- Window

function DeclutterPanel({ onCloseModal, initialGuildId }: { onCloseModal(): void; initialGuildId?: string; }) {
    const { staleDays, deadDays, archiveFolderName, requestInterval, leaveInterval } = settings.use(["staleDays", "deadDays", "archiveFolderName", "requestInterval", "leaveInterval"]);
    const thresholds = { staleDays, deadDays };
    const archiveName = archiveFolderName?.trim() || "Archive";
    const { rows, refresh } = useRows();
    const [filter, setFilter] = useState<FilterId>("all");
    const [search, setSearch] = useState("");
    const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1; }>({ key: "opened", dir: 1 });
    const [selected, setSelected] = useState<Set<string>>(() => new Set(initialGuildId ? [initialGuildId] : []));
    const job = useJob();
    const folderWritable = useMemo(() => canWriteFolders(), []);
    const { since } = getActivity();

    const suggestions = useMemo(() => buildSuggestions(rows, thresholds, since), [rows, staleDays, deadDays, since]);

    const visible = useMemo(() => {
        const q = search.trim().toLowerCase();
        const now = Date.now();
        const list = rows.filter(r => matchesFilter(r, filter, thresholds, now) && (!q || r.name.toLowerCase().includes(q) || r.folderName?.toLowerCase().includes(q)));
        return sortRows(list, sort.key, sort.dir);
    }, [rows, filter, search, sort, staleDays, deadDays]);

    // Remove servers that no longer exist (e.g. left) from the selection
    useEffect(() => {
        setSelected(sel => {
            const ids = new Set(rows.map(r => r.id));
            const next = new Set([...sel].filter(id => ids.has(id)));
            return next.size === sel.size ? sel : next;
        });
    }, [rows]);

    const selectedRows = rows.filter(r => selected.has(r.id));
    const allVisibleSelected = visible.length > 0 && visible.every(r => selected.has(r.id));

    const toggle = (id: string) => setSelected(sel => {
        const next = new Set(sel);
        next.has(id) ? next.delete(id) : next.add(id);
        return next;
    });

    const toggleAllVisible = () => setSelected(sel => {
        const next = new Set(sel);
        if (allVisibleSelected) visible.forEach(r => next.delete(r.id));
        else visible.forEach(r => next.add(r.id));
        return next;
    });

    const sortBy = (key: SortKey) => setSort(s => s.key === key ? { key, dir: s.dir === 1 ? -1 : 1 } : { key, dir: key === "name" || key === "folder" ? 1 : -1 });

    const openGuild = (id: string) => {
        onCloseModal();
        NavigationRouter.transitionToGuild(id);
    };

    // ---------------------------------------------------------------- Actions

    async function runAction(kind: ActionKind, ids: string[]) {
        if (job.state.running) return;
        const info = ACTION_INFO[kind];
        const chosen = rows.filter(r => ids.includes(r.id));
        const targets = applicable(kind, chosen, archiveName);
        const skipped = chosen.length - targets.length;

        if (!targets.length) {
            showToast(kind === "leave" ? "You cannot leave servers you own" : "None of the selected servers need this action", Toasts.Type.MESSAGE);
            return;
        }

        const interval = kind === "leave" ? Math.max(2000, leaveInterval) : Math.max(1000, requestInterval);
        const eta = kind === "archive" ? "" : ` Takes about ${Math.ceil(targets.length * interval / 1000)} s (throttled).`;
        const skippedText = skipped ? ` ${skipped} selected ${skipped === 1 ? "server is" : "servers are"} skipped${kind === "leave" ? " (owned servers)" : ""}.` : "";

        const ok = await confirm({
            title: `${info.title}: ${targets.length} ${targets.length === 1 ? "server" : "servers"}`,
            subtitle: kind === "archive"
                ? `The servers will be moved to the folder "${archiveName}" (created if necessary).${skippedText}`
                : kind === "leave"
                    ? `You are about to leave these servers. You will need a new invite to rejoin.${skippedText}${eta}`
                    : `The following servers will be ${info.verb}.${skippedText}${eta}`,
            confirmText: kind === "leave" ? "Continue …" : info.title,
            danger: kind === "leave",
            children: <NameList rows={targets} />
        });
        if (!ok) return;

        if (kind === "leave") {
            const sure = await confirm({
                title: `Really leave ${targets.length} ${targets.length === 1 ? "server" : "servers"}?`,
                subtitle: "Last warning – this cannot be undone.",
                confirmText: `Leave for good (${targets.length})`,
                danger: true,
                children: <NameList rows={targets} />
            });
            if (!sure) return;
        }

        const ids2 = targets.map(r => r.id);

        if (kind === "archive") {
            await job.run(info.title, 1, async (_token, hooks) => {
                hooks.onProgress({ done: 0, total: 1, label: `Saving folder "${archiveName}" …` });
                try {
                    await moveToFolder(ids2, archiveName);
                    hooks.onProgress({ done: 1, total: 1, label: "Done" });
                    showToast(`${ids2.length} ${ids2.length === 1 ? "server" : "servers"} moved to "${archiveName}"`, Toasts.Type.SUCCESS);
                } catch (e) {
                    hooks.onLog("error", describeError(e));
                    showToast(`Move failed: ${describeError(e)}`, Toasts.Type.FAILURE);
                }
            });
            refresh();
            return;
        }

        const worker = (id: string): Promise<unknown> => {
            switch (kind) {
                case "mute": return setGuildMuted(id, true);
                case "unmute": return setGuildMuted(id, false);
                case "read": return Promise.resolve(markGuildRead(id));
                case "leave": return leaveGuild(id);
            }
        };

        let result: BulkResult | null = null;
        try {
            result = await job.run(info.title, ids2.length, (token, hooks) => runBulk(ids2, worker, { token, interval, ...hooks }));
        } catch (e) {
            showToast(`${info.title} failed: ${describeError(e)}`, Toasts.Type.FAILURE);
        }
        refresh();
        if (!result) return;

        const parts = [`${result.ok.length} ${info.verb}`];
        if (result.failed.length) parts.push(`${result.failed.length} failed`);
        if (result.cancelled) parts.push("cancelled");
        showToast(`${info.title}: ${parts.join(", ")}`, result.failed.length ? Toasts.Type.FAILURE : Toasts.Type.SUCCESS);
        if (kind === "leave") setSelected(new Set());
    }

    const busy = job.state.running;
    const bulkIds = [...selected];

    return (
        <div className={cl("modal")}>
            <Notice tone="info">
                "Last opened" and "Last written" have only been tracked locally <b>since {new Date(since).toLocaleDateString()}</b> (installation or last reset).
                Older values marked with "~" are estimates from Discord's read state; server activity comes from the newest known message.
            </Notice>

            {suggestions.length > 0 && (
                <div className={cl("suggestions")}>
                    {suggestions.map(s => (
                        <button
                            key={s.filter}
                            className={classes(cl("suggestion"), cl(`suggestion-${s.tone}`), filter === s.filter && cl("suggestion-active"))}
                            onClick={() => setFilter(f => f === s.filter ? "all" : s.filter)}
                        >
                            <span className={cl("suggestion-count")}>{s.count}</span>
                            <span>{s.text.replace(/^\d+\s/, "")}</span>
                        </button>
                    ))}
                </div>
            )}

            <div className={cl("toolbar")}>
                <label className={cl("search")}>
                    <Icon name="search" size={16} />
                    <input placeholder="Search servers or folders …" value={search} onChange={e => setSearch(e.currentTarget.value)} />
                    {search && <IconButton icon="close" title="Clear search" onClick={() => setSearch("")} />}
                </label>
                <div className={cl("chips")}>
                    {FILTERS.map(f => (
                        <button key={f} className={classes(cl("chip"), filter === f && cl("chip-active"))} onClick={() => setFilter(f)}>
                            {filterLabel(f, thresholds)}
                            <span className={cl("chip-count")}>{f === "all" ? rows.length : rows.filter(r => matchesFilter(r, f, thresholds)).length}</span>
                        </button>
                    ))}
                </div>
            </div>

            <div className={classes(cl("bulkbar"), selected.size > 0 && cl("bulkbar-active"))}>
                <span className={cl("bulk-count")}>{selected.size ? `${selected.size} selected` : `${visible.length} of ${rows.length} servers`}</span>
                {selected.size > 0 && <button className={cl("link")} onClick={() => setSelected(new Set())}>Clear selection</button>}
                <span className={cl("spacer")} />
                <Button small variant="ghost" icon="bellOff" disabled={busy || !selected.size} onClick={() => runAction("mute", bulkIds)}>Mute</Button>
                <Button small variant="ghost" icon="bell" disabled={busy || !selected.size} onClick={() => runAction("unmute", bulkIds)}>Unmute</Button>
                <Button small variant="ghost" icon="check" disabled={busy || !selected.size} onClick={() => runAction("read", bulkIds)}>Read</Button>
                <Button small variant="ghost" icon="folder" disabled={busy || !selected.size || !folderWritable} title={folderWritable ? undefined : "Server folders cannot be written in this Discord version"} onClick={() => runAction("archive", bulkIds)}>
                    &quot;{archiveName}&quot;
                </Button>
                <Button small variant="danger" icon="leave" disabled={busy || !selected.size} onClick={() => runAction("leave", bulkIds)}>Leave</Button>
                <IconButton icon="refresh" title="Reload" onClick={refresh} />
            </div>

            {(busy || job.state.log.length > 0) && (
                <div className={cl("job")}>
                    <div className={cl("job-head")}>
                        <b>{job.state.title}</b>
                        <span className={cl("spacer")} />
                        {busy
                            ? <Button small variant="danger" icon="stop" onClick={job.cancel}>Cancel</Button>
                            : <Button small variant="ghost" icon="close" onClick={job.clearLog}>Close</Button>}
                    </div>
                    {busy && <ProgressBar done={job.state.done} total={job.state.total} label={job.state.label} />}
                    <LogList entries={job.state.log.filter(e => e.kind !== "ok")} />
                </div>
            )}

            <div className={cl("table-wrap")}>
                <table className={cl("table")}>
                    <thead>
                        <tr>
                            <th className={cl("col-check")}>
                                <input type="checkbox" checked={allVisibleSelected} onChange={toggleAllVisible} title="Select all visible" />
                            </th>
                            {COLUMNS.map(c => (
                                <th key={c.key} className={classes(c.num && cl("num"), sort.key === c.key && cl("th-active"))} title={c.title} onClick={() => sortBy(c.key)}>
                                    <span className={cl("th")}>
                                        {c.label}
                                        {sort.key === c.key && <Icon name={sort.dir === 1 ? "arrowUp" : "arrowDown"} size={14} />}
                                    </span>
                                </th>
                            ))}
                            <th className={cl("col-actions")} />
                        </tr>
                    </thead>
                    <tbody>
                        {visible.map(r => (
                            <Row
                                key={r.id}
                                r={r}
                                selected={selected.has(r.id)}
                                onToggle={() => toggle(r.id)}
                                onAction={runAction}
                                onOpen={() => openGuild(r.id)}
                                busy={busy}
                                deadDays={deadDays}
                            />
                        ))}
                    </tbody>
                </table>
                {visible.length === 0 && <div className={cl("empty")}>No servers match this filter.</div>}
            </div>

            {!folderWritable && (
                <Notice tone="warn">Server folders cannot be written in this Discord version – "Move to archive" is disabled.</Notice>
            )}
        </div>
    );
}

export function openDeclutterModal(guildId?: string) {
    openModal(props => (
        <Modal {...props} size="xl" title="Declutter servers" subtitle="Overview of all servers – mute, archive or leave">
            <ErrorBoundary>
                <DeclutterPanel initialGuildId={guildId} onCloseModal={props.onClose} />
            </ErrorBoundary>
        </Modal>
    ));
}
