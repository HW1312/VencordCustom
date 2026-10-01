/*
 * OpSec – Icon (crossed-out eye) & privacy curtain (covers the whole window)
 * The same building block is used for the real curtain and the live preview in the settings.
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

/** Crossed-out eye, 24×24 (fill-rule nonzero) */
export const MASK_PATH =
    "M12 7c2.76 0 5 2.24 5 5 0 .65-.13 1.26-.36 1.83l2.92 2.92c1.51-1.26 2.7-2.89 3.43-4.75-1.73-4.39-6-7.5-11-7.5-1.4 0-2.74.25-3.98.7l2.16 2.16C10.74 7.13 11.35 7 12 7z"
    + "M2 4.27l2.28 2.28.46.46C3.08 8.3 1.78 10.02 1 12c1.73 4.39 6 7.5 11 7.5 1.55 0 3.03-.3 4.38-.84l.42.42L19.73 22 21 20.73 3.27 3 2 4.27z"
    + "M7.53 9.8l1.55 1.55c-.05.21-.08.43-.08.65 0 1.66 1.34 3 3 3 .22 0 .44-.03.65-.08l1.55 1.55c-.67.33-1.41.53-2.2.53-2.76 0-5-2.24-5-5 0-.79.2-1.53.53-2.2z"
    + "M11.84 9.02l3.15 3.15.02-.16c0-1.66-1.34-3-3-3l-.17.01z";

/** Selectable icons for the curtain, 24×24 */
export const CURTAIN_ICONS = {
    eyeOff: MASK_PATH,
    lock: "M18 8h-1V6c0-2.76-2.24-5-5-5S7 3.24 7 6v2H6c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V10c0-1.1-.9-2-2-2zm-6 9c-1.1 0-2-.9-2-2s.9-2 2-2 2 .9 2 2-.9 2-2 2zm3.1-9H8.9V6c0-1.71 1.39-3.1 3.1-3.1 1.71 0 3.1 1.39 3.1 3.1v2z",
    shield: "M12 1 3 5v6c0 5.55 3.84 10.74 9 12 5.16-1.26 9-6.45 9-12V5l-9-4Z",
    ghost: "M12 2a9 9 0 0 0-9 9v11l3-3 3 3 3-3 3 3 3-3 3 3V11a9 9 0 0 0-9-9M9 8a2 2 0 0 1 2 2 2 2 0 0 1-2 2 2 2 0 0 1-2-2 2 2 0 0 1 2-2m6 0a2 2 0 0 1 2 2 2 2 0 0 1-2 2 2 2 0 0 1-2-2 2 2 0 0 1 2-2Z",
    skull: "M12 2a9 9 0 0 0-9 9c0 3.03 1.53 5.82 4 7.47V22h2v-3h2v3h2v-3h2v3h2v-3.54c2.47-1.65 4-4.46 4-7.46a9 9 0 0 0-9-9M8 11a2 2 0 0 1 2 2 2 2 0 0 1-2 2 2 2 0 0 1-2-2 2 2 0 0 1 2-2m8 0a2 2 0 0 1 2 2 2 2 0 0 1-2 2 2 2 0 0 1-2-2 2 2 0 0 1 2-2m-4 3 1.5 3h-3L12 14Z",
    moon: "M12 3a9 9 0 1 0 9 9c0-.46-.04-.92-.1-1.36a5.39 5.39 0 0 1-4.4 2.26 5.4 5.4 0 0 1-3.14-9.8c-.44-.06-.9-.1-1.36-.1Z",
    coffee: "M20 3H4v10c0 2.21 1.79 4 4 4h6c2.21 0 4-1.79 4-4v-3h2c1.11 0 2-.89 2-2V5c0-1.11-.89-2-2-2zm0 5h-2V5h2v3zM4 19h16v2H4z"
};

export type CurtainIconName = keyof typeof CURTAIN_ICONS | "custom";

export type CurtainStyle = "mask" | "glass" | "black" | "update" | "matrix" | "radar" | "aurora" | "lock" | "terminal" | "bsod";
export type CurtainAnimation = "fade" | "zoom" | "shutter" | "glitch";

