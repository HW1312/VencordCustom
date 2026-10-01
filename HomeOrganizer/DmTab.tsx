/*
 * HomeOrganizer – "DMs" tab: automatically categorize and tidy up open direct messages
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { classes } from "@utils/misc";
import {
    ChannelStore, NavigationRouter, PrivateChannelSortStore, ReadStateStore, showToast,
    Toasts, useMemo, UserStore, useState, useStateFromStores
} from "@webpack/common";

import { Avatar, Button, Checkbox, Chip, cl, ConfirmItem, Icon, JobBar, Notice, openConfirm, QueueBadge, Segmented, useJob } from "./components";
import { closeDm, collectDms, DM_GROUPS, DmEntry, DmGroup, formatDate, leaveGroup, relative, toggleProtected } from "./data";
import { settings } from "./index";
import { describeError, isCancelled } from "./queue";

type GroupFilter = "all" | DmGroup;

const sameDms = (a: DmEntry[], b: DmEntry[]) =>
    a.length === b.length && a.every((x, i) => {
        const y = b[i];
        return x.id === y.id && x.lastTs === y.lastTs && x.mentions === y.mentions && x.unread === y.unread
            && x.protected === y.protected && x.name === y.name && x.pinnedIn === y.pinnedIn;
    });

const toItem = (d: DmEntry): ConfirmItem => ({ id: d.id, name: d.name, avatar: d.avatar, detail: d.lastTs ? relative(d.lastTs) : "no messages" });

// ---------------------------------------------------------------- Row

function DmRow({ dm, selected, onSelect, onOpen }: { dm: DmEntry; selected: boolean; onSelect(v: boolean): void; onOpen(): void; }) {
    const selectable = !dm.isGroup && !dm.protected;

    const leave = () => openConfirm({
        title: "Leave group?",
        text: (
            <Notice tone="danger">
                You are about to <b>leave</b> the group “{dm.name}”. For group DMs, closing always means leaving - you can only
                come back if someone adds you to the group again.
            </Notice>
        ),
        items: [toItem(dm)],
        confirmText: "Leave group",
        onConfirm: () => leaveGroup(dm.id)
            .then(() => showToast(`Left “${dm.name}”`, Toasts.Type.SUCCESS))
            .catch(e => showToast(`Failed to leave: ${describeError(e)}`, Toasts.Type.FAILURE))
    });

    return (
        <div className={classes(cl("item"), selected && cl("item-selected"))} onClick={() => selectable && onSelect(!selected)}>
            <Checkbox
                checked={selected}
                disabled={!selectable}
                onChange={onSelect}
                title={dm.isGroup ? "Groups are excluded from bulk actions" : dm.protected ? "Protected" : undefined}
            />
            <Avatar src={dm.avatar} name={dm.name} />
            <div className={cl("item-main")}>
                <div className={cl("item-title")}>
                    <span className={cl("ellipsis")}>{dm.name}</span>
                    {dm.mentions > 0
                        ? <span className={cl("unread")}>{dm.mentions > 99 ? "99+" : dm.mentions}</span>
                        : dm.unread && <span className={cl("unread-dot")} title="Unread" />}
                </div>
                <div className={cl("item-sub")}>
                    {dm.sub && <span className={cl("ellipsis")}>{dm.sub}</span>}
                    {dm.pinnedIn != null && <Chip tone="info" title="In a PinDMs category"><Icon name="pin" size={11} /> {dm.pinnedIn || "Pinned"}</Chip>}
                    {dm.protected && <Chip tone="good">Protected</Chip>}
                </div>
            </div>
            <div className={cl("item-date")} title={dm.lastTs ? new Date(dm.lastTs).toLocaleString() : "No messages"}>
                <span>{relative(dm.lastTs)}</span>
                <span className={cl("muted")}>{formatDate(dm.lastTs)}</span>
            </div>
            <div className={cl("item-actions")} onClick={e => e.stopPropagation()}>
                <Button small variant="ghost" icon="open" onClick={onOpen}>Open</Button>
                <button
                    className={classes(cl("icon-btn"), dm.protected && cl("icon-btn-on"))}
                    title={dm.protected ? "Remove protection (PinDMs pins stay protected)" : "Never close"}
                    onClick={() => toggleProtected(dm.id)}
                >
                    <Icon name="shield" size={16} />
                </button>
                {dm.isGroup && <Button small variant="danger" icon="leave" onClick={leave}>Leave</Button>}
            </div>
        </div>
    );
}

// ---------------------------------------------------------------- Tab

export function DmTab({ onClose }: { onClose(): void; }) {
    const { activeDays, quietDays, protectedIds, protectPinned } = settings.use(["activeDays", "quietDays", "protectedIds", "protectPinned"]);
    const dms = useStateFromStores(
        [ChannelStore, PrivateChannelSortStore, ReadStateStore, UserStore],
        collectDms,
        [activeDays, quietDays, protectedIds, protectPinned],
        sameDms
    );

    const [filter, setFilter] = useState<GroupFilter>("all");
    const [query, setQuery] = useState("");
    const [unreadOnly, setUnreadOnly] = useState(false);
    const [selected, setSelected] = useState<Set<string>>(() => new Set());
    const job = useJob();

    const counts = useMemo(() => {
        const c: Record<string, number> = {};
        for (const d of dms) c[d.group] = (c[d.group] ?? 0) + 1;
        return c;
    }, [dms]);

    const visible = useMemo(() => {
        const q = query.trim().toLowerCase();
        return dms.filter(d =>
            (filter === "all" || d.group === filter)
            && (!unreadOnly || d.unread || d.mentions > 0)
            && (!q || d.name.toLowerCase().includes(q) || d.sub.toLowerCase().includes(q) || d.userId === q || d.id === q)
        );
    }, [dms, filter, query, unreadOnly]);

    // Clean up selection: closed / protected / group DMs are dropped
    const selectable = useMemo(() => new Map(dms.filter(d => !d.isGroup && !d.protected).map(d => [d.id, d])), [dms]);
    const selectedEntries = [...selected].map(id => selectable.get(id)).filter(Boolean) as DmEntry[];

    const setSel = (id: string, v: boolean) => setSelected(s => {
        const n = new Set(s);
        if (v) n.add(id); else n.delete(id);
        return n;
    });

    const open = (dm: DmEntry) => {
        NavigationRouter.transitionTo(`/channels/@me/${dm.id}`);
        onClose();
    };

    function runClose(entries: DmEntry[], what: string) {
        const list = entries.filter(d => !d.isGroup && !d.protected);
        if (!list.length) return showToast("Nothing to close", Toasts.Type.MESSAGE);

        openConfirm({
            title: `Close ${list.length} DMs?`,
            text: (
                <>
                    <div>{what} - the history is kept; the DMs only disappear from your list and reappear when a new message arrives.</div>
                    <div className={cl("muted")}>Groups, PinDMs pins and protected DMs are excluded. Throttled to ~1/s, takes about {list.length} s.</div>
                </>
            ),
            items: list.map(toItem),
            confirmText: `Close ${list.length}`,
            onConfirm: () => job.run(async ({ token, progress, onRateLimit }) => {
                let ok = 0, failed = 0;
                for (let i = 0; i < list.length; i++) {
                    progress(i, list.length, `Closing “${list[i].name}” ...`);
                    try {
                        await closeDm(list[i], token, onRateLimit);
                        ok++;
                        setSel(list[i].id, false);
                    } catch (e) {
                        if (isCancelled(e)) throw e;
                        failed++;
                    }
                }
                progress(list.length, list.length, "Done");
                if (failed) showToast(`${failed} DMs could not be closed`, Toasts.Type.FAILURE);
                return `Closed ${ok} DMs${failed ? `, ${failed} failed` : ""}.`;
            })
        });
    }

    const asleep = dms.filter(d => d.group === "asleep" && !d.protected);
    const never = dms.filter(d => d.group === "never" && !d.protected);
    const protectedCount = dms.filter(d => d.protected).length;

    const filterOptions: { value: GroupFilter; label: string; }[] = [
        { value: "all", label: `All · ${dms.length}` },
        ...DM_GROUPS.map(g => ({ value: g.id as GroupFilter, label: `${g.label} · ${counts[g.id] ?? 0}` }))
    ];

    return (
        <div className={cl("tab")}>
            <div className={cl("quick")}>
                <div className={cl("quick-card")}>
                    <Icon name="moon" size={20} />
                    <div className={cl("quick-body")}>
                        <b>{asleep.length} dormant</b>
                        <span className={cl("muted")}>silent for more than {quietDays} days</span>
                    </div>
                    <Button small variant="danger" disabled={!asleep.length || job.state.running} onClick={() => runClose(asleep, "All dormant DMs")}>Close all</Button>
                </div>
                <div className={cl("quick-card")}>
                    <Icon name="chat" size={20} />
                    <div className={cl("quick-body")}>
                        <b>{never.length} without messages</b>
                        <span className={cl("muted")}>never messaged</span>
                    </div>
                    <Button small variant="danger" disabled={!never.length || job.state.running} onClick={() => runClose(never, "All DMs without messages")}>Close all</Button>
                </div>
                <div className={cl("quick-card")}>
                    <Icon name="shield" size={20} />
                    <div className={cl("quick-body")}>
                        <b>{protectedCount} protected</b>
                        <span className={cl("muted")}>{protectPinned ? "incl. PinDMs pins" : "own list only"}</span>
                    </div>
                </div>
            </div>

            <JobBar job={job} />

            <div className={cl("toolbar")}>
                <div className={cl("search")}>
                    <Icon name="search" size={16} />
                    <input className={cl("search-input")} placeholder="Name, username or ID ..." value={query} onChange={e => setQuery(e.currentTarget.value)} />
                </div>
                <label className={cl("inline-check")}>
                    <Checkbox checked={unreadOnly} onChange={setUnreadOnly} /> unread only
                </label>
                <QueueBadge />
            </div>
            <Segmented<GroupFilter> value={filter} options={filterOptions} onChange={setFilter} />

            <div className={cl("selbar")}>
                <span className={cl("muted")}>{selectedEntries.length} selected</span>
                <button className={cl("link")} onClick={() => setSelected(new Set(visible.filter(d => selectable.has(d.id)).map(d => d.id)))}>Select visible</button>
                <button className={cl("link")} onClick={() => setSelected(new Set())}>Clear selection</button>
                <span className={cl("spacer")} />
                <Button small variant="danger" icon="close" disabled={!selectedEntries.length || job.state.running} onClick={() => runClose(selectedEntries, "The selected DMs")}>
                    Close selected ({selectedEntries.length})
                </Button>
            </div>

            <div className={cl("list")}>
                {DM_GROUPS.map(g => {
                    const rows = visible.filter(d => d.group === g.id);
                    if (!rows.length) return null;
                    return (
                        <div key={g.id} className={cl("section")}>
                            <div className={cl("section-head")} title={g.hint}>
                                <span className={classes(cl("dot"), cl(`dot-${g.id}`))} />
                                {g.label}
                                <span className={cl("muted")}>{rows.length}</span>
                            </div>
                            {rows.map(d => (
                                <DmRow key={d.id} dm={d} selected={selected.has(d.id) && selectable.has(d.id)} onSelect={v => setSel(d.id, v)} onOpen={() => open(d)} />
                            ))}
                        </div>
                    );
                })}
                {!visible.length && <div className={cl("empty")}>No DMs match this filter.</div>}
            </div>
        </div>
    );
}
