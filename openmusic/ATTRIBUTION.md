# Attribution and licensing

OpenMusic original code: MIT intended; see `LICENSE-MIT`. Third-party dependency licenses require review before packaged public release.

Dependencies declared in manifests (licenses and compatibility **must be checked against locked versions before distribution**):

- Rust: Tauri, tauri-build, tauri-plugin-dialog, Rodio, Rusqlite (bundled SQLite), serde, serde_json, thiserror, walkdir, ureq (MIT/Apache-2.0, with rustls and webpki-roots) for LRCLIB lookups.
- Frontend: React, React DOM, Vite, TypeScript, @tauri-apps/api, @tauri-apps/plugin-dialog, @tauri-apps/cli, lucide-react and @types packages; @ffmpeg/ffmpeg and @ffmpeg/util 0.12.x (MIT) load the audio converter.
- Audio converter (served as separate files from `public/ffmpeg/0.12.10-lgpl-1/`, loaded only when converting to MP3): FFmpeg n5.1.4 compiled to WebAssembly with ffmpeg.wasm v0.12.10 bindings, configured **without** `--enable-gpl`, so it is **LGPL 2.1 or later** (licence text and source links in that folder's `LICENSE.txt` / `README.txt`). Linked: LAME (LGPL), libopus, libvorbis, libogg (BSD), SDL2 (zlib). Rebuild with `scripts/ffmpeg/build-lgpl.sh`; users may replace these files with their own build of the same sources. Not used: x264, x265, libpostproc or any GPL component.
- Application icon: original vector-inspired musical note raster drawn for this repository; no Apple Music assets.

Lyrics data: looked up at runtime from LRCLIB (https://lrclib.net), a community-contributed database. Its lyrics are not licensed from publishers; using it is an owner decision recorded in AGENTS.md rule 11, and the app credits LRCLIB wherever its lyrics appear. No lyrics are bundled.

CI only (not shipped): SamKirkland/FTP-Deploy-Action (MIT) uploads the web build.

No commercial music recordings, album artwork or proprietary assets are bundled. No claims of dependency-license review completed.
