/*
 * SecretChat – Chat bar lock, keyring window (1:1 / Group tabs), handshake card and lock icon on messages
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./ui.css";

import { ChatBarButton, ChatBarButtonFactory } from "@api/ChatButtons";
import { classNameFactory } from "@api/Styles";
import { copyWithToast } from "@utils/discord";
import { classes } from "@utils/misc";
import { IconComponent } from "@utils/types";
import { Channel, Message } from "@vencord/discord-types";
import { showToast, Tooltip, UserStore, useState } from "@webpack/common";
import type { ReactNode } from "react";

import { Avatar as KitAvatar, Button, confirm, openAlert, Empty, Glyph, Icon, IconButton, ICONS, LinkRow, Note, openWindow, Pill, Pills, Row, Section, Segmented, Sheet, State, TextField } from "../_ui";
import { RoomCard } from "./area";
import { keyFromPassword, randomBytes } from "./crypto";
import { acceptHandshake, declineHandshake, decrypted, deleteKeyForBoth, handshakes, keyDeletes, retryLocked, startHandshake } from "./messages";
import { chatLabel, makeRoom, pruneStale, roomMessages } from "./rooms";
import { settings } from "./settings";
import { addKey, cancelPending, channelKey, deleteKey, getKey, inviteCode, KeyRecord, parseInviteCode, renameKey, setChannelKey, toggleChannel, useStore } from "./store";

const cl = classNameFactory("vc-secretchat-");

// ---------------------------------------------------------------- Icons

export const LOCK_PATH = "M6 9V7a6 6 0 1 1 12 0v2h1a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-9a2 2 0 0 1 2-2h1Zm2-2a4 4 0 1 1 8 0v2H8V7Zm4 6a2 2 0 0 0-1 3.73V18a1 1 0 1 0 2 0v-1.27A2 2 0 0 0 12 13Z";
const UNLOCK_PATH = "M8 7a4 4 0 0 1 7.75-1.4 1 1 0 1 0 1.87-.7A6 6 0 0 0 6 7v2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-9a2 2 0 0 0-2-2H8V7Zm4 6a2 2 0 0 0-1 3.73V18a1 1 0 1 0 2 0v-1.27A2 2 0 0 0 12 13Z";
export const GROUP_PATH = "M16 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm-8 0a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm0 2c-2.33 0-7 1.17-7 3.5V19h14v-2.5C15 14.17 10.33 13 8 13Zm8 0c-.29 0-.62.02-.97.05A4.22 4.22 0 0 1 17 16.5V19h6v-2.5c0-2.33-4.67-3.5-7-3.5Z";
const SHIELD_PATH = "M12 1 3 5v6c0 5.55 3.84 10.74 9 12 5.16-1.26 9-6.45 9-12V5l-9-4Z";

/** App icon color of SecretChat (window headers, buttons in chat) */
export const SC_COLOR = "green" as const;

export const LockIcon: IconComponent = ({ width = 24, height = 24, className }) => (
    <svg width={width} height={height} viewBox="0 0 24 24" className={className} fill="currentColor">
        <path fillRule="evenodd" d={LOCK_PATH} />
    </svg>
);

const UnlockIcon: IconComponent = ({ width = 24, height = 24, className }) => (
    <svg width={width} height={height} viewBox="0 0 24 24" className={className} fill="currentColor">
        <path fillRule="evenodd" d={UNLOCK_PATH} />
    </svg>
);

const userName = (id?: string) => {
    const u = id ? UserStore.getUser(id) : null;
    return u ? (u as any).globalName || u.username : "someone";
};

// ---------------------------------------------------------------- Chat bar

