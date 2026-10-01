/*
 * RamSaver – Vencord Userplugin
 * Runs in the Electron main process (access to app / webContents).
 *
 * This file is loaded BEFORE Discord itself starts. This allows setting
 * Chromium switches here or intercepting Discord's own switches.
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { RendererSettings } from "@main/settings";
import { execFile } from "child_process";
import { app, IpcMainInvokeEvent } from "electron";

import { resolveConfig, RESTART_KEYS, StartupState } from "./profiles";

const log = (...args: any[]) => console.log("[RamSaver]", ...args);

// ---------------------------------------------------------------- Startup switches

/** Which restart settings are actually active in this session (null = plugin was off at startup) */
let startupState: StartupState | null = null;

function installStartupSwitches() {
    const stored = RendererSettings.store.plugins?.RamSaver;
    if (!stored?.enabled) return;

    const config = resolveConfig(stored);
    startupState = Object.fromEntries(RESTART_KEYS.map(k => [k, config[k]])) as StartupState;

    // Discord (Windows) completely disables background timer throttling. As a result,
    // all timers run at full frequency even when minimized. Discord in the browser runs fine with throttling.
    // "disable-renderer-backgrounding" (process priority) is kept on purpose - it protects voice calls.
    const droppedSwitches = new Set<string>();
    if (config.backgroundThrottling) droppedSwitches.add("disable-background-timer-throttling");

    // Restore default Chromium behavior: after 5 min in the background, timers fire only once per minute
    const droppedFeatures = new Set<string>();
    if (config.aggressiveBackground) droppedFeatures.add("IntensiveWakeUpThrottling");

    // Chromium otherwise constantly keeps an empty "spare" process in RAM
    const extraDisabledFeatures: string[] = [];
    if (config.noSpareRenderer) extraDisabledFeatures.push("SpareRendererForSitePerProcess");

    const extraJsFlags: string[] = [];
    if (config.v8OptimizeForSize) extraJsFlags.push("--optimize-for-size");

    const mergeFeatures = (value: string | undefined) => {
        const list = (value ?? "").split(",").filter(f => f && !droppedFeatures.has(f));
        for (const f of extraDisabledFeatures) if (!list.includes(f)) list.push(f);
        return list.join(",");
    };

    const { commandLine } = app;
    const originalAppend = commandLine.appendSwitch.bind(commandLine);

    commandLine.appendSwitch = (name: string, value?: string) => {
        if (droppedSwitches.has(name)) {
            log(`Switch removed from Discord: --${name}`);
            return;
        }
        if (name === "disable-features") value = mergeFeatures(value);
        else if (name === "js-flags" && extraJsFlags.length) value = [value, ...extraJsFlags].filter(Boolean).join(" ");

        return value === undefined ? originalAppend(name) : originalAppend(name, value);
    };

    // Set our own switches immediately. If Discord later sets the same switches, the hook merges them.
    if (extraDisabledFeatures.length) commandLine.appendSwitch("disable-features", commandLine.getSwitchValue("disable-features"));
    if (extraJsFlags.length) commandLine.appendSwitch("js-flags", commandLine.getSwitchValue("js-flags"));
    if (config.lowEndDevice) originalAppend("enable-low-end-device-mode");

    log("Startup settings active:", JSON.stringify(startupState));
}

try {
    installStartupSwitches();
} catch (e) {
    console.error("[RamSaver] Could not set startup switches", e);
}

export function getStartupState() {
    return startupState;
}

// ---------------------------------------------------------------- Measuring usage

export interface Usage {
    /** Sum of the working set of all Discord processes in MB */
    memoryMB: number;
    /** Sum of CPU usage since the last call (100 = one full core) */
    cpu: number;
    processes: number;
    /** Breakdown by process type (Browser, Tab, GPU, Utility, ...) */
    byType: Record<string, { memoryMB: number; cpu: number; count: number; }>;
}

