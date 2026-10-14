# OpenMusic feature parity tracker

Status vocabulary: `NOT_STARTED`, `IN_PROGRESS`, `PARTIAL`, `COMPLETE`, `VERIFIED`. `VERIFIED` requires reproducible runtime evidence and a recorded tested OS/device.

No features are marked VERIFIED as no Rust build or audio-device runtime testing was possible in this environment. `COMPLETE` is likewise withheld pending validation.

| Feature | Expected behavior | Status | Automated tests | Manual verification | Limitations | Platforms |
|---|---|---|---|---|---|---|
| Desktop shell | Native desktop window | IN_PROGRESS | No | Not run | Uncompiled source scaffold | macOS/Windows/Linux targeted |
| Local playback | Play real user-owned tracks | PARTIAL | No | Not run | Decoder and device compatibility unverified; async failures currently stderr | Desktop targeted |
| Pause / resume / stop | Control current player | PARTIAL | No | Not run | No UI feedback for command failures | Desktop targeted |
| Seek / volume | Adjust playback | PARTIAL | Volume bounds test (not run) | Not run | Seeking may be codec-dependent | Desktop targeted |
| Codec formats | MP3/AAC/FLAC/WAV/ALAC/OGG as available | IN_PROGRESS | No | Not run | Decoder coverage unverified | Desktop targeted |
| Library import | Scan a local folder recursively, chosen via native folder picker | PARTIAL | No | Picker opened on Windows 11 (2026-10-14); import not yet verified | No cancellation/progress; basic filename metadata only | Desktop targeted |
| Metadata | Artist/album/length/artwork tags | NOT_STARTED | No | Not run | Placeholder values shown | — |
| Library search | Search title/album/artist | PARTIAL | Empty-search unit test (not run) | Not run | SQL LIKE; 500 result limit, no FTS | Desktop/CLI targeted |
| Persistent library | Save indexed tracks | PARTIAL | DB schema test (not run) | Not run | SQLite WAL only | Desktop/CLI targeted |
| Playlists | Create, list, add, browse | PARTIAL | Create/list unit test (not run) | Not run | No delete/reorder/export | Desktop/CLI targeted |
| Queue and next/previous | Ordered playback, auto advance | NOT_STARTED | No | Not run | Next disabled | — |
| Shuffle / repeat / gapless / crossfade | Gapless configurable playback | NOT_STARTED | No | Not run | Not implemented | — |
| Recommendations | Local listening-based discovery | NOT_STARTED | No | Not run | Not implemented | — |
| Lossless / hi-res / EQ | Hardware-specific processing | NOT_STARTED | No | Not run | Decoder playback only | — |
| Lyrics | Licensed synchronized lyrics | NOT_STARTED | No | Not run | Not implemented | — |
| OS media controls | Media key integration | NOT_STARTED | No | Not run | Not implemented | — |
| Desktop library UI | Responsive list, playback controls | PARTIAL | TypeScript build check (not run) | Not run | No artwork, paging, shortcuts | Desktop targeted |
| CLI commands | Shared Rust dispatcher | PARTIAL | Dispatcher unit test (not run) | Not run | CLI and desktop have different DB location | CLI targeted |
| Automation JSON-lines | Long-lived local process API | PARTIAL | No | Not run | stdio only, no auth/network API | CLI targeted |
| MCP server | Standard MCP transport | NOT_STARTED | No | Not run | Not implemented | — |
| Authorized streaming | Provider abstraction & rights | NOT_STARTED | No | Not run | Local files only | — |
| Web/WASM | Browser playback and UI | NOT_STARTED | No | Not run | Native audio incompatible with browser | — |
| BSD | Native release | NOT_STARTED | No | Not run | Tauri/platform support investigation needed | — |
| 100k-track scale | Smooth lists and indexed search | NOT_STARTED | No | Not run | UI shows <=1000 tracks, no virtualization | — |
| Web app (PWA) | Installable phone/browser app at music.khoi-san.co.za | PARTIAL | No | Chrome headless, phone viewport (2026-10-14): installed service worker, imported an MP3, played it, played again after offline reload | Not yet tested on a real Android/iPhone or deployed; no track removal | Android/iOS/desktop browsers |
| Web offline playback | Songs stored in IndexedDB on device; app shell cached by service worker | PARTIAL | No | Same run: playback advanced with network disabled | Storage may be evicted by the browser; iOS background audio unverified | Android/iOS targeted |
| Web lock-screen controls | Media Session metadata, play/pause/seek | IN_PROGRESS | No | Not run on a phone | Next track unavailable (no queue) | Android/iOS targeted |