export const ChatButton: ChatBarButtonFactory = ({ channel, isMainChat }) => {
    useStore();
    const { showChatBarButton } = settings.use(["showChatBarButton"]);
    if (!showChatBarButton || !isMainChat || !channel) return null;

    const active = channelKey(channel.id);
    const tooltip = active
        ? `Encrypted with “${active.name}” · right-click to turn off`
        : "SecretChat: off · click to choose a key";

    return (
        <ChatBarButton
            tooltip={tooltip}
            onClick={() => openChatModal(channel)}
            onContextMenu={async e => {
                e.preventDefault();
                const id = await toggleChannel(channel.id);
                if (!id && !active) openChatModal(channel);
            }}
        >
            {active
                ? <LockIcon width={20} height={20} className={cl("bar-on")} />
                : <UnlockIcon width={20} height={20} />}
        </ChatBarButton>
    );
};

// ---------------------------------------------------------------- Small parts

export function UserAvatar({ userId, size = 32 }: { userId?: string; size?: number; }) {
    const user = userId ? UserStore.getUser(userId) : null;
    return <KitAvatar src={(user as any)?.getAvatarURL?.(undefined, 64)} size={size} />;
}

/** Name field that replaces a row title while renaming; onDone(null) = cancelled */
export function RenameField({ initial, onDone }: { initial: string; onDone(name: string | null): void; }) {
    const [name, setName] = useState(initial);
    return (
        <span className={cl("rename")} onClick={e => e.stopPropagation()}>
            <TextField
                value={name}
                autoFocus
                maxLength={64}
                onChange={setName}
                onBlur={() => onDone(name)}
                onKeyDown={e => {
                    if (e.key === "Enter") e.currentTarget.blur();
                    if (e.key === "Escape") { e.stopPropagation(); onDone(null); }
                }}
            />
        </span>
    );
}

async function confirmDelete(k: KeyRecord) {
    if (k.kind === "private" && k.partnerId) {
        const partner = userName(k.partnerId);
        const choice = await openAlert({
            title: `Delete “${k.name}”?`,
            body: `Messages sent with this key can't be read anymore. “For both” also deletes it on ${partner}'s PC as soon as their SecretChat sees the request in your DM.`,
            icon: ICONS.trash,
            iconColor: "red",
            buttons: [{ label: "Cancel" }, { label: "Only for me", variant: "gray" }, { label: "Delete for both", variant: "destructive" }]
        });
        if (choice === 1) deleteKey(k.id);
        else if (choice === 2 && !await deleteKeyForBoth(k)) {
            showToast(`No DM with ${partner} – deleted only for you`, "message");
            deleteKey(k.id);
        }
        return;
    }
    const ok = await confirm({
        title: `Delete “${k.name}”?`,
        body: "Messages sent with this key can't be read on this PC anymore.",
        confirmText: "Delete key",
        destructive: true
    });
    if (ok) deleteKey(k.id);
}

// ---------------------------------------------------------------- Window for one chat

function KeyRow({ k, selected, onClick }: { k: KeyRecord; selected: boolean; onClick(): void; }) {
    const [editing, setEditing] = useState(false);

    return (
        <Row
            className={classes(cl("key"), selected && cl("key-on"))}
            onClick={() => !editing && onClick()}
            leading={k.kind === "private"
                ? <UserAvatar userId={k.partnerId} />
                : <Glyph path={GROUP_PATH} color="indigo" size={32} />}
            title={editing
                ? <RenameField initial={k.name} onDone={n => { if (n != null) renameKey(k.id, n); setEditing(false); }} />
                : k.name}
            subtitle={
                <>
                    <Tooltip text="Safety code – compare it with the others">
                        {p => <span {...p} className={cl("safety")}><Icon path={SHIELD_PATH} size={11} />{k.safety}</span>}
                    </Tooltip>
                    {k.quantumSafe && (
                        <Tooltip text="Made with the hybrid handshake (ECDH P-256 + ML-KEM-768) – safe against quantum computers">
                            {p => <span {...p} className={cl("pq")}>Quantum-safe</span>}
                        </Tooltip>
                    )}
                    {k.source === "handshake" && !k.quantumSafe && (
                        <Tooltip text="Made with the older ECDH-only handshake. Delete it and connect again for a quantum-safe key.">
                            {p => <span {...p} className={classes(cl("pq"), cl("pq-old"))}>Not quantum-safe</span>}
                        </Tooltip>
                    )}
                </>
            }
            trailing={
                <span className={cl("key-trailing")} onClick={e => e.stopPropagation()}>
                    <span className={cl("key-actions")}>
                        <IconButton icon={ICONS.edit} label="Rename" onClick={() => setEditing(true)} />
                        {k.kind === "group" && (
                            <IconButton icon={ICONS.copy} label="Copy code" onClick={() => copyWithToast(inviteCode(k), "Code copied")} />
                        )}
                        <IconButton icon={ICONS.trash} label="Delete" destructive onClick={() => confirmDelete(k)} />
                    </span>
                    <span className={cl("key-check")}>{selected && <Icon path={ICONS.check} size={16} />}</span>
                </span>
            }
        />
    );
}

