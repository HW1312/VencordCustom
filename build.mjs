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
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const ROOT = dirname(fileURLToPath(import.meta.url));
const VENCORD = join(ROOT, "Vencord");
const USERPLUGINS = join(VENCORD, "src", "userplugins");
const MANAGED_FILE = join(USERPLUGINS, ".managed.json");
const RELEASE = join(ROOT, "release");
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

for (const name of plugins) cpSync(join(ROOT, name), join(USERPLUGINS, name), { recursive: true });
writeFileSync(MANAGED_FILE, JSON.stringify(plugins));

console.log(`Plugins: ${plugins.join(", ") || "(keine)"}`);

// ---- Bauen
run("pnpm build");

if (args.has("--inject")) run("pnpm inject");

// ---- Paket für Freunde
// Der Updater im Paket schaut auf REPO statt aufs offizielle Vencord, überschreibt also die eigenen Plugins nicht
if (args.has("--package")) {
    run("pnpm build --standalone", VENCORD, { VENCORD_REMOTE: REPO, VENCORD_HASH: hash });

    rmSync(RELEASE, { recursive: true, force: true });
    mkdirSync(join(RELEASE, "dist"), { recursive: true });

    for (const f of readdirSync(join(VENCORD, "dist"))) {
        if (/^(patcher|preload|renderer)\.(js|css)$/.test(f))
            cpSync(join(VENCORD, "dist", f), join(RELEASE, "dist", f));
    }

    // dist/ wieder auf den normalen Build für dein eigenes Discord zurücksetzen
    run("pnpm build");
    cpSync(join(ROOT, "share", "install.bat"), join(RELEASE, "install.bat"));
    cpSync(join(ROOT, "share", "uninstall.bat"), join(RELEASE, "uninstall.bat"));
    cpSync(join(ROOT, "share", "README.txt"), join(RELEASE, "README.txt"));

    const zip = join(ROOT, "VencordCustom.zip");
    rmSync(zip, { force: true });
    execSync(`powershell -NoProfile -Command "Compress-Archive -Path '${RELEASE}\\*' -DestinationPath '${zip}'"`, { stdio: "inherit" });
    console.log(`\nPaket erstellt: ${zip} (Version ${hash})`);
}

// ---- GitHub-Release
if (args.has("--release")) {
    // Der Commit muss auf GitHub liegen, sonst findet der Updater keinen Changelog
    run("git push", ROOT);

    const assets = ["patcher.js", "preload.js", "renderer.js", "renderer.css"]
        .map(f => `"${join(RELEASE, "dist", f)}"`)
        .concat(`"${join(ROOT, "VencordCustom.zip")}"`);
    const notes = git("log -1 --format=%s").replace(/"/g, "'");

    run(`gh release create ${hash} ${assets.join(" ")} --repo ${REPO} --target ${git("rev-parse HEAD")} --title "VencordCustom ${hash}" --notes "${notes}"`, ROOT);
    console.log(`\nRelease ${hash} veröffentlicht. Freunde bekommen es beim nächsten Discord-Start.`);
}
