# Auralis

Shares what the **Spotify desktop app** is playing as a normal Discord music activity – read locally from Windows media
info. No Spotify OAuth, cookies or account link. Windows only (folder suffix `.desktop` = desktop builds only).

## What it does

- Reads title, artist, album and timeline of Spotify through a hidden PowerShell watcher (Windows media session API),
  polled every 0.5 s. A stuck watcher is dropped after 10 s and restarted.
- Shares title and artist as a "Listening" activity, optionally with timestamps and a public Spotify search button.
- Optional album cover (off by default): title and artist are sent to `api.deezer.com`; only covers from
  `cdn-images.dzcdn.net` are accepted. Covers are cached in memory only.
- Clears the activity on pause, when Spotify closes, on read errors or when sharing / the plugin is turned off.

The activity is rebuilt from an allowlist of fields – no Spotify user ID, profile URL, session ID or token.

Default application ID `1528896038163710112` is the public one from
[Taskbar Media Presence](https://github.com/MrBoxik/Taskbar-Media-Presence); Discord may show that app's name above the
activity. Put your own application ID in the settings to choose the name.

Not included: Spotify Canvas, track links, the original Spotify card, "Listen along", phone or web player.

## Tests

```powershell
node --test tests/*.test.mjs
```