function KeyList({ keys, current, channelId }: { keys: KeyRecord[]; current: string | null; channelId: string; }) {
    return (
        <>
            {keys.map(k => (
                <KeyRow key={k.id} k={k} selected={current === k.id} onClick={() => setChannelKey(channelId, current === k.id ? null : k.id)} />
            ))}
        </>
    );
}

function PrivateTab({ channel, current }: { channel: Channel; current: string | null; }) {
    const s = useStore();
    const me = UserStore.getCurrentUser()?.id;
    const recipients: string[] = (channel.recipients ?? []).filter(id => id !== me);
    const keys = s.keys
        .filter(k => k.kind === "private")
        // People in this chat first
        .sort((a, b) => Number(recipients.includes(b.partnerId!)) - Number(recipients.includes(a.partnerId!)));
    const connected = new Set(keys.map(k => k.partnerId));
    const candidates = recipients.filter(id => !connected.has(id));
    const waiting = new Set(Object.values(s.pending).map(p => p.to));

    if (!keys.length && !candidates.length) {
        return <Empty icon={ICONS.user} title="No 1:1 keys yet" hint="Right-click someone → Start encrypted chat" />;
    }

    return (
        <Section>
            <KeyList keys={keys} current={current} channelId={channel.id} />
            {candidates.map(id => waiting.has(id) ? (
                <Row
                    key={id}
                    leading={<UserAvatar userId={id} />}
                    title={userName(id)}
                    trailing={<>
                        <State spinner>Waiting …</State>
                        <IconButton icon={ICONS.close} label="Cancel request" destructive onClick={() => cancelPending(id)} />
                    </>}
                />
            ) : (
                <Row
                    key={id}
                    leading={<UserAvatar userId={id} />}
                    title={userName(id)}
                    trailing={
                        <Button small variant="tinted" color={SC_COLOR} icon={ICONS.plus} onClick={() => {
                            const user = UserStore.getUser(id);
                            if (user) startHandshake(user, channel.id);
                        }}>Connect</Button>
                    }
                />
            ))}
        </Section>
    );
}

