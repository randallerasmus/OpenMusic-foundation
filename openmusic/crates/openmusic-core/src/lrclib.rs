//! Lyrics lookup on LRCLIB (https://lrclib.net), a community-run lyrics database with a free, keyless API.
//! LRCLIB's lyrics are not licensed from publishers; using it is a recorded owner decision (AGENTS.md rule 11).
//! Lookups happen only on request for one song, send just its title/artist, and results are credited in the UI.
//! Ranking is pure and unit-tested; src/lrclib.ts is the browser port.

use crate::Track;
use serde::{Deserialize, Serialize};

const API: &str = "https://lrclib.net/api/search";
const USER_AGENT: &str = concat!("OpenMusic/", env!("CARGO_PKG_VERSION"), " (https://github.com/randallerasmus/OpenMusic-foundation)");
const UNKNOWN_ARTIST: &str = "Unknown Artist";

/// One LRCLIB search result, as the API returns it.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Record {
    pub id: i64,
    #[serde(default)] pub track_name: String,
    #[serde(default)] pub artist_name: String,
    #[serde(default)] pub album_name: String,
    pub duration: Option<f64>,
    #[serde(default)] pub instrumental: bool,
    pub plain_lyrics: Option<String>,
    pub synced_lyrics: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Candidate {
    pub id: i64, pub track: String, pub artist: String, pub album: String,
    pub duration_seconds: Option<f64>, pub synced: bool,
    /// Timed LRC when available, else plain text.
    pub lyrics: String,
    pub score: i32,
}

#[derive(Debug, Clone, Serialize)]
pub struct Lookup {
    pub candidates: Vec<Candidate>,
    /// True when the best candidate is safe to save without asking (title matches and length or artist agrees).
    pub confident: bool,
    /// What was searched, so the UI can prefill "search again".
    pub query: String,
}

