/*
 * Baut Vencord mit allen eigenen Plugins aus diesem Ordner.
 *
 *   node build.mjs              Plugins synchronisieren + bauen
 *   node build.mjs --inject     ... und in dein Discord installieren
 *   node build.mjs --package    ... und ein Paket für Freunde erstellen (release/)
 *   node build.mjs --release    ... Paket bauen und als GitHub-Release veröffentlichen
 *                               (Freunde bekommen es dann über den Vencord-Updater)
 *   node build.mjs --update     vorher Vencord aktualisieren (git pull + pnpm install)
 *
 * Jeder Unterordner mit einer index.ts / index.tsx gilt als Plugin.
 */

import { execSync } from "child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const ROOT = dirname(fileURLToPath(import.meta.url));
const VENCORD = join(ROOT, "Vencord");
const USERPLUGINS = join(VENCORD, "src", "userplugins");
const MANAGED_FILE = join(USERPLUGINS, ".managed.json");
const RELEASE = join(ROOT, "release");
// What friends get: one standalone exe; files/ is only the staging folder for what gets embedded into it
const FILES = join(RELEASE, "files");
const INSTALLER = join(RELEASE, "VoidCord-Installer.exe");
const IGNORED = new Set(["Vencord", "release", "node_modules", "dist"]);
// GitHub-Repo, aus dessen Releases der Vencord-Updater der Freunde lädt (muss öffentlich sein)
const REPO = "HW1312/VencordCustom";

const args = new Set(process.argv.slice(2));
if (args.has("--release")) args.add("--package");
const run = (cmd, cwd = VENCORD, env = {}) => execSync(cmd, { cwd, stdio: "inherit", env: { ...process.env, ...env } });
const git = cmd => execSync(`git ${cmd}`, { cwd: ROOT, encoding: "utf-8" }).trim();

if (!existsSync(VENCORD)) {
    console.error("Vencord-Ordner fehlt. Einmalig ausführen:\n  git clone https://github.com/Vendicated/Vencord.git && cd Vencord && pnpm install");
    process.exit(1);
}

// Version des Pakets = Commit dieses Ordners. Der Updater der Freunde vergleicht ihn mit dem
// Namen des neuesten Releases auf REPO und lädt bei Unterschied die neuen Dateien herunter.
let hash;
if (args.has("--package")) {
    hash = git("rev-parse --short HEAD");
    if (git("status --porcelain")) {
        if (args.has("--release")) {
            console.error("Es gibt nicht committete Änderungen. Erst committen, dann --release.");
            process.exit(1);
        }
        console.warn(`Achtung: nicht committete Änderungen, das Paket trägt trotzdem die Version ${hash}.`);
    }
}

if (args.has("--update")) {
    run("git pull");
    run("pnpm install --frozen-lockfile");
}

// ---- Plugins synchronisieren
const plugins = readdirSync(ROOT, { withFileTypes: true })
    .filter(d => d.isDirectory() && !IGNORED.has(d.name) && !/^[._]/.test(d.name))
    .filter(d => ["index.ts", "index.tsx"].some(f => existsSync(join(ROOT, d.name, f))))
    .map(d => d.name);

mkdirSync(USERPLUGINS, { recursive: true });

const previous = existsSync(MANAGED_FILE) ? JSON.parse(readFileSync(MANAGED_FILE, "utf-8")) : [];
for (const name of previous) rmSync(join(USERPLUGINS, name), { recursive: true, force: true });

// Gemeinsame Ordner (beginnen mit "_", Vencord lädt sie nicht als Plugin): z. B. _ui = Apple-UI-Kit aller Plugins
const shared = readdirSync(ROOT, { withFileTypes: true })
    .filter(d => d.isDirectory() && /^_[a-z]/i.test(d.name))
    .map(d => d.name);

for (const name of [...plugins, ...shared]) cpSync(join(ROOT, name), join(USERPLUGINS, name), { recursive: true });
writeFileSync(MANAGED_FILE, JSON.stringify([...plugins, ...shared]));

