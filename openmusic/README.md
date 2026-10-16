# OpenMusic — functional foundation (v0.1.0)

OpenMusic is an independently designed, open-source, local-first music player. This repository contains *source code*, not a precompiled app or an Apple Music-compatible streaming service.

## What works in this foundation (implementation, not independently runtime-verified)

- Desktop app skeleton powered by **Tauri 2 + React + TypeScript**.
- Rust audio playback via Rodio/CPAL (play, pause, resume, stop, seek, volume) of imported user-owned audio files, subject to codec/device availability.
- SQLite WAL-mode database; recursive folder import; basic searchable local library with track title derived from filename.
- Persistent playlists (create, list, add track, list tracks).
- Persistent play queue: play a list from any song, next/previous, automatic advance at end of track, play next / add to queue, reorder, remove, shuffle and repeat (off/all/one). The queue survives restarts (SQLite on desktop/CLI, localStorage on web).
- Extract audio from your own videos: choose a video or audio file (for example one downloaded from YouTube Studio) and get **MP3** (converted on the device by an LGPL, audio-only ffmpeg.wasm build, about 7 MB downloaded on first use) or **M4A** (an exact copy of AAC/ALAC audio from MP4/MOV/M4V), then add it to the library and/or save the file. Web app only for now. Rebuild the converter with `scripts/ffmpeg/build-lgpl.sh` (needs Docker).
- YouTube in Search: with your API key, a submitted search also shows YouTube results (official API, ~100 searches/day on the free quota). They play in YouTube's own embedded player, on screen with video, as YouTube's terms require: no audio-only, background or ad-free playback.
- My YouTube Channel: lists your public uploads through the official YouTube Data API v3 using your own API key (kept on the device), with links to download each video in YouTube Studio. OpenMusic never downloads media from YouTube itself.
- Lyrics: your own (a `.lrc` file with the same name beside the song, one chosen with it when importing on web, or pasted) show first; otherwise the song is looked up on [LRCLIB](https://lrclib.net), a community lyrics database, when you open the lyrics view, and a confident match is saved and credited (else you pick from results or search). Timed lyrics follow playback; tap a line to jump to it. LRCLIB lyrics are not publisher-licensed; see AGENTS.md rule 11.
- Central `MusicApp::execute(name, args)` command dispatcher shared by Tauri and CLI.
- JSON-lines CLI control mode (`serve-stdio`), reusable by agents with an explicitly launched local process.

**Important limitations:** Track artist/album tags and duration are NOT extracted yet. Gapless playback, crossfade, autoplay, lossless-specific hardware configuration, album art, background media keys (desktop), streaming, MCP and advanced accessibility are NOT implemented. Individual codec support depends on Rodio decoder compatibility. If audio output or decoding fails, errors go to stderr for now rather than being propagated through the command acknowledgment; this is tracked for improvement.

## Prerequisites

1. Install Rust stable + Cargo from https://rustup.rs/ (for compilation).
2. Install Node.js 20+ and npm.
3. Install [Tauri 2 system dependencies](https://v2.tauri.app/start/prerequisites/) for your OS.
4. Install a functional audio output device. On Linux this usually includes ALSA development packages.

## Run (macOS / Windows / Linux)

```bash
npm install
npm run tauri dev
```

Select **Import music** and choose a folder in the native folder picker. The app indexes matching audio files; double-click a row or use its Play button.

Build an installer via `npm run tauri build` after the platform prerequisites are satisfied. The project has not been compiled in the generation environment, so dependency/API adjustments may be necessary.

## Web app (Android / iPhone, offline)

The same React UI also runs as an installable web app (PWA), intended for `https://music.khoi-san.co.za`.

- Songs are chosen with the phone's file picker and **copied into the browser's on-device storage (IndexedDB)**. Nothing is uploaded; the server only hosts the app's code.
- A generated service worker (`dist/sw.js`, see `vite.config.ts`) caches the app, so it opens and plays with no network after the first visit.
- Playback uses the browser's `<audio>` element with Media Session lock-screen controls.
- `src/backend.ts` picks the backend: Tauri → Rust `MusicApp::execute`; browser → `src/webBackend.ts`, which mirrors the same command names and response shapes. This mirror exists because Rodio/SQLite cannot run in a phone browser; keep the two in sync when commands change.

Build and test locally:

```bash
npm run build
npx vite preview --port 4173   # open http://localhost:4173
```

Ship (commit + push + deploy in one step): `npm run ship -- "What changed"`. It builds first and stops on errors, commits every change, and pushes the current branch. Pushing `master` runs `.github/workflows/deploy.yml`, which builds the site and uploads it to music.khoi-san.co.za over FTPS (via SamKirkland/FTP-Deploy-Action, used only in CI), then checks the live site serves the new build. One-time setup: add the repository secrets `FTP_SERVER`, `FTP_USERNAME`, `FTP_PASSWORD` and `FTP_SERVER_DIR` (the site's folder, ending in `/`) under GitHub → Settings → Secrets and variables → Actions; set the variable `FTP_PROTOCOL` to `ftp` only if the host has no TLS.

Versions and rollback: every deploy from `master` is a numbered build. It is tagged `build-N` and gets a GitHub Release (the Releases page is the deploy history, with what changed in each). The app shows its build at the bottom of Library (e.g. "OpenMusic 0.1.0 · build 15 · a1b2c3d"), and `https://music.khoi-san.co.za/version.json` reports the live version, build, commit and time. To roll back: Actions → Deploy web app → Run workflow → "Version to deploy" = `build-N` → Run; that exact build goes live again without creating a new release. Rolling back never deletes a device's music: newer on-device library versions only add storage, and builds from this one on open them safely (builds before it, i.e. `build-5`, can't open a library upgraded by later builds that change its layout). Bump `version` in `package.json` for notable releases; build numbers count every deploy. Only `master` deploys; other branches are checked by CI only.

Manual deploy: upload `dist/` to any static HTTPS host (Cloudflare Pages and Netlify read `public/_headers`, which keeps `sw.js` revalidating so updates reach installed apps), then point the `music` DNS record at it. On the phone, open the site and use **Add to Home Screen** (Safari share menu on iPhone; Chrome menu → Install app on Android).

Web limitations: no folder scanning (pick files instead); no track removal yet; codec support is the browser's (MP3 and M4A/AAC everywhere, FLAC on modern browsers, OGG/ALAC vary); iOS background playback for home-screen web apps is less reliable than native; browsers may evict storage under pressure (the app requests persistent storage, which may be denied).

## CLI

```bash
cargo run -p openmusic-cli -- music.library.scan '{"path":"/Users/yourname/Music"}'
cargo run -p openmusic-cli -- music.library.list
cargo run -p openmusic-cli -- music.search '{"query":"piano"}'
cargo run -p openmusic-cli -- music.playlist.create '{"name":"Morning"}'
cargo run -p openmusic-cli -- music.queue.set '{"track_ids":[3,1,2],"start_index":0,"source":"Morning"}'
cargo run -p openmusic-cli -- serve-stdio
```

`serve-stdio` accepts one JSON command per line:

```json
{"command":"music.library.list","args":{}}
```

and returns one JSON object per line with `ok`, `data` or `error`.

Queue commands: `music.queue.get`, `music.queue.set {track_ids, start_index?, source?}`, `music.queue.add {track_ids, position?: "next"|"last"}`, `music.queue.jump {index}`, `music.queue.remove {index}`, `music.queue.move {from, to}`, `music.queue.clear`, `music.next`, `music.previous` (restarts the track after 3 s), `music.repeat.set {mode: "off"|"all"|"one"}`, `music.shuffle.set {enabled}`. `music.play {track_id}` plays a single track and replaces the queue with it. Lyrics commands: `music.lyrics.get {track_id}` (saved lyrics, else a `.lrc` beside the file, else null), `music.lyrics.set {track_id, text, source?: "saved"|"lrclib"}` (plain or LRC), `music.lyrics.lookup {track_id, query?, duration_seconds?}` (searches LRCLIB, returns ranked candidates and whether the best is a confident match; saves nothing), `music.lyrics.clear {track_id}` (saved lyrics only; your `.lrc` files are never touched). `music.status` also reports `position_ms`, `queue_index`, `queue_length`, `queue_revision`, `repeat`, `shuffle` and `has_next`. Playback runs while this process lives. **Desktop and CLI use distinct default database locations**; a configurable shared data directory is future work.

## Architecture

- `crates/openmusic-core`: persistence, library import, audio-thread orchestration, central command dispatcher.
- `crates/openmusic-cli`: direct JSON command invocation and long-lived stdio loop.
- `src-tauri`: desktop shell and command adapter.
- `src`: React UX shared by desktop and web; `backend.ts` selects the Tauri or browser (`webBackend.ts`) backend.

## Test

```bash
cargo test --workspace
npm run build
```

Tests are included but **not executed here** because Rust/Cargo are absent from the build environment. Likewise no live audio testing has been performed. Track real progress in `FEATURE_PARITY.md`.

## Security and rights

Only import media you are authorized to use. No DRM removal, Apple service integration or scraping is built. Directory imports do not follow symlinks. Tauri currently uses a permissive `csp: null` during the foundation phase; tighten CSP before release. The app does not upload listening history. For public releases, review dependency licenses, update `ATTRIBUTION.md`, audit file inputs, and implement explicit error propagation.

## Next engineering tasks

1. Run Tauri on target OS, fix compile/runtime issues, verify audio output.
2. Return playback errors in status / command responses, add tests with fixture audio.
3. Add music tag parsing and artwork; store durations and album/artist relationships.
4. Gapless playback and crossfade between queued tracks; skip unplayable tracks during auto-advance.
5. Add metadata editing UI.
6. Add OS media keys, robust tests, packaging/signed installers, MCP adapter.
