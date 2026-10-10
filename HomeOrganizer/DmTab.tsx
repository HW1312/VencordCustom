/*
 * HomeOrganizer – "DMs" tab: automatically categorize and tidy up open direct messages
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import {
    ChannelStore, NavigationRouter, PrivateChannelSortStore, ReadStateStore, showToast,
    useMemo, UserStore, useState, useStateFromStores
} from "@webpack/common";

import { Avatar, Badge, Button, Empty, Glyph, Group, IconButton, Note, Pill, Pills, Row, SearchField, Section, UiColor } from "../_ui";
import { Check, cl, ConfirmItem, ICONS, JobBar, openConfirm, QueueBadge, useJob } from "./components";
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

const GROUP_COLOR: Record<DmGroup, UiColor> = { active: "green", groups: "indigo", quiet: "orange", asleep: "gray", never: "red" };

function DmRow({ dm, selected, onSelect, onOpen }: { dm: DmEntry; selected: boolean; onSelect(v: boolean): void; onOpen(): void; }) {
    const selectable = !dm.isGroup && !dm.protected;

    const leave = () => openConfirm({
        title: "Leave group?",
        text: (
            <Note tone="bad">
                You are about to <b>leave</b> the group “{dm.name}”. For group DMs, closing always means leaving - you can only
                come back if someone adds you to the group again.
            </Note>
        ),
        items: [toItem(dm)],
        confirmText: "Leave group",
        onConfirm: () => leaveGroup(dm.id)
            .then(() => showToast(`Left “${dm.name}”`, "success"))
            .catch(e => showToast(`Failed to leave: ${describeError(e)}`, "failure"))
    });

    return (
        <Row
            className={selected ? cl("selected") : undefined}
            onClick={selectable ? () => onSelect(!selected) : undefined}
            leading={<>
                <Check
                    checked={selected}
                    disabled={!selectable}
                    onChange={onSelect}
                    title={dm.isGroup ? "Groups are excluded from bulk actions" : dm.protected ? "Protected" : undefined}
                />
                <Avatar src={dm.avatar} size={36} />
            </>}
            title={<span className={cl("title")}>
                <span className={cl("ellipsis")}>{dm.name}</span>
                {dm.mentions > 0
                    ? <Badge color="red" solid>{dm.mentions > 99 ? "99+" : dm.mentions}</Badge>
                    : dm.unread && <span className={cl("unread-dot")} title="Unread" />}
            </span>}
            subtitle={<span className={cl("sub")}>
                {dm.sub && <span className={cl("ellipsis")}>{dm.sub}</span>}
                {dm.pinnedIn != null && <Badge color="blue" icon={ICONS.pin} title="In a PinDMs category">{dm.pinnedIn || "Pinned"}</Badge>}
                {dm.protected && <Badge color="green">Protected</Badge>}
            </span>}
            trailing={<>
                <span className={cl("date")} title={dm.lastTs ? new Date(dm.lastTs).toLocaleString() : "No messages"}>
                    <span>{relative(dm.lastTs)}</span>
                    <span className={cl("dim")}>{formatDate(dm.lastTs)}</span>
                </span>
                <span className={cl("row-actions")} onClick={e => e.stopPropagation()}>
                    <Button small variant="gray" icon={ICONS.open} onClick={onOpen}>Open</Button>
                    <IconButton
                        icon={ICONS.shield}
                        active={dm.protected}
                        label={dm.protected ? "Remove protection (PinDMs pins stay protected)" : "Never close"}
                        onClick={() => toggleProtected(dm.id)}
                    />
                    {dm.isGroup && <Button small variant="destructive" icon={ICONS.leave} onClick={leave}>Leave</Button>}
                </span>
            </>}
        />
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
        if (!list.length) return showToast("Nothing to close", "message");

        openConfirm({
            title: `Close ${list.length} DMs?`,
            text: (
                <>
                    <div>{what} - the history is kept; the DMs only disappear from your list and reappear when a new message arrives.</div>
                    <div className={cl("dim")}>Groups, PinDMs pins and protected DMs are excluded. Throttled to ~1/s, takes about {list.length} s.</div>
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
                if (failed) showToast(`${failed} DMs could not be closed`, "failure");
                return `Closed ${ok} DMs${failed ? `, ${failed} failed` : ""}.`;
            })
        });
    }

    const asleep = dms.filter(d => d.group === "asleep" && !d.protected);
    const never = dms.filter(d => d.group === "never" && !d.protected);
    const protectedCount = dms.filter(d => d.protected).length;

    return (
        <>
            <div className={cl("quick")}>
                <Group>
                    <Row
                        leading={<Glyph path={ICONS.moon} color="gray" />}
                        title={`${asleep.length} dormant`}
                        subtitle={`silent for more than ${quietDays} days`}
                        trailing={<Button small variant="destructive" disabled={!asleep.length || job.state.running} onClick={() => runClose(asleep, "All dormant DMs")}>Close all</Button>}
                    />
                </Group>
                <Group>
                    <Row
                        leading={<Glyph path={ICONS.chat} color="red" />}
                        title={`${never.length} without messages`}
                        subtitle="never messaged"
                        trailing={<Button small variant="destructive" disabled={!never.length || job.state.running} onClick={() => runClose(never, "All DMs without messages")}>Close all</Button>}
                    />
                </Group>
                <Group>
                    <Row
                        leading={<Glyph path={ICONS.shield} color="green" />}
                        title={`${protectedCount} protected`}
                        subtitle={protectPinned ? "incl. PinDMs pins" : "own list only"}
                    />
                </Group>
            </div>

            <JobBar job={job} />

            <div className={cl("toolbar")}>
                <SearchField className={cl("grow")} placeholder="Name, username or ID ..." value={query} onChange={setQuery} />
                <Pill selected={unreadOnly} icon={unreadOnly ? ICONS.check : undefined} onClick={() => setUnreadOnly(!unreadOnly)}>unread only</Pill>
                <QueueBadge />
            </div>
            <Pills>
                <Pill selected={filter === "all"} onClick={() => setFilter("all")}>All · {dms.length}</Pill>
                {DM_GROUPS.map(g => (
                    <Pill key={g.id} selected={filter === g.id} onClick={() => setFilter(g.id)} title={g.hint}
                        leading={<span className={cl("dot")} style={{ background: `var(--vc-ui-${GROUP_COLOR[g.id]})` }} />}>
                        {g.label} · {counts[g.id] ?? 0}
                    </Pill>
                ))}
            </Pills>

            <div className={cl("selbar")}>
                <span className={cl("dim")}>{selectedEntries.length} selected</span>
                <Button small variant="plain" onClick={() => setSelected(new Set(visible.filter(d => selectable.has(d.id)).map(d => d.id)))}>Select visible</Button>
                <Button small variant="plain" onClick={() => setSelected(new Set())}>Clear selection</Button>
                <span className={cl("grow")} />
                <Button small variant="destructive" icon={ICONS.close} disabled={!selectedEntries.length || job.state.running} onClick={() => runClose(selectedEntries, "The selected DMs")}>
                    Close selected ({selectedEntries.length})
                </Button>
            </div>

            {DM_GROUPS.map(g => {
                const rows = visible.filter(d => d.group === g.id);
                if (!rows.length) return null;
                return (
                    <Section
                        key={g.id}
                        title={<span className={cl("section-title")} title={g.hint}>
                            <span className={cl("dot")} style={{ background: `var(--vc-ui-${GROUP_COLOR[g.id]})` }} />
                            {g.label}
                        </span>}
                        right={rows.length}
                    >
                        {rows.map(d => (
                            <DmRow key={d.id} dm={d} selected={selected.has(d.id) && selectable.has(d.id)} onSelect={v => setSel(d.id, v)} onOpen={() => open(d)} />
                        ))}
                    </Section>
                );
            })}
            {!visible.length && <Empty icon={ICONS.chat} title="No DMs match this filter." />}
        </>
    );
}
