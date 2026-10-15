# OpenMusic agent rules

1. Inspect the entire repository and module boundaries before editing.
2. Use `MusicApp::execute` as the authoritative command registry: GUI and CLI must not duplicate core logic.
3. Keep audio device lifetime on its audio thread and database access out of real-time callbacks.
4. Do not panic on user inputs, invalid files or device errors. Return typed errors and report them visibly.
5. Add focused tests for new behavior; do not claim tests pass unless run.
6. Run `cargo test --workspace`, `npm run build`, and platform playback smoke tests where possible.
7. Review dependency licensing, update `ATTRIBUTION.md`, and avoid proprietary assets.
8. Never fabricate streaming results, album artwork, metadata or audio fixture playback.
9. Update `FEATURE_PARITY.md` with honest statuses and evidence on every feature change.
10. Prefer incremental commits and preserve on-disk schema and CLI compatibility.
11. No DRM circumvention, unauthorized content APIs, Apple trademarks, or copying proprietary interface artwork.
    Exception (owner decision, 2026-10-16): lyrics may be looked up on LRCLIB (lrclib.net), a community lyrics database whose lyrics are not publisher-licensed. The site owner accepts that copyright risk. Lookups must stay per-song and on demand, send only the song's title/artist, and credit LRCLIB wherever its lyrics are shown. No other unlicensed content source is allowed without a new owner decision recorded here.
12. Explicitly mark unavailable features as unavailable in the UI, not working.