export interface CurtainOptions {
    style: CurtainStyle;
    /** Background opacity 0–100 */
    opacity: number;
    /** Blur in px */
    blur: number;
    accent: string;
    showIcon: boolean;
    icon: CurtainIconName;
    /** Emoji/text or image link when icon === "custom" */
    iconCustom: string;
    showText: boolean;
    text: string;
    clickToUnlock: boolean;
    animation: CurtainAnimation;
    hotkeyLabel: string;
}

export const DEFAULT_CURTAIN_TEXT = "Privacy screen active";

const SVG_NS = "http://www.w3.org/2000/svg";

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string) {
    const e = document.createElement(tag);
    if (className) e.className = className;
    if (text != null) e.textContent = text;
    return e;
}

function iconSvg(d: string) {
    const svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    const path = document.createElementNS(SVG_NS, "path");
    path.setAttribute("fill", "currentColor");
    path.setAttribute("d", d);
    svg.appendChild(path);
    return svg;
}

/** Selected icon – custom emoji/text, custom image or one of the built-in ones */
function iconNode(o: CurtainOptions): Element {
    const custom = o.iconCustom?.trim();
    if (o.icon === "custom" && custom) {
        if (/^https?:\/\/\S+$/i.test(custom)) {
            const img = el("img", "vc-opsec-curtain-img");
            img.src = custom;
            img.alt = "";
            img.draggable = false;
            return img;
        }
        return el("span", "vc-opsec-curtain-emoji", [...custom].slice(0, 4).join(""));
    }
    const name = o.icon && o.icon !== "custom" && o.icon in CURTAIN_ICONS ? o.icon : "eyeOff";
    return iconSvg(CURTAIN_ICONS[name]);
}

// ---------------------------------------------------------------- Styles

/** Fake Windows update: progress persists across multiple displays and never reaches 100% */
let updatePercent = 8 + Math.floor(Math.random() * 25);

function buildUpdate(root: HTMLElement, cleanups: (() => void)[]) {
    const box = el("div", "vc-opsec-update");
    const spinner = el("div", "vc-opsec-update-spinner");
    for (let i = 0; i < 5; i++) spinner.appendChild(el("i"));
    const title = el("div", "vc-opsec-update-title", "Working on updates");
    const pct = el("div", "vc-opsec-update-title", `${updatePercent}% complete`);
    const sub = el("div", "vc-opsec-update-sub", "Don't turn off your PC. This will take a while.");
    box.append(spinner, title, pct, sub);
    root.appendChild(box);

    let timer: ReturnType<typeof setTimeout>;
    const tick = () => {
        if (updatePercent < 99) updatePercent += Math.random() < 0.3 ? 2 : 1;
        pct.textContent = `${updatePercent}% complete`;
        timer = setTimeout(tick, 2500 + Math.random() * 5000);
    };
    timer = setTimeout(tick, 3000);
    cleanups.push(() => clearTimeout(timer));
}

const MATRIX_CHARS = "アイウエオカキクケコサシスセソタチツテトナニヌネノハヒフヘホマミムメモヤユヨラリルレロワン0123456789ABCDEF";

function buildMatrix(root: HTMLElement, accent: string, cleanups: (() => void)[]) {
    const canvas = el("canvas", "vc-opsec-matrix");
    root.appendChild(canvas);
    const ctx = canvas.getContext("2d")!;
    let drops: number[] = [];
    let fontSize = 16;
    let raf = 0;
    let last = 0;

    const step = () => {
        ctx.fillStyle = "rgba(0, 0, 0, 0.08)";
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.font = `${fontSize}px monospace`;
        for (let i = 0; i < drops.length; i++) {
            const y = drops[i] * fontSize;
            ctx.fillStyle = Math.random() > 0.96 ? "#fff" : accent;
            ctx.fillText(MATRIX_CHARS[Math.floor(Math.random() * MATRIX_CHARS.length)], i * fontSize, y);
            if (y > canvas.height && Math.random() > 0.975) drops[i] = 0;
            drops[i]++;
        }
    };

    const resize = () => {
        const w = canvas.clientWidth, h = canvas.clientHeight;
        if (!w || !h) return;
        canvas.width = w;
        canvas.height = h;
        fontSize = Math.max(8, Math.round(Math.min(w, h) / 40));
        drops = Array.from({ length: Math.ceil(w / fontSize) }, () => Math.random() * -h / fontSize);
        // Pre-run so the rain fills the whole screen immediately
        for (let i = 0; i < 60; i++) step();
    };
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);

    // Time-based (~20 steps/s), independent of the monitor's refresh rate
    const draw = (t: number) => {
        raf = requestAnimationFrame(draw);
        if (document.hidden || t - last < 50) return;
        last = t;
        step();
    };
    raf = requestAnimationFrame(draw);
    cleanups.push(() => {
        cancelAnimationFrame(raf);
        ro.disconnect();
    });
}