/// Turns a file-derived title into something searchable: drops track numbers, underscores and video-ish tags.
pub fn clean_title(raw: &str) -> String {
    let mut s = raw.replace('_', " ").trim().to_owned();
    // A leading track number: "01 Song", "01 - Song", "3. Song", "3) Song". A bare "7 Rings" or "1999" is left alone.
    let digits = s.chars().take_while(|c| c.is_ascii_digit()).count();
    let after = s[digits..].chars().next();
    let numbered = digits > 0 && digits <= 3 && match after { Some('.') | Some(')') | Some('-') => true, Some(' ') => digits == 2 || s[digits..].trim_start().starts_with('-'), _ => false };
    if numbered {
        let rest = s[digits..].trim_start_matches([' ', '.', '-', ')']).to_owned();
        if !rest.is_empty() { s = rest; }
    }
    // Bracketed tags like "(Official Video)", "[Lyrics]", "(HD)"; musical ones like "(Live)" stay.
    const JUNK: [&str; 9] = ["official", "video", "audio", "lyric", "lyrics", "visualizer", "visualiser", "hd", "4k"];
    let mut out = String::new();
    let mut chars = s.chars();
    while let Some(c) = chars.next() {
        if c == '(' || c == '[' {
            let close = if c == '(' { ')' } else { ']' };
            let inner: String = chars.by_ref().take_while(|&x| x != close).collect();
            let lower = inner.to_lowercase();
            if !lower.split(|ch: char| !ch.is_alphanumeric()).any(|w| JUNK.contains(&w)) { out.push(c); out.push_str(&inner); out.push(close); }
        } else { out.push(c); }
    }
    out.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Lowercase alphanumerics with bracketed parts and a trailing "live" removed, so "Center (Live)",
/// "Center - Live" and "center" all compare equal.
fn norm(s: &str) -> String {
    let mut depth = 0i32;
    let mut out = String::new();
    for c in s.chars() {
        match c {
            '(' | '[' => depth += 1,
            ')' | ']' => depth = (depth - 1).max(0),
            c if depth == 0 && c.is_alphanumeric() => out.extend(c.to_lowercase()),
            _ => {}
        }
    }
    match out.strip_suffix("live") { Some(rest) if !rest.is_empty() => rest.to_owned(), _ => out }
}

/// Search parameter sets to try in order, until one returns results.
pub fn queries(track: &Track, user_query: Option<&str>) -> Vec<Vec<(&'static str, String)>> {
    if let Some(q) = user_query.map(str::trim).filter(|q| !q.is_empty()) { return vec![vec![("q", q.to_owned())]]; }
    let title = clean_title(&track.title);
    let artist = track.artist.trim();
    if artist.is_empty() || artist == UNKNOWN_ARTIST { return vec![vec![("q", title)]]; }
    vec![vec![("track_name", title.clone()), ("artist_name", artist.to_owned())], vec![("q", format!("{title} {artist}"))]]
}

/// Scores results against the song. Duration is the strongest signal: covers and live versions differ by seconds.
pub fn rank(track: &Track, duration: Option<f64>, records: Vec<Record>) -> (Vec<Candidate>, bool) {
    let want_title = norm(&clean_title(&track.title));
    let artist = (track.artist != UNKNOWN_ARTIST).then(|| norm(&track.artist)).filter(|a| !a.is_empty());
    let mut out: Vec<(Candidate, bool, Option<f64>)> = records.into_iter().filter_map(|r| {
        let lyrics = r.synced_lyrics.clone().filter(|s| !s.trim().is_empty()).or_else(|| r.plain_lyrics.clone().filter(|s| !s.trim().is_empty()))?;
        if r.instrumental { return None; }
        let title = norm(&r.track_name);
        let title_score = if !want_title.is_empty() && title == want_title { 4 } else if !want_title.is_empty() && !title.is_empty() && (title.contains(&want_title) || want_title.contains(&title)) { 2 } else { 0 };
        let artist_hit = artist.as_ref().is_some_and(|a| { let b = norm(&r.artist_name); !b.is_empty() && (b.contains(a.as_str()) || a.contains(&b)) });
        let diff = match (duration, r.duration) { (Some(a), Some(b)) => Some((a - b).abs()), _ => None };
        let duration_score = match diff { Some(d) if d <= 2.0 => 4, Some(d) if d <= 5.0 => 2, Some(d) if d > 20.0 => -4, _ => 0 };
        let synced = r.synced_lyrics.as_deref().is_some_and(|s| !s.trim().is_empty());
        let score = title_score + if artist_hit { 3 } else { 0 } + duration_score + if synced { 1 } else { 0 };
        Some((Candidate { id: r.id, track: r.track_name, artist: r.artist_name, album: r.album_name, duration_seconds: r.duration, synced, lyrics, score },
              title_score > 0 && (artist_hit || diff.is_some()), diff))
    }).collect();
    out.sort_by(|a, b| b.0.score.cmp(&a.0.score));
    let confident = out.first().is_some_and(|(_, title_ok, diff)| *title_ok && match (diff, duration) {
        (Some(d), _) => *d <= 5.0,
        (None, None) => artist.is_some(),   // no length to compare: trust a title + artist match
        (None, Some(_)) => false,
    });
    (out.into_iter().map(|(c, _, _)| c).take(20).collect(), confident)
}

/// Searches LRCLIB for `track`, or for `user_query` when given. Blocking; call off any UI thread.
pub fn lookup(track: &Track, user_query: Option<&str>, duration: Option<f64>) -> Result<Lookup, String> {
    let agent = ureq::AgentBuilder::new().timeout(std::time::Duration::from_secs(12)).user_agent(USER_AGENT).build();
    let attempts = queries(track, user_query);
    let mut last_query = String::new();
    for params in &attempts {
        last_query = params.iter().map(|(_, v)| v.as_str()).collect::<Vec<_>>().join(" ");
        // LRCLIB occasionally answers 5xx under load; one retry after a short pause usually succeeds.
        let send = || { let mut req = agent.get(API); for (k, v) in params { req = req.query(k, v); } req.call() };
        let result = match send() {
            Err(ureq::Error::Status(code, _)) if code >= 500 => { std::thread::sleep(std::time::Duration::from_millis(1200)); send() }
            other => other,
        };
        let body = match result {
            Ok(res) => res.into_string().map_err(|e| format!("Couldn't read LRCLIB's reply: {e}"))?,
            Err(ureq::Error::Status(429, _)) => return Err("LRCLIB is busy right now; try again in a minute.".into()),
            Err(ureq::Error::Status(code, _)) => return Err(format!("LRCLIB returned an error ({code}).")),
            Err(e) => return Err(format!("Couldn't reach LRCLIB (are you online?): {e}")),
        };
        let records: Vec<Record> = serde_json::from_str(&body).map_err(|e| format!("Unexpected reply from LRCLIB: {e}"))?;
        if !records.is_empty() {
            let (candidates, confident) = rank(track, duration, records);
            return Ok(Lookup { candidates, confident, query: last_query });
        }
    }
    Ok(Lookup { candidates: vec![], confident: false, query: last_query })
}

#[cfg(test)]
mod tests {
    use super::*;
    fn track(title: &str, artist: &str) -> Track { Track { id: 1, path: "x".into(), title: title.into(), artist: artist.into(), album: "Unknown Album".into(), duration_seconds: None } }
    fn rec(id: i64, name: &str, artist: &str, dur: f64, synced: bool) -> Record {
        Record { id, track_name: name.into(), artist_name: artist.into(), album_name: String::new(), duration: Some(dur), instrumental: false,
                 plain_lyrics: Some("words".into()), synced_lyrics: synced.then(|| "[00:01.00]words".into()) }
    }

    #[test] fn cleans_file_style_titles() {
        assert_eq!(clean_title("03 - Center_(Live)"), "Center (Live)");
        assert_eq!(clean_title("Center (Official Lyric Video)"), "Center");
        assert_eq!(clean_title("1. Way Maker [HD]"), "Way Maker");
        assert_eq!(clean_title("Goodness of God (Live) [Official Music Video]"), "Goodness of God (Live)");
        assert_eq!(clean_title("1999"), "1999", "a title that is only digits stays");
        assert_eq!(clean_title("7 Rings"), "7 Rings");
        assert_eq!(clean_title("01 Center"), "Center");
    }
    #[test] fn unknown_artist_searches_by_title_only() {
        assert_eq!(queries(&track("01 Center", "Unknown Artist"), None), vec![vec![("q", "Center".to_owned())]]);
        let q = queries(&track("Center", "Bethel Music"), None);
        assert_eq!(q[0], vec![("track_name", "Center".to_owned()), ("artist_name", "Bethel Music".to_owned())]);
        assert_eq!(queries(&track("x", "y"), Some("  my query ")), vec![vec![("q", "my query".to_owned())]]);
    }
    #[test] fn duration_picks_the_right_version_and_is_confident() {
        let (c, sure) = rank(&track("Center (Live)", "Unknown Artist"), Some(465.0),
            vec![rec(1, "Center", "Someone Else", 210.0, true), rec(2, "Center (Live)", "Bethel Music", 465.4, true), rec(3, "Center - Live", "Bethel Music", 466.0, false)]);
        assert_eq!(c[0].id, 2);
        assert!(sure);
        assert!(c[0].synced && c[0].lyrics.starts_with('['));
    }
    #[test] fn wrong_length_is_not_confident() {
        let (c, sure) = rank(&track("Center", "Unknown Artist"), Some(300.0), vec![rec(1, "Center", "Bethel Music", 465.0, true)]);
        assert_eq!(c.len(), 1);
        assert!(!sure, "title matches but length is far off: ask the user");
    }
    #[test] fn without_length_needs_artist_to_be_confident() {
        assert!(rank(&track("Center", "Bethel Music"), None, vec![rec(1, "Center", "Bethel Music", 465.0, true)]).1);
        assert!(!rank(&track("Center", "Unknown Artist"), None, vec![rec(1, "Center", "Bethel Music", 465.0, true)]).1);
    }
    #[test] fn skips_instrumentals_and_empty_lyrics() {
        let mut inst = rec(1, "Center", "A", 465.0, true); inst.instrumental = true;
        let mut empty = rec(2, "Center", "A", 465.0, false); empty.plain_lyrics = Some("  ".into());
        let (c, sure) = rank(&track("Center", "Unknown Artist"), Some(465.0), vec![inst, empty]);
        assert!(c.is_empty() && !sure);
    }
    #[test] fn parses_api_records() {
        let json = r#"[{"id":7,"name":"Center","trackName":"Center","artistName":"Bethel Music","albumName":"A","duration":465.0,"instrumental":false,"plainLyrics":"x","syncedLyrics":null,"lyricsfile":"..."}]"#;
        let r: Vec<Record> = serde_json::from_str(json).unwrap();
        assert_eq!(r[0].track_name, "Center"); assert_eq!(r[0].synced_lyrics, None);
    }
}
