/*
 * LinkCards – cards under messages & settings
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./ui.css";

import { updateMessage } from "@api/MessageUpdater";
import { classNameFactory } from "@api/Styles";
import { Button } from "@components/Button";
import ErrorBoundary from "@components/ErrorBoundary";
import { Link } from "@components/Link";
import { Switch } from "@components/Switch";
import { classes } from "@utils/misc";
import { useForceUpdater, useIntersection } from "@utils/react";
import { showToast, useEffect, useState } from "@webpack/common";

import { clearCache, getEntry, isFresh, isLoading, load, subscribe } from "./cache";
import { ICONS } from "./icons";
import { settings } from "./index";
import { getGitHubRate, onGitHubRate, refreshGitHubRate, resetBackoffs } from "./net";
import { findMatches, Match, matchUrl, PROVIDERS } from "./providers";
import { CardView, IconDef, ProviderId, timeAgo } from "./types";

const cl = classNameFactory("vc-linkcards-");

const PROVIDER_IDS: ProviderId[] = PROVIDERS.map(p => p.id);

// ---------------------------------------------------------------- Building blocks

function Icon({ icon, size = 16, className }: { icon: IconDef; size?: number; className?: string; }) {
    return (
        <svg viewBox={icon.viewBox ?? "0 0 24 24"} width={size} height={size} className={classes(cl("icon"), className)} aria-hidden>
            <path fill="currentColor" fillRule="evenodd" d={icon.path} />
        </svg>
    );
}

/** Messages whose original embed has already been re-rendered once */
const rerendered = new Set<string>();

function hideOriginalEmbed(message: any, key: string) {
    if (!settings.store.hideEmbeds || rerendered.has(message.id)) return;
    if (!message.embeds?.some((e: any) => e?.url && matchUrl(e.url)?.key === key)) return;
    if (rerendered.size > 1000) rerendered.clear();
    rerendered.add(message.id);
    updateMessage(message.channel_id, message.id);
}

// ---------------------------------------------------------------- Card

function RefreshButton({ loading, onClick }: { loading: boolean; onClick(): void; }) {
    return (
        <button
            className={cl("refresh")}
            disabled={loading}
            title="Refresh now"
            aria-label="Refresh now"
            onClick={onClick}
        >
            <Icon icon={ICONS.refresh} size={14} className={loading ? cl("spin") : undefined} />
        </button>
    );
}

function CardBody({ view }: { view: CardView; }) {
    const meta = view.meta?.filter(Boolean) as string[] | undefined;

    return (
        <>
            <div className={cl("title-row")}>
                {view.icon && <Icon icon={view.icon} className={cl("state-icon")} />}
                <Link href={view.url} className={cl("title")} title={view.title}>{view.title}</Link>
                {view.titleSuffix && <span className={cl("suffix")}>{view.titleSuffix}</span>}
                {view.badge && <span className={cl("badge")}>{view.badge}</span>}
            </div>

            {view.price && (
                <div className={cl("price")}>
                    {view.price.discount != null && <span className={cl("discount")}>-{view.price.discount}%</span>}
                    {view.price.initial && <s className={cl("initial")}>{view.price.initial}</s>}
                    <span className={cl("final")}>{view.price.final}</span>
                </div>
            )}

            {view.description && <div className={cl("description")}>{view.description}</div>}
            {!!meta?.length && <div className={cl("meta")}>{meta.join(" · ")}</div>}

            {!!view.labels?.length && (
                <div className={cl("labels")}>
                    {view.labels.map(l => (
                        <span key={l.name} className={cl("label")} style={{ "--vc-linkcards-label": l.color } as React.CSSProperties}>
                            {l.name}
                        </span>
                    ))}
                </div>
            )}

            {!!view.stats?.length && (
                <div className={cl("stats")}>
                    {view.stats.map((s, i) => (
                        <span key={i} className={cl("stat")} title={s.title}>
                            {s.icon && <Icon icon={s.icon} size={14} />}
                            {s.dot && <span className={cl("dot")} style={{ background: s.dot }} />}
                            {s.value}
                        </span>
                    ))}
                </div>
            )}
        </>
    );
}

