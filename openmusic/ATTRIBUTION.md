# Attribution and licensing

OpenMusic original code: MIT intended; see `LICENSE-MIT`. Third-party dependency licenses require review before packaged public release.

Dependencies declared in manifests (licenses and compatibility **must be checked against locked versions before distribution**):

- Rust: Tauri, tauri-build, tauri-plugin-dialog, Rodio, Rusqlite (bundled SQLite), serde, serde_json, thiserror, walkdir, ureq (MIT/Apache-2.0, with rustls and webpki-roots) for LRCLIB lookups.
- Frontend: React, React DOM, Vite, TypeScript, @tauri-apps/api, @tauri-apps/plugin-dialog, @tauri-apps/cli, lucide-react and @types packages.
- Application icon: original vector-inspired musical note raster drawn for this repository; no Apple Music assets.

Lyrics data: looked up at runtime from LRCLIB (https://lrclib.net), a community-contributed database. Its lyrics are not licensed from publishers; using it is an owner decision recorded in AGENTS.md rule 11, and the app credits LRCLIB wherever its lyrics appear. No lyrics are bundled.

CI only (not shipped): SamKirkland/FTP-Deploy-Action (MIT) uploads the web build.

No commercial music recordings, album artwork or proprietary assets are bundled. No claims of dependency-license review completed.