/** Radar: rings, crosshair and a rotating beam */
function buildRadar(root: HTMLElement) {
    const radar = el("div", "vc-opsec-radar");
    radar.append(el("div", "vc-opsec-radar-rings"), el("div", "vc-opsec-radar-sweep"));
    for (let i = 0; i < 4; i++) {
        const blip = el("i", "vc-opsec-radar-blip");
        blip.style.setProperty("--x", `${20 + Math.random() * 60}%`);
        blip.style.setProperty("--y", `${20 + Math.random() * 60}%`);
        blip.style.animationDelay = `${Math.random() * 4}s`;
        radar.appendChild(blip);
    }
    root.appendChild(radar);
}

/** Aurora: slowly drifting, blurred color fields */
function buildAurora(root: HTMLElement) {
    const aurora = el("div", "vc-opsec-aurora");
    for (let i = 0; i < 3; i++) aurora.appendChild(el("i"));
    root.appendChild(aurora);
}

/** Lock screen: large time & date like the Windows lock screen */
function buildLock(root: HTMLElement, cleanups: (() => void)[]) {
    const clock = el("div", "vc-opsec-lock");
    const time = el("div", "vc-opsec-lock-time");
    const date = el("div", "vc-opsec-lock-date");
    clock.append(time, date);
    root.appendChild(clock);

    const tick = () => {
        const now = new Date();
        time.textContent = now.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" });
        date.textContent = now.toLocaleDateString("en-US", { weekday: "long", day: "numeric", month: "long" });
    };
    tick();
    const timer = setInterval(tick, 1000);
    cleanups.push(() => clearInterval(timer));
}

/**
 * Movie-hacker terminal: fictional like in Hollywood (no real tool, no real command, nothing runs).
 * Everything is English. One full loop lasts well over 10 minutes before it repeats.
 * Step kinds: string = output line ("blank" = empty line); { bar } = progress bar;
 * { hex } = n lines of random hex; { wait } = pause in ms.
 */
type TermStep = string | { bar: string; } | { hex: number; } | { wait: number; };

interface Scene { cmd: string; out: TermStep[]; }

