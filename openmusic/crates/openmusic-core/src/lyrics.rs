//! Lyrics the user supplies: pasted text or a `.lrc` file beside the audio. Nothing is fetched online.
//! Parsing lives in the core so every client shows the same lines; src/lyrics.ts is the browser port.

use serde::Serialize;

/// Largest lyrics text accepted, from a file or pasted. Real lyrics are a few kilobytes.
pub const MAX_LYRICS_BYTES: usize = 256 * 1024;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct LyricLine { pub time_ms: Option<u64>, pub text: String }

#[derive(Debug, Clone, Serialize)]
pub struct Lyrics {
    pub text: String,
    /// True when every line has a timestamp (LRC), so the UI can follow playback.
    pub synced: bool,
    pub lines: Vec<LyricLine>,
    /// "saved" (pasted or imported into the library), "lrclib" (looked up on lrclib.net), or "file" (a .lrc beside the audio).
    pub source: &'static str,
}

impl Lyrics {
    pub fn new(text: String, source: &'static str) -> Self {
        match parse_lrc(&text) {
            Some(lines) => Self { text, synced: true, lines, source },
            None => {
                let lines = text.trim().lines().map(|l| LyricLine { time_ms: None, text: l.trim().to_owned() }).collect();
                Self { text, synced: false, lines, source }
            }
        }
    }
}

/// Parses LRC lines such as `[01:02.50]words` (several timestamps per line allowed) and honours `[offset:±ms]`.
/// Returns timed lines sorted by time, or None when the text has no timestamps (plain lyrics).
pub fn parse_lrc(text: &str) -> Option<Vec<LyricLine>> {
    let mut offset: i64 = 0;
    let mut timed: Vec<(u64, String)> = vec![];
    for raw in text.lines() {
        let mut rest = raw.trim();
        let mut times = vec![];
        // Leading timestamps; a non-time bracket after them (e.g. "[Chorus]") stays part of the text.
        while let Some(inner) = rest.strip_prefix('[') {
            let Some(end) = inner.find(']') else { break };
            match parse_timestamp(&inner[..end]) {
                Some(t) => { times.push(t); rest = inner[end + 1..].trim_start(); }
                None => break,
            }
        }
        if times.is_empty() {
            // Metadata such as [ar:Artist]; only the offset affects timing.
            if let Some(v) = rest.strip_prefix("[offset:").and_then(|v| v.strip_suffix(']')) { offset = v.trim().parse().unwrap_or(0); }
            continue;
        }
        for t in times { timed.push((t, rest.trim_end().to_owned())); }
    }
    if timed.is_empty() { return None; }
    // A positive offset makes lyrics appear sooner.
    timed.sort_by_key(|(t, _)| *t);
    Some(timed.into_iter().map(|(t, text)| LyricLine { time_ms: Some((t as i64 - offset).max(0) as u64), text }).collect())
}

/// `mm:ss`, `mm:ss.x`, `mm:ss.xx`, `mm:ss.xxx` (or `:` before the fraction).
fn parse_timestamp(tag: &str) -> Option<u64> {
    let (m, rest) = tag.split_once(':')?;
    if m.is_empty() || !m.bytes().all(|b| b.is_ascii_digit()) { return None; }
    let (s, frac) = match rest.find(|c: char| c == '.' || c == ':') { Some(i) => (&rest[..i], &rest[i + 1..]), None => (rest, "") };
    if s.is_empty() || s.len() > 2 || !s.bytes().all(|b| b.is_ascii_digit()) { return None; }
    let seconds: u64 = s.parse().ok()?;
    if seconds >= 60 { return None; }
    let frac_ms = if frac.is_empty() { 0 } else {
        if frac.len() > 3 || !frac.bytes().all(|b| b.is_ascii_digit()) { return None; }
        frac.parse::<u64>().ok()? * 10u64.pow(3 - frac.len() as u32)
    };
    Some(m.parse::<u64>().ok()? * 60_000 + seconds * 1000 + frac_ms)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn line(t: u64, s: &str) -> LyricLine { LyricLine { time_ms: Some(t), text: s.into() } }

    #[test] fn parses_timestamps_and_skips_metadata() {
        let lines = parse_lrc("[ar:Someone]\n[ti:Song]\n[00:01.50]First\n[00:03]Second\n[01:02.345]Third\n").unwrap();
        assert_eq!(lines, vec![line(1500, "First"), line(3000, "Second"), line(62_345, "Third")]);
    }
    #[test] fn repeated_timestamps_and_sorting() {
        let lines = parse_lrc("[00:10.00][00:30.00]Chorus\n[00:20.00]Verse").unwrap();
        assert_eq!(lines, vec![line(10_000, "Chorus"), line(20_000, "Verse"), line(30_000, "Chorus")]);
    }
    #[test] fn offset_shifts_earlier_and_clamps_at_zero() {
        let lines = parse_lrc("[offset:+500]\n[00:00.20]a\n[00:02.00]b").unwrap();
        assert_eq!(lines, vec![line(0, "a"), line(1500, "b")]);
    }
    #[test] fn section_labels_after_timestamp_stay_in_text() {
        assert_eq!(parse_lrc("[00:05.00][Chorus] la la").unwrap(), vec![line(5000, "[Chorus] la la")]);
    }
    #[test] fn empty_timed_lines_are_kept_as_breaks() {
        assert_eq!(parse_lrc("[00:01]a\n[00:04]\n[00:06]b").unwrap()[1], line(4000, ""));
    }
    #[test] fn plain_text_is_not_lrc() {
        assert!(parse_lrc("Just words\nno timing [here]").is_none());
        let l = Lyrics::new("  Line one \n\nLine two\n".into(), "saved");
        assert!(!l.synced);
        assert_eq!(l.lines.iter().map(|x| x.text.as_str()).collect::<Vec<_>>(), vec!["Line one", "", "Line two"]);
    }
    #[test] fn rejects_malformed_timestamps() {
        for bad in ["[1:60]x", "[aa:10]x", "[00:1.2345]x", "[:10]x", "[00:]x", "[00:10.x]x"] { assert!(parse_lrc(bad).is_none(), "{bad}"); }
    }
}