function LinkCard({ match, active, message }: { match: Match; active: boolean; message: any; }) {
    const { provider, target, key } = match;
    const forceUpdate = useForceUpdater();

    useEffect(() => subscribe(key, forceUpdate), [key]);

    // Keep "X min ago" up to date; expired data is reloaded in the process
    useEffect(() => {
        const id = setInterval(forceUpdate, 30_000);
        return () => clearInterval(id);
    }, []);

    const entry = getEntry(key);
    const loading = isLoading(key);

    useEffect(() => {
        if (active && !loading && !isFresh(provider, entry)) load(provider, target);
    });

    const hasData = entry?.data != null;
    useEffect(() => {
        if (hasData) hideOriginalEmbed(message, key);
    }, [hasData, key]);

    const refresh = () => {
        load(provider, target, true);
    };

    let view: CardView | null = null;
    if (hasData) {
        try {
            view = provider.render(entry!.data, target);
        } catch {
            view = null;
        }
    }

    // No data yet: placeholder or error
    if (!view) {
        const failed = !!entry?.error && !loading;
        return (
            <div className={classes(cl("card"), cl("compact"), !failed && cl("pending"))}>
                <div className={cl("header")}>
                    <span className={cl("provider")}>{provider.label}</span>
                    <span className={cl("status")}>
                        {failed
                            ? <><Icon icon={ICONS.warning} size={12} className={cl("warn-icon")} />{entry!.error}</>
                            : "Loading…"}
                    </span>
                    {failed && !entry!.backoffUntil && <RefreshButton loading={loading} onClick={refresh} />}
                </div>
                {!failed && <div className={cl("skeleton")} />}
            </div>
        );
    }

    const stale = !!entry?.error;

    return (
        <div className={cl("card")} style={{ "--vc-linkcards-color": view.color } as React.CSSProperties}>
            <div className={cl("header")}>
                <span className={cl("provider")}>
                    {view.provider}
                    {view.context && <span className={cl("context")}> · {view.context}</span>}
                </span>
                {!provider.static && <>
                    <span className={cl("status")} title={entry?.fetchedAt ? new Date(entry.fetchedAt).toLocaleString("en-US") : undefined}>
                        <span className={classes(cl("live-dot"), stale && cl("live-dot-stale"))} />
                        {loading ? "Refreshing…" : `Live · updated ${timeAgo(entry!.fetchedAt)}`}
                    </span>
                    <RefreshButton loading={loading} onClick={refresh} />
                </>}
            </div>
            <CardBody view={view} />
            {stale && !loading && (
                <div className={cl("stale")}>
                    <Icon icon={ICONS.warning} size={12} />
                    Refresh failed: {entry!.error}
                </div>
            )}
        </div>
    );
}

function Accessory({ message }: { message: any; }) {
    // Re-render when provider toggles or country change
    const { onlyVisible } = settings.use(["onlyVisible", "steamCountry", ...PROVIDER_IDS]);
    const [ref, visible] = useIntersection();

    const matches = findMatches(message.content);
    if (!matches.length) return null;

    return (
        <div ref={ref} className={cl("container")}>
            {matches.map(m => <LinkCard key={m.key} match={m} message={message} active={!onlyVisible || visible} />)}
        </div>
    );
}

export const LinkCardsAccessory = ErrorBoundary.wrap(Accessory, { noop: true });

// ---------------------------------------------------------------- Settings

function Row({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode; }) {
    return (
        <label className={cl("option")}>
            <span className={cl("option-text")}>
                <span>{label}</span>
                {hint && <span className={cl("muted")}>{hint}</span>}
            </span>
            {children}
        </label>
    );
}