const SCENES: Scene[] = [
    {
        cmd: "nmap -sS -p- --min-rate 4000 10.14.0.0/16",
        out: ["Starting Nmap 7.94 ( https://nmap.org )", { wait: 900 }, "Initiating SYN Stealth Scan", "Scanning 65536 hosts [65535 ports/host]", { bar: "SYN scan" }, "Discovered open port 22/tcp on 10.14.7.31", "Discovered open port 443/tcp on 10.14.7.31", "Discovered open port 3389/tcp on 10.14.9.114", "Discovered open port 8080/tcp on 10.14.12.88", "Discovered open port 5432/tcp on 10.14.21.9", { wait: 700 }, "Nmap done: 65536 addresses (214 hosts up) scanned in 138.42s"]
    },
    {
        cmd: "nmap -sV -sC -p22,443,8080 10.14.7.31",
        out: ["Starting service/version detection", { wait: 600 }, "22/tcp   open  ssh      OpenSSH 8.9p1 Ubuntu 3ubuntu0.6", "443/tcp  open  ssl/http nginx 1.24.0", "| ssl-cert: Subject: commonName=intranet.corp.local", "| tls-alpn: h2, http/1.1", "8080/tcp open  http     Apache Tomcat 9.0.71", "|_http-title: Apache Tomcat/9.0.71 - Manager", { wait: 500 }, "Service detection performed. 3 services fingerprinted."]
    },
    {
        cmd: "gobuster dir -u https://10.14.7.31 -w common.txt -t 40",
        out: ["Gobuster v3.6", "[+] Url: https://10.14.7.31", "[+] Threads: 40", { wait: 500 }, { bar: "enumerate paths" }, "/admin                (Status: 301) [--> /admin/]", "/api                  (Status: 200) [Size: 1841]", "/backup               (Status: 403) [Size: 279]", "/config.php.bak       (Status: 200) [Size: 40213]", "/.git/HEAD            (Status: 200) [Size: 23]", "Finished"]
    },
    {
        cmd: "hydra -L users.txt -P rockyou.txt ssh://10.14.7.31 -t 16",
        out: ["Hydra v9.5 starting", "[DATA] max 16 tasks per 1 server, overall 16 tasks", "[DATA] attacking ssh://10.14.7.31:22/", { bar: "brute-force ssh" }, "[ATTEMPT] target 10.14.7.31 - login \"root\" - pass \"123456\"", "[ATTEMPT] target 10.14.7.31 - login \"admin\" - pass \"letmein\"", "[ATTEMPT] target 10.14.7.31 - login \"svc_backup\" - pass \"summer2024\"", { wait: 500 }, "[22][ssh] host: 10.14.7.31   login: svc_backup   password: Sp1derW3b!", "1 of 1 target successfully completed, 1 valid password found"]
    },
    {
        cmd: "ssh svc_backup@10.14.7.31",
        out: ["The authenticity of host '10.14.7.31' can't be established.", "ED25519 key fingerprint is SHA256:9f2c1a7b4e8d0f6a3c5b9e2d1f4a8c7b.", "Warning: Permanently added '10.14.7.31' to known hosts.", { wait: 800 }, "Linux prod-db-01 5.15.0-91-generic x86_64", "Last login: Mon Feb  3 02:04:11 2026 from 10.14.7.2", { wait: 600 }, "svc_backup@prod-db-01:~$ id", "uid=1004(svc_backup) gid=1004(svc_backup) groups=1004,27(sudo)"]
    },
    {
        cmd: "sudo -l",
        out: ["Matching Defaults entries for svc_backup on prod-db-01:", "    env_reset, mail_badpass, secure_path=/usr/sbin:/usr/bin", { wait: 500 }, "User svc_backup may run the following commands:", "    (ALL : ALL) NOPASSWD: /usr/bin/tar", "    (root) NOPASSWD: /opt/scripts/db_dump.sh"]
    },
    {
        cmd: "searchsploit tomcat 9.0.71",
        out: [{ wait: 500 }, "Apache Tomcat 9.x - Local Privilege Escalation      | linux/local/51447.sh", "Apache Tomcat - Session Fixation                    | multiple/remote/49321.txt", "Apache Tomcat - Ghostcat File Read/Inclusion        | linux/webapps/48143.py", { wait: 400 }, "Shellcodes: No Results"]
    },
    {
        cmd: "python3 48143.py 10.14.7.31 /WEB-INF/web.xml",
        out: ["[*] Ghostcat (CVE-2020-1938) AJP file read", "[*] Connecting to 10.14.7.31:8009", { bar: "read remote file" }, "<?xml version=\"1.0\" encoding=\"UTF-8\"?>", "  <context-param>", "    <param-name>dbUser</param-name>", "    <param-value>tomcat_rw</param-value>", "  <context-param>", "    <param-name>dbPass</param-name>", "    <param-value>T0mc4t#2025</param-value>", "[+] File read complete"]
    },
    {
        cmd: "psql -h 10.14.21.9 -U tomcat_rw -d customers",
        out: ["Password for user tomcat_rw:", { wait: 700 }, "psql (16.1)", "Type \"help\" for help.", { wait: 400 }, "customers=> \\dt", "         List of relations", " Schema |     Name     | Type  | Owner", " public | accounts     | table | postgres", " public | sessions     | table | postgres", " public | audit_log    | table | postgres"]
    },
    {
        cmd: "SELECT count(*) FROM accounts;",
        out: [{ wait: 500 }, " count", "-------", " 48213", "(1 row)", { wait: 400 }, "customers=> -- exfil disabled in demo, read-only"]
    },
    {
        cmd: "hashcat -m 1800 hashes.txt rockyou.txt -O",
        out: ["hashcat (v6.2.6) starting", "* Device #1: NVIDIA RTX 4090, 24576 MB", "Hashmode: 1800 (sha512crypt $6$)", { wait: 500 }, { bar: "crack hashes" }, { hex: 3 }, "$6$rounds=5000$k7Hd...:autumn!Leaves92", "$6$rounds=5000$9aQ2...:Zurich#2026", "Recovered........: 2/5 (40.00%) Digests", "Speed.#1.........: 51294 H/s"]
    },
    {
        cmd: "tcpdump -i eth0 -n 'port 80 or port 443' -c 500",
        out: ["tcpdump: verbose output suppressed, use -v for full protocol decode", "listening on eth0, link-type EN10MB (Ethernet)", { wait: 500 }, { hex: 4 }, "02:22:08.114 IP 10.14.7.31.443 > 10.14.7.2.51522: Flags [P.], length 517", "02:22:08.119 IP 10.14.7.2.51522 > 10.14.7.31.443: Flags [.], ack 517", "500 packets captured", "1204 packets received by filter"]
    },
    {
        cmd: "aircrack-ng -w rockyou.txt capture-01.cap",
        out: ["Reading packets, please wait...", "Opening capture-01.cap", { wait: 500 }, "1 potential target", "Handshake found for CORP-GUEST (E4:8D:8C:1F:22:0A)", { bar: "testing keys" }, { hex: 2 }, "KEY FOUND! [ H0tsp0t-Guest-2025 ]", "Master Key : 3F A9 1C 08 7D 2E ... 4B C1"]
    },
    {
        cmd: "proxychains curl -s http://10.14.9.114/api/tokens",
        out: ["[proxychains] Strict chain ... 127.0.0.1:9050 ... 10.14.9.114:80 ... OK", { wait: 600 }, "{\"count\":3,\"tokens\":[", "  {\"id\":\"ac-01\",\"scope\":\"read\",\"exp\":1772500000},", "  {\"id\":\"ac-02\",\"scope\":\"write\",\"exp\":1772500000}", "]}"]
    },
    {
        cmd: "john --incremental shadow.txt",
        out: ["Using default input encoding: UTF-8", "Loaded 6 password hashes (sha512crypt)", "Press 'q' or Ctrl-C to abort", { bar: "incremental mode" }, { hex: 2 }, "gr33nlantern     (jdoe)", "0g 0:00:04:12 3.1% (ETA 04:41) 0g/s 14213p/s", { wait: 400 }, "Session aborted"]
    },
    {
        cmd: "impacket-secretsdump svc_backup@10.14.9.114",
        out: ["Impacket v0.11.0", "[*] Service RemoteRegistry is in stopped state", "[*] Dumping local SAM hashes (uid:rid:lmhash:nthash)", { wait: 600 }, { hex: 3 }, "Administrator:500:aad3b435:31d6cfe0d16ae931b73c59d7e0c089c0:::", "[*] Dumping cached domain logon information", "[*] Cleaning up..."]
    },
    {
        cmd: "clear && dmesg | tail -n 5",
        out: [{ wait: 400 }, "[ 8123.44] audit: type=1400 apparmor=\"STATUS\" operation=\"profile_load\"", "[ 8130.02] EXT4-fs (nvme0n1p2): mounted filesystem with ordered data mode", "[ 8131.77] eth0: renamed from veth9a1c", "[ 8140.19] IPv6: ADDRCONF(NETDEV_CHANGE): eth0: link becomes ready"]
    },
];
const HEX = "0123456789abcdef";
const randHex = (n: number) => Array.from({ length: n }, () => HEX[Math.floor(Math.random() * 16)]).join("");
const hexLine = () => `${randHex(8)}  ${Array.from({ length: 8 }, () => randHex(4)).join(" ")}  |${Array.from({ length: 8 }, () => "._-#=+*"[Math.floor(Math.random() * 7)]).join("")}|`;