// Wann jedes Plugin dazukam (PluginHub sortiert danach und zeigt "NEW"):
// frühestes Datum aus Ordner-Erstellung und erstem Git-Commit
const added = {};
for (const dir of plugins) {
    const file = ["index.ts", "index.tsx"].map(f => join(ROOT, dir, f)).find(existsSync);
    const name = readFileSync(file, "utf-8").match(/definePlugin\(\{[\s\S]*?\bname:\s*"([^"]+)"/)?.[1];
    if (!name) continue;
    const dates = [statSync(join(ROOT, dir)).birthtimeMs];
    try {
        const first = git(`log --diff-filter=A --format=%ct -- "${dir}"`).split("\n").filter(Boolean).at(-1);
        if (first) dates.push(Number(first) * 1000);
    } catch { }
    added[name] = Math.round(Math.min(...dates.filter(d => d > 0)));
}
writeFileSync(join(USERPLUGINS, "PluginHub", "added.json"), JSON.stringify(added));

// Themes für den Theme Hub im PluginHub: jeder Unterordner von Themes/ mit einer *.theme.css.
// themes.json = Metadaten für die Oberfläche, themes-data.json = CSS, das nur native.ts kennt
// (so schreibt native.ts ausschließlich eigene Themes in den Theme-Ordner).
const THEMES = join(ROOT, "Themes");
const themeMeta = [];
const themeData = {};
if (existsSync(THEMES)) {
    for (const d of readdirSync(THEMES, { withFileTypes: true })) {
        if (!d.isDirectory()) continue;
        const dir = join(THEMES, d.name);
        const fileName = readdirSync(dir).find(f => f.endsWith(".theme.css"));
        if (!fileName) continue;
        const css = readFileSync(join(dir, fileName), "utf-8");
        const header = css.match(/^\s*\/\*\*([\s\S]*?)\*\//)?.[1] ?? "";
        const meta = Object.fromEntries([...header.matchAll(/@(\w+)[ \t]+([^\r\n]+)/g)].map(m => [m[1], m[2].trim()]));
        const extra = existsSync(join(dir, "theme.json")) ? JSON.parse(readFileSync(join(dir, "theme.json"), "utf-8")) : {};
        themeMeta.push({
            id: d.name,
            fileName,
            name: meta.name ?? d.name,
            author: meta.author ?? "",
            version: meta.version ?? "1.0.0",
            description: meta.description ?? "",
            colors: extra.colors ?? []
        });
        themeData[d.name] = { fileName, css };
    }
}
writeFileSync(join(USERPLUGINS, "PluginHub", "themes.json"), JSON.stringify(themeMeta));
writeFileSync(join(USERPLUGINS, "PluginHub", "themes-data.json"), JSON.stringify(themeData));

console.log(`Plugins: ${plugins.join(", ") || "(keine)"}`);
console.log(`Themes: ${themeMeta.map(t => t.name).join(", ") || "(keine)"}`);

// ---- Bauen

/**
 * Eigene Einstellungen pro Discord-Client: Vencord legt sonst Stable, PTB und Canary in denselben Ordner
 * (%APPDATA%\Vencord) – dann hätte Canary nach der Installation alle Plugins von Stable, und ein Plugin, das man
 * in einem Client ausschaltet, wäre in allen aus. Stable bleibt im alten Ordner, PTB / Canary bekommen
 * Vencord-ptb / Vencord-canary. Steht ganz oben in patcher.js, also bevor Vencord den Ordner bestimmt.
 */
const PER_CLIENT_SETTINGS = "// VoidCord: own settings per Discord client\n"
    + "try{const{app:a}=require(\"electron\"),p=require(\"path\"),u=a.getPath(\"userData\"),n=p.basename(u).toLowerCase();"
    + "if(!process.env.VENCORD_USER_DATA_DIR&&n.startsWith(\"discord\")&&n!==\"discord\")"
    + "process.env.VENCORD_USER_DATA_DIR=p.join(u,\"..\",\"Vencord-\"+n.slice(7))}catch{}\n";

function build(env) {
    run(`pnpm build${env ? " --standalone" : ""}`, VENCORD, env);
    const patcher = join(VENCORD, "dist", "patcher.js");
    // After "use strict" – in front of it, the bundle would no longer run in strict mode
    const code = readFileSync(patcher, "utf8").replace('"use strict";', `"use strict";${PER_CLIENT_SETTINGS}`);
    writeFileSync(patcher, code);
}

build();

if (args.has("--inject")) run("pnpm inject");

// ---- Paket für Freunde
// Der Updater im Paket schaut auf REPO statt aufs offizielle Vencord, überschreibt also die eigenen Plugins nicht
if (args.has("--package")) {
    build({ VENCORD_REMOTE: REPO, VENCORD_HASH: hash });

    rmSync(RELEASE, { recursive: true, force: true });
    mkdirSync(join(FILES, "dist"), { recursive: true });

    for (const f of readdirSync(join(VENCORD, "dist"))) {
        if (/^(patcher|preload|renderer)\.(js|css)$/.test(f))
            cpSync(join(VENCORD, "dist", f), join(FILES, "dist", f));
    }

    // dist/ wieder auf den normalen Build für dein eigenes Discord zurücksetzen
    build();
    for (const f of ["Installer.ps1", "logo.png", "icon.png"])
        cpSync(join(ROOT, "share", f), join(FILES, f));
    // Shown in the installer window
    writeFileSync(join(FILES, "version.txt"), hash);

    // Everything in files/ goes into the exe as resources "files/<path>"; the exe unpacks them and
    // starts the installer window without a console. Compiled with the C# compiler that ships with Windows.
    const resources = readdirSync(FILES, { recursive: true, withFileTypes: true })
        .filter(d => d.isFile())
        .map(d => join(d.parentPath, d.name))
        .map(p => `/resource:"${p}",files/${p.slice(FILES.length + 1).replaceAll("\\", "/")}`);
    const csc = join(process.env.WINDIR, "Microsoft.NET", "Framework64", "v4.0.30319", "csc.exe");
    const sma = join(process.env.WINDIR, "Microsoft.NET", "assembly", "GAC_MSIL", "System.Management.Automation", "v4.0_3.0.0.0__31bf3856ad364e35", "System.Management.Automation.dll");
    execSync(`"${csc}" /nologo /target:winexe /optimize+ /win32icon:"${join(ROOT, "share", "icon.ico")}" /r:System.Windows.Forms.dll /r:"${sma}" ${resources.join(" ")} /out:"${INSTALLER}" "${join(ROOT, "share", "Launcher.cs")}"`, { stdio: "inherit" });
    console.log(`\nInstaller erstellt: ${INSTALLER} (Version ${hash})`);
}

// ---- GitHub-Release
if (args.has("--release")) {
    // Der Commit muss auf GitHub liegen, sonst findet der Updater keinen Changelog
    run("git push", ROOT);

    const assets = ["patcher.js", "preload.js", "renderer.js", "renderer.css"]
        .map(f => `"${join(FILES, "dist", f)}"`)
        // Older installers fetch the new exe from here to update themselves
        .concat(`"${INSTALLER}"`);
    // Release notes = commit body, shown as changelog in the UpdateButton plugin. One line per change:
    //   - Added: Plugin X in the Plugin Hub
    //   - Fixed: Popout shows GIFs again
    //   - Removed: Stream checklist
    // Without a body the commit title is used.
    const body = git("log -1 --format=%b").split(/\r?\n/)
        .filter(l => l.trim() && !/^co-authored-by:/i.test(l.trim()))
        .join("\n");
    const notesFile = join(RELEASE, "notes.md");
    writeFileSync(notesFile, body || git("log -1 --format=%s"));

    run(`gh release create ${hash} ${assets.join(" ")} --repo ${REPO} --target ${git("rev-parse HEAD")} --title "VencordCustom ${hash}" --notes-file "${notesFile}"`, ROOT);
    console.log(`\nRelease ${hash} veröffentlicht. Freunde bekommen es beim nächsten Discord-Start.`);
}