function GroupTab({ channel, current }: { channel: Channel; current: string | null; }) {
    const s = useStore();
    const keys = s.keys.filter(k => k.kind === "group");
    const [panel, setPanel] = useState<"new" | "code" | null>(keys.length ? null : "new");
    const [name, setName] = useState("");
    const [mode, setMode] = useState<"random" | "password">("random");
    const [password, setPassword] = useState("");
    const [code, setCode] = useState("");
    const [busy, setBusy] = useState(false);

    const canCreate = !!name.trim() && (mode === "random" || password.length >= 8) && !busy;
    const codeValid = !!parseInviteCode(code);

    const create = async () => {
        if (!canCreate) return;
        setBusy(true);
        try {
            const key = mode === "random" ? randomBytes(32) : await keyFromPassword(password);
            const { record, isNew } = await addKey(key, { name, kind: "group", source: mode });
            await setChannelKey(channel.id, record.id);
            retryLocked();
            if (!isNew) showToast(`You already have this key as “${record.name}”`, "message");
            else if (mode === "random") copyWithToast(inviteCode(record), "Key created – code copied");
            setName("");
            setPassword("");
            setPanel(null);
        } finally {
            setBusy(false);
        }
    };

    const add = async () => {
        if (codeValid && await importCode(code, channel.id)) {
            setCode("");
            setPanel(null);
        }
    };

    return (
        <>
            {!!keys.length && (
                <Section>
                    <KeyList keys={keys} current={current} channelId={channel.id} />
                </Section>
            )}

            <Pills>
                <Pill icon={ICONS.plus} selected={panel === "new"} onClick={() => setPanel(panel === "new" ? null : "new")}>New key</Pill>
                <Pill icon={ICONS.copy} selected={panel === "code"} onClick={() => setPanel(panel === "code" ? null : "code")}>Paste code</Pill>
            </Pills>

            {panel === "new" && (
                <div className={cl("panel")}>
                    <TextField value={name} autoFocus placeholder="Name" maxLength={64} onChange={setName} />
                    <Segmented<"random" | "password">
                        small
                        value={mode}
                        onChange={setMode}
                        options={[{ value: "random", label: "Code" }, { value: "password", label: "Password" }]}
                    />
                    {mode === "password" && (
                        <TextField
                            type="password"
                            value={password}
                            placeholder="Password (8+ characters)"
                            onChange={setPassword}
                            onKeyDown={e => { if (e.key === "Enter") create(); }}
                        />
                    )}
                    <Button wide disabled={!canCreate} onClick={create}>{busy ? "Creating …" : "Create"}</Button>
                </div>
            )}

            {panel === "code" && (
                <div className={cl("panel")}>
                    <TextField
                        className={classes(cl("mono"), code && !codeValid && cl("field-error"))}
                        value={code}
                        autoFocus
                        placeholder="sckey1.…"
                        onChange={setCode}
                        onKeyDown={e => { if (e.key === "Enter") add(); }}
                    />
                    <Button wide disabled={!codeValid} onClick={add}>Add</Button>
                </div>
            )}
        </>
    );
}

/** Bottom of the chat window: make this chat a secret room (listed in the server list area, own pings) */
function RoomSection({ channel }: { channel: Channel; }) {
    const s = useStore();
    const active = channelKey(channel.id);
    const room = s.rooms[channel.id];
    const [open, setOpen] = useState(false);
    const [name, setName] = useState(() => active?.kind === "group" ? active.name : chatLabel(channel.id).slice(0, 64));
    const [busy, setBusy] = useState(false);

    if (room) return <Note tone="ok">Secret room “{room.name}” · pings only through SecretChat</Note>;

    const create = async () => {
        if (!name.trim() || busy) return;
        setBusy(true);
        try {
            // A 1:1 key must stay between the two of you – a room gets a group key that can be handed out
            await makeRoom(channel.id, name, active?.kind === "group" ? active.id : undefined);
            setOpen(false);
        } finally {
            setBusy(false);
        }
    };

    return open ? (
        <div className={cl("panel")}>
            <TextField
                value={name}
                autoFocus
                placeholder="Room name (only you all see it)"
                maxLength={64}
                onChange={setName}
                onKeyDown={e => { if (e.key === "Enter") create(); }}
            />
            <Button wide color={SC_COLOR} disabled={!name.trim() || busy} onClick={create}>{busy ? "Creating …" : "Make secret room"}</Button>
        </div>
    ) : (
        <Section>
            <LinkRow icon={LOCK_PATH} onClick={() => setOpen(true)}>Make this chat a secret room</LinkRow>
        </Section>
    );
}

