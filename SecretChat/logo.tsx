/*
 * SecretChat – Animated app icon. The lock is open while the chat isn't encrypted and snaps shut (with a bounce and
 * a ripple) when it is; a light sweeps over it now and then. Hovering lifts the shackle a little.
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { classNameFactory } from "@api/Styles";
import { classes } from "@utils/misc";

const cl = classNameFactory("vc-secretchat-logo-");

export function SecretLogo({ locked, size = 42 }: { locked: boolean; size?: number; }) {
    return (
        <span
            className={classes(cl("tile"), locked ? cl("locked") : cl("open"))}
            style={{ width: size, height: size, borderRadius: size * 0.26 }}
            aria-hidden
        >
            <span className={cl("ripple")} key={`r${locked}`} />
            {/* key: remount on change, so the lock / unlock animation plays */}
            <svg key={String(locked)} className={cl("svg")} viewBox="0 0 64 64" width={size} height={size}>
                <path className={cl("shackle")} d="M22 31v-8a10 10 0 0 1 20 0v8" fill="none" stroke="#fff" strokeWidth="5.5" strokeLinecap="round" />
                <g className={cl("body")}>
                    <rect x="14" y="29" width="36" height="25" rx="7" fill="#fff" />
                    <circle className={cl("hole")} cx="32" cy="39.5" r="3.6" />
                    <rect className={cl("hole")} x="30.4" y="40" width="3.2" height="7.5" rx="1.6" />
                </g>
            </svg>
            <span className={cl("sheen")} />
        </span>
    );
}