function RateLimitInfo() {
    const forceUpdate = useForceUpdater();
    const [checking, setChecking] = useState(false);
    const [problem, setProblem] = useState<string | null>(null);
    const { githubToken } = settings.use(["githubToken"]);

    useEffect(() => onGitHubRate(forceUpdate), []);

    const check = async () => {
        setChecking(true);
        try {
            const res = await refreshGitHubRate();
            setProblem(res.status === 401 ? "Invalid token" : res.status === 200 ? null : res.error ?? `HTTP ${res.status}`);
        } catch {
            setProblem("Check failed");
        } finally {
            setChecking(false);
        }
    };

    // After a token change, wait briefly until the setting has reached the main process
    useEffect(() => {
        const id = setTimeout(check, 1200);
        return () => clearTimeout(id);
    }, [githubToken]);

    const rate = getGitHubRate();
    const pct = rate ? Math.max(0, Math.min(100, rate.remaining / rate.limit * 100)) : 0;

    return (
        <div className={cl("rate")}>
            <div className={cl("rate-head")}>
                <span>Rate limit</span>
                <span className={cl("rate-value")}>
                    {problem
                        ? <span className={cl("bad")}>{problem}</span>
                        : rate ? `${rate.remaining} / ${rate.limit} left` : "–"}
                </span>
                <RefreshButton loading={checking} onClick={check} />
            </div>
            <div className={cl("bar")}>
                <div className={classes(cl("bar-fill"), pct < 15 && cl("bar-low"))} style={{ width: `${pct}%` }} />
            </div>
            <div className={cl("muted")}>
                {rate && rate.reset > Date.now()
                    ? `Resets ${timeAgo(rate.reset)} (${new Date(rate.reset).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" })}). `
                    : ""}
                Without a token 60 requests/hr, with a token 5000.
            </div>
        </div>
    );
}

function TokenInput() {
    const { githubToken } = settings.use(["githubToken"]);
    const [show, setShow] = useState(false);

    return (
        <div className={cl("input-row")}>
            <input
                className={cl("input")}
                type={show ? "text" : "password"}
                placeholder="ghp_… or github_pat_… (optional)"
                autoComplete="off"
                spellCheck={false}
                value={githubToken}
                onChange={e => settings.store.githubToken = e.currentTarget.value.trim()}
            />
            <button className={cl("icon-btn")} title={show ? "Hide" : "Show"} onClick={() => setShow(v => !v)}>
                <Icon icon={show ? ICONS.eyeOff : ICONS.eye} size={18} />
            </button>
        </div>
    );
}

function CountryInput() {
    const { steamCountry } = settings.use(["steamCountry"]);
    const [value, setValue] = useState(steamCountry);
    const valid = /^[A-Z]{2}$/.test(value);

    return (
        <input
            className={classes(cl("input"), cl("country"), !valid && cl("input-bad"))}
            maxLength={2}
            value={value}
            spellCheck={false}
            onChange={e => {
                const v = e.currentTarget.value.toUpperCase().replace(/[^A-Z]/g, "");
                setValue(v);
                if (/^[A-Z]{2}$/.test(v)) settings.store.steamCountry = v;
            }}
        />
    );
}

export const SettingsPanel = ErrorBoundary.wrap(() => {
    const store = settings.use(["onlyVisible", "hideEmbeds", ...PROVIDER_IDS]);

    const clear = async () => {
        await clearCache();
        resetBackoffs();
        showToast("LinkCards cache cleared", "success");
    };

    return (
        <div className={cl("settings")}>
            <div className={cl("section")}>
                <div className={cl("section-title")}>Services</div>
                {PROVIDERS.map(p => (
                    <Row key={p.id} label={p.label} hint={p.static ? p.hint : `${p.hint} · Cache ${Math.round(p.ttl / 60_000)} min`}>
                        <Switch checked={store[p.id]} onChange={v => settings.store[p.id] = v} />
                    </Row>
                ))}
            </div>

            <div className={cl("section")}>
                <div className={cl("section-title")}>GitHub token</div>
                <div className={cl("muted")}>
                    Optional, raises the rate limit. A token with no permissions (public data only) is enough.
                    It is only sent to api.github.com.
                </div>
                <TokenInput />
                <RateLimitInfo />
            </div>

            <div className={cl("section")}>
                <div className={cl("section-title")}>Steam</div>
                <Row label="Country for prices" hint="Two-letter country code, e.g. US, GB, DE, CA">
                    <CountryInput />
                </Row>
            </div>

            <div className={cl("section")}>
                <div className={cl("section-title")}>Behavior</div>
                <Row label="Only load visible cards" hint="Only make requests once the message is on screen">
                    <Switch checked={store.onlyVisible} onChange={v => settings.store.onlyVisible = v} />
                </Row>
                <Row label="Hide Discord embed" hint="Hides the frozen original embed once the card has data">
                    <Switch checked={store.hideEmbeds} onChange={v => settings.store.hideEmbeds = v} />
                </Row>
                <div className={cl("actions")}>
                    <Button size="small" variant="secondary" onClick={clear}>Clear cache</Button>
                </div>
            </div>
        </div>
    );
}, { noop: true });