function ChatWindow({ channel, close }: { channel: Channel; close(): void; }) {
    useStore();
    const active = channelKey(channel.id);
    const [tab, setTab] = useState<"private" | "group">(active ? active.kind : channel.isDM?.() ? "private" : "group");
    const dot = (kind: "private" | "group") => active?.kind === kind && <span className={cl("tab-dot")} />;

    return (
        <Sheet
            header={{
                title: "SecretChat",
                subtitle: active ? `Encrypted · ${active.name}` : "Not encrypted",
                live: !!active,
                icon: LOCK_PATH,
                iconColor: SC_COLOR,
                actions: active && <Button small variant="gray" onClick={() => setChannelKey(channel.id, null)}>Turn off</Button>
            }}
            onClose={close}
            top={
                <div className={cl("top")}>
                    <Segmented<"private" | "group">
                        value={tab}
                        onChange={setTab}
                        options={[
                            { value: "private", label: <>1:1{dot("private")}</> },
                            { value: "group", label: <>Group{dot("group")}</> }
                        ]}
                    />
                </div>
            }
        >
            {tab === "private"
                ? <PrivateTab channel={channel} current={active?.id ?? null} />
                : <GroupTab channel={channel} current={active?.id ?? null} />}

            <RoomSection channel={channel} />
        </Sheet>
    );
}

export function openChatModal(channel: Channel) {
    void pruneStale();
    openWindow(close => <ChatWindow channel={channel} close={close} />, { size: "small" });
}

export async function importCode(text: string, channelId?: string) {
    const parsed = parseInviteCode(text);
    if (!parsed) return null;
    const result = await addKey(parsed.key, { name: parsed.name || "Group key", kind: "group", source: "code" });
    if (channelId) await setChannelKey(channelId, result.record.id);
    retryLocked();
    showToast(result.isNew ? `Key “${result.record.name}” added` : `You already have this key as “${result.record.name}”`, "success");
    return result;
}

// ---------------------------------------------------------------- On messages

/** Lock next to the name of decrypted messages */
export function LockDecoration({ message }: { message: Message; }) {
    useStore();
    const keyId = decrypted.get(message.id);
    if (!keyId || !settings.store.showLockIcon) return null;
    const k = getKey(keyId);
    return (
        <Tooltip text={k ? `Encrypted · ${k.name}` : "Encrypted"}>
            {p => <span {...p} className={cl("deco")}><LockIcon width={14} height={14} /></span>}
        </Tooltip>
    );
}

/** Below handshake messages (accept / waiting) and below decrypted key codes (add key) */
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/** Line icons (Lucide style) – pathLength 1 lets CSS draw them in */
const DecisionIcon = ({ accept }: { accept?: boolean; }) => (
    <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        {accept
            ? <path pathLength={1} d="M20 6 9 17l-5-5" />
            : <><path pathLength={1} d="M18 6 6 18" /><path pathLength={1} d="m6 6 12 12" /></>}
    </svg>
);

type DecisionPhase = "idle" | "busy" | "done";

/**
 * ✓ / ✕ of a request card: just the icon. Hover draws it again, click pops it, then a ring spins while the key
 * is made / the request is put away, and the icon draws in once it's done.
 */
function DecisionButton({ accept, label, hidden, onStart, onClick, onFinished }: {
    accept?: boolean; label: string; hidden?: boolean;
    onStart(): void; onClick(): Promise<unknown>; onFinished(): void;
}) {
    const [phase, setPhase] = useState<DecisionPhase>("idle");
    const run = async () => {
        if (phase !== "idle") return;
        onStart();
        setPhase("busy");
        try {
            await Promise.all([onClick(), sleep(900)]);
        } finally {
            setPhase("done");
            await sleep(650);
            onFinished();
        }
    };
    return (
        <Tooltip text={label} shouldShow={phase === "idle" && !hidden}>
            {p => (
                <button
                    {...p}
                    type="button"
                    aria-label={label}
                    disabled={phase !== "idle" || hidden}
                    className={classes(cl("decide"), accept ? cl("decide-yes") : cl("decide-no"), cl(`decide-${phase}`), hidden && cl("decide-hidden"))}
                    onClick={run}
                >
                    {phase === "busy"
                        ? <svg className={cl("decide-spin")} viewBox="0 0 24 24" width="22" height="22" aria-hidden><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" /></svg>
                        : <DecisionIcon accept={accept} />}
                </button>
            )}
        </Tooltip>
    );
}

