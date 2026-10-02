/*
 * Wrapped – charts drawn with plain SVG / CSS (no chart library)
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { classNameFactory } from "@api/Styles";
import type { CSSProperties, ReactNode } from "react";

import { Aggregate, DayPoint, fmtDuration, fmtHour, fmtNum, Metric, WEEKDAYS } from "./stats";

export const cl = classNameFactory("vc-wrapped-");

export const fmtMetric = (metric: Metric, v: number) => metric === "messages" ? `${fmtNum(v)} messages` : fmtDuration(v);

// ---------------------------------------------------------------- Daily bars

interface Bucket {
    label: string;
    title: string;
    value: number;
}

/** More than ~2 months → one bar per week */
function buckets(days: DayPoint[], metric: Metric): Bucket[] {
    const short = (d: Date) => d.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
    if (days.length <= 62)
        return days.map(d => ({ label: short(d.date), title: `${d.date.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" })}: ${fmtMetric(metric, d[metric])}`, value: d[metric] }));

    const out: Bucket[] = [];
    for (let i = 0; i < days.length; i += 7) {
        const chunk = days.slice(i, i + 7);
        const value = chunk.reduce((a, d) => a + d[metric], 0);
        out.push({ label: short(chunk[0].date), title: `Week of ${short(chunk[0].date)}: ${fmtMetric(metric, value)}`, value });
    }
    return out;
}

export function BarChart({ days, metric }: { days: DayPoint[]; metric: Metric; }) {
    const data = buckets(days, metric);
    const max = Math.max(1, ...data.map(b => b.value));
    const W = 10, GAP = data.length > 40 ? 2 : 3, H = 100;
    const width = data.length * W;
    const labelIdx = new Set([0, Math.floor((data.length - 1) / 2), data.length - 1]);

    return (
        <div className={cl("bars")}>
            <div className={cl("bars-max")}>{fmtMetric(metric, max)}</div>
            <svg viewBox={`0 0 ${width} ${H}`} preserveAspectRatio="none" className={cl("bars-svg")}>
                <defs>
                    <linearGradient id="vc-wrapped-bar" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0" stopColor="var(--wr-c1)" />
                        <stop offset="1" stopColor="var(--wr-c2)" />
                    </linearGradient>
                </defs>
                {data.map((b, i) => {
                    const h = b.value ? Math.max(1.5, b.value / max * (H - 2)) : 0;
                    return (
                        <g key={i}>
                            <rect x={i * W} y={0} width={W} height={H} fill="transparent">
                                <title>{b.title}</title>
                            </rect>
                            <rect
                                x={i * W + GAP / 2}
                                y={H - h}
                                width={W - GAP}
                                height={h}
                                rx={Math.min(2, (W - GAP) / 2)}
                                fill="url(#vc-wrapped-bar)"
                                className={cl("bar")}
                            >
                                <title>{b.title}</title>
                            </rect>
                        </g>
                    );
                })}
            </svg>
            <div className={cl("bars-labels")}>
                {data.map((b, i) => <span key={i}>{labelIdx.has(i) ? b.label : ""}</span>)}
            </div>
        </div>
    );
}

// ---------------------------------------------------------------- Heatmap

export function Heatmap({ agg, metric }: { agg: Aggregate; metric: Metric; }) {
    const grid = agg.heat[metric];
    const max = Math.max(1, ...grid.flat());

    return (
        <div className={cl("heat")}>
            <div className={cl("heat-grid")}>
                <span />
                {Array.from({ length: 24 }, (_, h) => (
                    <span key={h} className={cl("heat-hour")}>{h % 3 === 0 ? h : ""}</span>
                ))}
                {grid.flatMap((row, wd) => [
                    <span key={"l" + wd} className={cl("heat-day")}>{WEEKDAYS[wd].slice(0, 3)}</span>,
                    ...row.map((v, h) => (
                        <span
                            key={wd + "-" + h}
                            className={cl("heat-cell")}
                            style={{ "--wr-a": v ? 0.15 + 0.85 * Math.sqrt(v / max) : 0 } as CSSProperties}
                            title={`${WEEKDAYS[wd]}, ${fmtHour(h)}–${fmtHour((h + 1) % 24)}: ${fmtMetric(metric, v)}`}
                        />
                    ))
                ])}
            </div>
            <div className={cl("heat-legend")}>
                <span>Less</span>
                {[0, 0.25, 0.5, 0.75, 1].map(a => (
                    <span key={a} className={cl("heat-cell")} style={{ "--wr-a": a ? 0.15 + 0.85 * a : 0 } as CSSProperties} />
                ))}
                <span>More</span>
            </div>
        </div>
    );
}

// ---------------------------------------------------------------- Horizontal bars

export function MeterRow({ icon, name, sub, value, max, label }: {
    icon?: ReactNode;
    name: string;
    sub?: string;
    value: number;
    max: number;
    label: string;
}) {
    return (
        <div className={cl("meter")}>
            {icon}
            <div className={cl("meter-body")}>
                <div className={cl("meter-head")}>
                    <span className={cl("meter-name")}>{name}</span>
                    <span className={cl("meter-value")}>{label}</span>
                </div>
                <div className={cl("meter-track")}>
                    <div className={cl("meter-fill")} style={{ width: `${Math.max(2, value / Math.max(1, max) * 100)}%` }} />
                </div>
                {sub && <div className={cl("meter-sub")}>{sub}</div>}
            </div>
        </div>
    );
}