/**
 * Terminal that endlessly types movie-hacker commands and shows fake progress / hex dumps.
 * Typing speed and pauses are tuned so one pass through all scenes takes clearly over 10 minutes.
 */
function buildTerminal(root: HTMLElement, o: CurtainOptions, cleanups: (() => void)[]) {
    const win = el("div", "vc-opsec-term");
    const bar = el("div", "vc-opsec-term-bar");
    const titleText = o.showText && o.text.trim() ? o.text.trim() : "root@node-7 \u2014 ssh";
    bar.append(el("i"), el("i"), el("i"), el("span", undefined, titleText));
    const body = el("div", "vc-opsec-term-body");
    const prompt = el("div", "vc-opsec-term-prompt");
    const ps1 = el("span", "vc-opsec-term-ps", "root@node-7:~# ");
    const typed = el("span");
    prompt.append(ps1, typed, el("span", "vc-opsec-term-cursor"));
    win.append(bar, body, prompt);
    root.appendChild(win);

    let dead = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const sleep = (ms: number) => new Promise<void>(resolve => { timer = setTimeout(resolve, ms); });
    cleanups.push(() => { dead = true; clearTimeout(timer); });

    const add = (text: string, cls = "vc-opsec-term-line") => {
        const node = el("div", cls, text);
        body.appendChild(node);
        while (body.childElementCount > 200) body.firstElementChild?.remove();
        node.scrollIntoView({ block: "end" });
        return node;
    };

    const progress = async (label: string) => {
        const node = add("", "vc-opsec-term-line vc-opsec-term-progress");
        let pct = 0;
        while (pct < 100 && !dead) {
            pct = Math.min(100, pct + 1 + Math.floor(Math.random() * 6));
            const filled = Math.round(pct / 4);
            node.textContent = `${label.padEnd(22, " ")} [${"#".repeat(filled)}${".".repeat(25 - filled)}] ${String(pct).padStart(3, " ")}%`;
            await sleep(120 + Math.random() * 320);
        }
    };

    const typeCmd = async (cmd: string) => {
        typed.textContent = "";
        for (const ch of cmd) {
            if (dead) return;
            typed.textContent += ch;
            await sleep(45 + Math.random() * 95);
        }
        await sleep(350 + Math.random() * 500);
        add(`root@node-7:~# ${cmd}`, "vc-opsec-term-line vc-opsec-term-cmd");
        typed.textContent = "";
    };

    const run = async () => {
        while (!dead) {
            for (const scene of SCENES) {
                if (dead) return;
                await typeCmd(scene.cmd);
                for (const step of scene.out) {
                    if (dead) return;
                    if (typeof step === "string") {
                        add(step);
                        await sleep(220 + Math.random() * 520);
                    } else if ("bar" in step) {
                        await progress(step.bar);
                    } else if ("hex" in step) {
                        for (let i = 0; i < step.hex; i++) {
                            add(hexLine(), "vc-opsec-term-line vc-opsec-term-hex");
                            await sleep(70 + Math.random() * 110);
                        }
                    } else {
                        await sleep(step.wait);
                    }
                }
                add("", "vc-opsec-term-line");
                await sleep(900 + Math.random() * 1200);
            }
            // brief idle blink before the whole run repeats
            await sleep(4000);
            body.textContent = "";
        }
    };
    run();
}