export function MessageCard({ message }: { message: Message; }) {
    const s = useStore();
    /** The ✓ / ✕ that was clicked – the buttons stay until its animation is over */
    const [deciding, setDeciding] = useState<"yes" | "no" | null>(null);
    if (roomMessages.has(message.id)) return <RoomCard message={message} />;
    const del = keyDeletes.get(message.id);
    if (del) {
        return (
            <div className={cl("card")}>
                <Icon path={ICONS.trash} size={18} />
                <span className={cl("card-text")}>
                    {del.authorId === UserStore.getCurrentUser()?.id ? "You deleted the encrypted chat key for both of you" : `${userName(del.authorId)} deleted the encrypted chat key`}
                </span>
            </div>
        );
    }
    const hs = handshakes.get(message.id);
    const me = UserStore.getCurrentUser()?.id;

    if (!hs) {
        if (!decrypted.has(message.id)) return null;
        const code = parseInviteCode(message.content);
        if (!code) return null;
        return (
            <div className={cl("card")}>
                <Icon path={GROUP_PATH} size={18} />
                <span className={cl("card-text")}>Group key “{code.name || "Group key"}”</span>
                <Button small color={SC_COLOR} onClick={() => importCode(message.content)}>Add key</Button>
            </div>
        );
    }

    let text: ReactNode;
    let buttons: ReactNode = null;
    if (hs.type === "hello") {
        if (hs.to === me && (deciding || !s.handled.includes(hs.hsid))) {
            text = deciding === "yes" ? <>Securing the chat with {userName(hs.authorId)} …</>
                : deciding === "no" ? <>Declining the request …</>
                    : <>{userName(hs.authorId)} wants an encrypted 1:1 chat</>;
            const done = () => setDeciding(null);
            buttons = (
                <span className={cl("decide-group")}>
                    <DecisionButton accept label="Accept" hidden={deciding === "no"} onStart={() => setDeciding("yes")} onClick={() => acceptHandshake(hs)} onFinished={done} />
                    <DecisionButton label="Decline" hidden={deciding === "yes"} onStart={() => setDeciding("no")} onClick={() => declineHandshake(hs)} onFinished={done} />
                </span>
            );
        } else if (hs.to === me) {
            text = s.declined.includes(hs.hsid)
                ? <>You declined the request from {userName(hs.authorId)}</>
                : <>You accepted the request from {userName(hs.authorId)}</>;
        } else if (hs.authorId === me) {
            text = s.pending[hs.hsid] ? <>Waiting for {userName(hs.to)} …</>
                : s.declined.includes(hs.hsid) ? <>{userName(hs.to)} declined your request</>
                    : <>Request to {userName(hs.to)} answered</>;
        } else {
            text = <>Encrypted chat request to {userName(hs.to)}</>;
        }
    } else if (hs.type === "decline") {
        text = hs.authorId === me ? <>You declined the encrypted chat</> : <>{userName(hs.authorId)} declined the encrypted chat</>;
    } else {
        text = hs.authorId !== me && s.pending[hs.hsid] ? <>Connecting …</> : <>Encrypted 1:1 chat set up</>;
    }

    return (
        <div className={cl("card")}>
            <LockIcon width={18} height={18} />
            <span className={cl("card-text")}>{text}</span>
            {buttons}
        </div>
    );
}