export function getUsage(): Usage {
    const usage: Usage = { memoryMB: 0, cpu: 0, processes: 0, byType: {} };

    for (const m of app.getAppMetrics()) {
        const mem = m.memory.workingSetSize / 1024; // KB -> MB
        const cpu = m.cpu.percentCPUUsage;

        usage.memoryMB += mem;
        usage.cpu += cpu;
        usage.processes++;

        const t = usage.byType[m.type] ??= { memoryMB: 0, cpu: 0, count: 0 };
        t.memoryMB += mem;
        t.cpu += cpu;
        t.count++;
    }

    return usage;
}

// ---------------------------------------------------------------- Cleanup

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/**
 * Returns the physical RAM of all Discord processes to Windows (EmptyWorkingSet, like RAM-Limiter).
 * The data ends up in the page file or standby memory and is reloaded on demand -
 * useful when Discord is minimized and e.g. a game needs the RAM.
 */
function emptyWorkingSets(): Promise<void> {
    if (process.platform !== "win32") return Promise.resolve();

    const pids = app.getAppMetrics().map(m => m.pid).filter(p => p > 0);
    const script = `
$t = Add-Type -PassThru -Name W -Namespace RamSaver -MemberDefinition '[DllImport("psapi.dll")] public static extern bool EmptyWorkingSet(IntPtr h);'
foreach ($id in @(${pids.join(",")})) {
    try { $p = [Diagnostics.Process]::GetProcessById($id); [void]$t::EmptyWorkingSet($p.Handle); $p.Dispose() } catch { }
}`;
    const encoded = Buffer.from(script, "utf16le").toString("base64");

    return new Promise(resolve => {
        execFile(
            "powershell.exe",
            ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded],
            { windowsHide: true, timeout: 20_000 },
            err => {
                if (err) console.error("[RamSaver] EmptyWorkingSet failed", err);
                resolve();
            }
        );
    });
}

export interface TrimOptions {
    clearHttpCache: boolean;
    workingSet: boolean;
}

/**
 * Frees memory of the Discord window:
 *  - simulates "critical memory pressure" -> Chromium/Blink discards image, font & resource caches
 *  - forces a V8 garbage collection
 *  - optional: clears the session's HTTP cache
 *  - optional (Windows): returns the physical RAM of all Discord processes to Windows
 * Returns the RAM usage before/after.
 */
export async function trimMemory(event: IpcMainInvokeEvent, opts: TrimOptions) {
    const before = getUsage().memoryMB;
    const wc = event.sender;
    const dbg = wc.debugger;

    let attachedHere = false;
    try {
        if (!dbg.isAttached()) {
            dbg.attach("1.3");
            attachedHere = true;
        }
        await dbg.sendCommand("Memory.simulatePressureNotification", { level: "critical" }).catch(() => { });
        await dbg.sendCommand("HeapProfiler.collectGarbage").catch(() => { });
    } catch {
        // Debugger is busy (e.g. DevTools) - then only do the rest
    } finally {
        if (attachedHere) {
            try { dbg.detach(); } catch { }
        }
    }

    if (opts.clearHttpCache) {
        await wc.session.clearCache().catch(() => { });
    }

    // Let the GC work briefly, only then return the physical RAM
    await sleep(opts.workingSet ? 1000 : 1500);
    if (opts.workingSet) {
        await emptyWorkingSets();
        await sleep(500);
    }

    const after = getUsage().memoryMB;
    return { before, after };
}

// ---------------------------------------------------------------- Background throttling

let originalThrottling: boolean | null = null;

/** Throttles timers/rendering while Discord is in the background or minimized. */
export function setBackgroundThrottling(event: IpcMainInvokeEvent, enabled: boolean) {
    const wc = event.sender;
    if (enabled) {
        originalThrottling ??= wc.getBackgroundThrottling();
        wc.setBackgroundThrottling(true);
    } else if (originalThrottling !== null) {
        wc.setBackgroundThrottling(originalThrottling);
        originalThrottling = null;
    }
}