/** Fake blue screen in the Windows 10/11 style */
function buildBsod(root: HTMLElement, cleanups: (() => void)[]) {
    const box = el("div", "vc-opsec-bsod");
    const pct = el("div", "vc-opsec-bsod-text");
    let value = Math.floor(Math.random() * 20);
    const render = () => pct.textContent = `${value}% complete`;
    render();
    box.append(
        el("div", "vc-opsec-bsod-face", ":("),
        el("div", "vc-opsec-bsod-text", "Your PC ran into a problem and needs to restart. We're just collecting some error info, and then we'll restart for you."),
        pct,
        el("div", "vc-opsec-bsod-small", "Stop code: CRITICAL_PROCESS_DIED")
    );
    root.appendChild(box);

    let timer: ReturnType<typeof setTimeout>;
    const tick = () => {
        if (value < 100) value += Math.random() < 0.4 ? 0 : Math.ceil(Math.random() * 3);
        value = Math.min(100, value);
        render();
        timer = setTimeout(tick, 900 + Math.random() * 1600);
    };
    timer = setTimeout(tick, 1200);
    cleanups.push(() => clearTimeout(timer));
}

function buildCenter(root: HTMLElement, o: CurtainOptions) {
    const center = el("div", "vc-opsec-curtain-center");

    if (o.showIcon) {
        const icon = el("div", "vc-opsec-curtain-icon");
        icon.append(el("div", "vc-opsec-curtain-halo"), iconNode(o));
        center.appendChild(icon);
    }
    if (o.showText) {
        center.appendChild(el("div", "vc-opsec-curtain-title", o.text.trim() || DEFAULT_CURTAIN_TEXT));
        center.appendChild(el("div", "vc-opsec-curtain-hint",
            o.clickToUnlock ? `Click or press ${o.hotkeyLabel} to unlock` : `Unlock only with ${o.hotkeyLabel}`));
    }
    root.appendChild(center);
}

// ---------------------------------------------------------------- Building block

export interface CurtainInstance {
    el: HTMLDivElement;
    destroy(): void;
}

export function buildCurtain(o: CurtainOptions, preview = false): CurtainInstance {
    const root = el("div", [
        "vc-opsec-curtain",
        "vc-keep-motion",
        `vc-opsec-curtain-${o.style}`,
        `vc-opsec-anim-${o.animation}`,
        preview && "vc-opsec-curtain-preview"
    ].filter(Boolean).join(" "));

    root.style.setProperty("--opsec-c-accent", o.accent);
    root.style.setProperty("--opsec-c-opacity", String(Math.max(0, Math.min(100, o.opacity)) / 100));
    root.style.setProperty("--opsec-c-blur", `${Math.max(0, o.blur)}px`);

    const cleanups: (() => void)[] = [];
    switch (o.style) {
        case "update":
            buildUpdate(root, cleanups);
            break;
        case "bsod":
            buildBsod(root, cleanups);
            break;
        case "terminal":
            buildTerminal(root, o, cleanups);
            break;
        default:
            if (o.style === "matrix") buildMatrix(root, o.accent, cleanups);
            if (o.style === "radar") buildRadar(root);
            if (o.style === "aurora") buildAurora(root);
            if (o.style === "lock") buildLock(root, cleanups);
            buildCenter(root, o);
    }

    return {
        el: root,
        destroy: () => cleanups.forEach(c => c())
    };
}

// ---------------------------------------------------------------- Show / hide

type Mode = "manual" | "auto";

let getOptions: () => CurtainOptions = () => ({
    style: "mask", opacity: 96, blur: 24, accent: "#3ddc97", showIcon: true, icon: "eyeOff", iconCustom: "", showText: true,
    text: "", clickToUnlock: true, animation: "zoom", hotkeyLabel: "Ctrl + Shift + L"
});

export function configureCurtain(provider: () => CurtainOptions) {
    getOptions = provider;
}

let current: (CurtainInstance & { mode: Mode; }) | null = null;
const listeners = new Set<() => void>();

export const isCurtainShown = () => current !== null;

export function onCurtainChange(fn: () => void) {
    listeners.add(fn);
    return () => void listeners.delete(fn);
}

/** "manual" = stays until click/hotkey, "auto" = disappears as soon as the window is focused again */
export function showCurtain(mode: Mode = "manual") {
    if (current) {
        if (mode === "manual") current.mode = "manual";
        return;
    }
    const o = getOptions();
    const instance = buildCurtain(o);
    instance.el.addEventListener("click", () => {
        if (o.clickToUnlock) hideCurtain();
    });
    document.body.appendChild(instance.el);
    current = { ...instance, mode };
    listeners.forEach(l => l());
}

export function hideCurtain(onlyAuto = false) {
    if (!current || (onlyAuto && current.mode !== "auto")) return;
    const { el: node, destroy } = current;
    current = null;
    node.classList.add("vc-opsec-curtain-leave");
    setTimeout(() => {
        destroy();
        node.remove();
    }, 280);
    listeners.forEach(l => l());
}

export function toggleCurtain() {
    current ? hideCurtain() : showCurtain("manual");
}
