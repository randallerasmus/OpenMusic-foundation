use rodio::{Decoder, OutputStream, Sink, Source};
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{fs::File, io::BufReader, path::{Path, PathBuf}, sync::{mpsc, Arc, Mutex}, thread, time::Duration};
use thiserror::Error;
use walkdir::WalkDir;

#[derive(Debug, Error)]
pub enum MusicError {
    #[error("Database: {0}")] Database(#[from] rusqlite::Error),
    #[error("I/O: {0}")] Io(#[from] std::io::Error),
    #[error("Playback: {0}")] Playback(String),
    #[error("Invalid request: {0}")] Request(String),
}
pub type Result<T> = std::result::Result<T, MusicError>;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Track {
    pub id: i64, pub path: String, pub title: String, pub artist: String,
    pub album: String, pub duration_seconds: Option<u64>,
}
#[derive(Debug, Clone, Serialize)]
pub struct PlaybackState {
    pub track_id: Option<i64>, pub playing: bool, pub volume: f32,
    pub position_seconds: u64, pub duration_seconds: Option<u64>,
}
impl Default for PlaybackState {
    fn default() -> Self { Self { track_id: None, playing: false, volume: 0.75, position_seconds: 0, duration_seconds: None } }
}

enum AudioCommand { Play(Track), Pause, Resume, Stop, Seek(u64), Volume(f32), Shutdown }

/// Owns the audio device on a dedicated thread so that database and UI work never block its command loop.
/// The thread is intentionally not the real-time audio callback: Rodio/CPAL handle the callback.
struct AudioService { sender: mpsc::Sender<AudioCommand>, state: Arc<Mutex<PlaybackState>> }
impl AudioService {
    fn new() -> Self {
        let (sender, receiver) = mpsc::channel::<AudioCommand>();
        let state = Arc::new(Mutex::new(PlaybackState::default()));
        let shared = Arc::clone(&state);
        thread::spawn(move || {
            let mut stream_and_handle = OutputStream::try_default().ok();
            let mut sink: Option<Sink> = None;
            loop {
                let message = match receiver.recv_timeout(Duration::from_millis(200)) {
                    Ok(v) => Some(v), Err(mpsc::RecvTimeoutError::Timeout) => None,
                    Err(mpsc::RecvTimeoutError::Disconnected) => break,
                };
                match message {
                    Some(AudioCommand::Shutdown) => break,
                    Some(AudioCommand::Play(track)) => {
                        if let Some(old) = sink.take() { old.stop(); }
                        let playback = (|| -> std::result::Result<Sink, String> {
                            if stream_and_handle.is_none() { stream_and_handle = OutputStream::try_default().ok(); }
                            let (_, handle) = stream_and_handle.as_ref().ok_or("No audio output device")?;
                            let file = File::open(&track.path).map_err(|e| e.to_string())?;
                            let source = Decoder::new(BufReader::new(file)).map_err(|e| e.to_string())?;
                            let new_sink = Sink::try_new(handle).map_err(|e| e.to_string())?;
                            new_sink.append(source);
                            Ok(new_sink)
                        })();
                        match playback {
                            Ok(s) => {
                                if let Ok(mut st) = shared.lock() {
                                    s.set_volume(st.volume);
                                    st.track_id = Some(track.id); st.playing = true;
                                    st.position_seconds = 0; st.duration_seconds = track.duration_seconds;
                                }
                                sink = Some(s);
                            }
                            Err(message) => {
                                eprintln!("OpenMusic playback error for {}: {message}", track.path);
                                if let Ok(mut st) = shared.lock() { st.track_id = None; st.playing = false; }
                            }
                        }
                    }
                    Some(AudioCommand::Pause) => { if let Some(s) = &sink { s.pause(); } if let Ok(mut st) = shared.lock() { st.playing = false; } }
                    Some(AudioCommand::Resume) => { if let Some(s) = &sink { s.play(); if let Ok(mut st) = shared.lock() { st.playing = true; } } }
                    Some(AudioCommand::Stop) => { if let Some(s) = sink.take() { s.stop(); } if let Ok(mut st) = shared.lock() { st.track_id = None; st.playing = false; st.position_seconds = 0; } }
                    Some(AudioCommand::Seek(seconds)) => {
                        if let Some(s) = &sink { if let Err(e) = s.try_seek(Duration::from_secs(seconds)) { eprintln!("Seek failed: {e}"); } }
                    }
                    Some(AudioCommand::Volume(value)) => { if let Some(s) = &sink { s.set_volume(value); } if let Ok(mut st) = shared.lock() { st.volume = value; } }
                    None => {}
                }
                if let Some(s) = &sink {
                    if let Ok(mut st) = shared.lock() {
                        st.position_seconds = s.get_pos().as_secs();
                        if s.empty() { st.playing = false; }
                    }
                }
            }
        });
        Self { sender, state }
    }
    fn send(&self, cmd: AudioCommand) -> Result<()> { self.sender.send(cmd).map_err(|_| MusicError::Playback("Audio service not running".into())) }
    fn status(&self) -> Result<PlaybackState> { self.state.lock().map(|s| s.clone()).map_err(|_| MusicError::Playback("Playback state lock poisoned".into())) }
}
impl Drop for AudioService { fn drop(&mut self) { let _ = self.sender.send(AudioCommand::Shutdown); } }

pub struct MusicApp { database: Mutex<Connection>, audio: AudioService }
impl MusicApp {
    pub fn open(path: impl AsRef<Path>) -> Result<Self> {
        let conn = Connection::open(path)?;
        conn.execute_batch("PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL;
          CREATE TABLE IF NOT EXISTS tracks (
            id INTEGER PRIMARY KEY, path TEXT NOT NULL UNIQUE, title TEXT NOT NULL,
            artist TEXT NOT NULL DEFAULT 'Unknown Artist', album TEXT NOT NULL DEFAULT 'Unknown Album',
            duration_seconds INTEGER, added_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
          CREATE TABLE IF NOT EXISTS playlists (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE);
          CREATE TABLE IF NOT EXISTS playlist_tracks (playlist_id INTEGER NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
            track_id INTEGER NOT NULL REFERENCES tracks(id) ON DELETE CASCADE, position INTEGER NOT NULL,
            PRIMARY KEY(playlist_id, track_id));
          CREATE INDEX IF NOT EXISTS idx_track_title ON tracks(title COLLATE NOCASE);
          CREATE INDEX IF NOT EXISTS idx_track_artist ON tracks(artist COLLATE NOCASE);
          CREATE INDEX IF NOT EXISTS idx_playlist_order ON playlist_tracks(playlist_id, position);")?;
        Ok(Self { database: Mutex::new(conn), audio: AudioService::new() })
    }
    fn db(&self) -> Result<std::sync::MutexGuard<'_, Connection>> { self.database.lock().map_err(|_| MusicError::Request("Database lock poisoned".into())) }
    fn tracks_query(&self, sql: &str, query: Option<&str>) -> Result<Vec<Track>> {
        let conn = self.db()?;
        let mut stmt = conn.prepare(sql)?;
        let convert = |r: &rusqlite::Row<'_>| Ok(Track {
            id: r.get(0)?, path: r.get(1)?, title: r.get(2)?, artist: r.get(3)?, album: r.get(4)?, duration_seconds: r.get(5)?,
        });
        let rows = if let Some(q) = query { stmt.query_map([q], convert)?.collect::<std::result::Result<Vec<_>, _>>()? }
                   else { stmt.query_map([], convert)?.collect::<std::result::Result<Vec<_>, _>>()? };
        Ok(rows)
    }
    pub fn scan(&self, path: &str) -> Result<Value> {
        let root = PathBuf::from(path);
        if !root.is_dir() { return Err(MusicError::Request("Import path must be an existing directory".into())); }
        let mut imported = 0usize; let mut skipped = 0usize;
        let conn = self.db()?;
        for entry in WalkDir::new(&root).follow_links(false).into_iter().filter_map(|r| r.ok()) {
            if !entry.file_type().is_file() { continue; }
            let p = entry.path();
            let ext = p.extension().and_then(|e| e.to_str()).unwrap_or("").to_lowercase();
            if !["mp3", "flac", "wav", "ogg", "m4a", "aac", "alac"].contains(&ext.as_str()) { continue; }
            let title = p.file_stem().and_then(|x| x.to_str()).unwrap_or("Untitled");
            let path_str = p.to_string_lossy().into_owned();
            let changed = conn.execute("INSERT OR IGNORE INTO tracks(path,title,artist,album) VALUES(?1,?2,'Unknown Artist','Unknown Album')", params![path_str, title])?;
            if changed > 0 { imported += 1; } else { skipped += 1; }
        }
        Ok(json!({"imported": imported, "already_present": skipped}))
    }
    fn track_by_id(&self, id: i64) -> Result<Track> {
        let conn = self.db()?;
        conn.query_row("SELECT id,path,title,artist,album,duration_seconds FROM tracks WHERE id=?1", [id], |r| Ok(Track { id: r.get(0)?, path: r.get(1)?, title: r.get(2)?, artist: r.get(3)?, album: r.get(4)?, duration_seconds: r.get(5)? })).map_err(Into::into)
    }
    /// Single registry entry point shared by Tauri and the CLI.
    pub fn execute(&self, name: &str, args: Value) -> Result<Value> {
        match name {
            "music.library.scan" | "music.library.import" => self.scan(arg_str(&args,"path")?),
            "music.library.list" => Ok(json!(self.tracks_query("SELECT id,path,title,artist,album,duration_seconds FROM tracks ORDER BY title COLLATE NOCASE LIMIT 1000",None)?)),
            "music.search" => {
                let term = format!("%{}%", arg_str(&args,"query")?);
                Ok(json!(self.tracks_query("SELECT id,path,title,artist,album,duration_seconds FROM tracks WHERE title LIKE ?1 OR artist LIKE ?1 OR album LIKE ?1 ORDER BY title COLLATE NOCASE LIMIT 500",Some(&term))?))
            }
            "music.play" => { let track = self.track_by_id(arg_i64(&args,"track_id")?)?; self.audio.send(AudioCommand::Play(track))?; Ok(json!({"accepted":true})) }
            "music.pause" => { self.audio.send(AudioCommand::Pause)?; Ok(json!({"accepted":true})) }
            "music.resume" => { self.audio.send(AudioCommand::Resume)?; Ok(json!({"accepted":true})) }
            "music.stop" => { self.audio.send(AudioCommand::Stop)?; Ok(json!({"accepted":true})) }
            "music.seek" => { let sec=arg_i64(&args,"seconds")?; if sec<0 {return Err(MusicError::Request("seconds must be nonnegative".into()));} self.audio.send(AudioCommand::Seek(sec as u64))?; Ok(json!({"accepted":true})) }
            "music.volume.set" => { let v=args.get("volume").and_then(Value::as_f64).ok_or_else(|| MusicError::Request("volume must be a number".into()))?; if !(0.0..=1.0).contains(&v) {return Err(MusicError::Request("volume must be between 0 and 1".into()));} self.audio.send(AudioCommand::Volume(v as f32))?; Ok(json!({"accepted":true})) }
            "music.status" => Ok(json!(self.audio.status()?)),
            "music.playlist.create" => { let name=arg_str(&args,"name")?; let conn=self.db()?; conn.execute("INSERT INTO playlists(name) VALUES(?1)",[name])?; Ok(json!({"id":conn.last_insert_rowid(),"name":name})) }
            "music.playlist.list" => { let conn=self.db()?; let mut stmt=conn.prepare("SELECT id,name FROM playlists ORDER BY name COLLATE NOCASE")?; let rows=stmt.query_map([],|r|Ok(json!({"id":r.get::<_,i64>(0)?,"name":r.get::<_,String>(1)?})))?.collect::<std::result::Result<Vec<_>,_>>()?; Ok(json!(rows)) }
            "music.playlist.add_track" => { let pid=arg_i64(&args,"playlist_id")?; let tid=arg_i64(&args,"track_id")?; let conn=self.db()?; conn.execute("INSERT INTO playlist_tracks(playlist_id,track_id,position) VALUES(?1,?2,COALESCE((SELECT MAX(position)+1 FROM playlist_tracks WHERE playlist_id=?1),0))",params![pid,tid])?; Ok(json!({"added":true})) }
            "music.playlist.tracks" => { let pid=arg_i64(&args,"playlist_id")?; let conn=self.db()?; let mut stmt=conn.prepare("SELECT t.id,t.path,t.title,t.artist,t.album,t.duration_seconds FROM tracks t JOIN playlist_tracks pt ON pt.track_id=t.id WHERE pt.playlist_id=?1 ORDER BY pt.position")?; let rows=stmt.query_map([pid],|r|Ok(Track{id:r.get(0)?,path:r.get(1)?,title:r.get(2)?,artist:r.get(3)?,album:r.get(4)?,duration_seconds:r.get(5)?}))?.collect::<std::result::Result<Vec<_>,_>>()?; Ok(json!(rows)) }
            "music.metadata.update" => { let id=arg_i64(&args,"track_id")?; let title=arg_str(&args,"title")?; let artist=arg_str(&args,"artist")?; let album=arg_str(&args,"album")?; let conn=self.db()?; let changed=conn.execute("UPDATE tracks SET title=?1,artist=?2,album=?3 WHERE id=?4",params![title,artist,album,id])?; Ok(json!({"updated":changed>0})) }
            _ => Err(MusicError::Request(format!("Unknown command: {name}"))),
        }
    }
}
fn arg_str<'a>(v: &'a Value, key: &str) -> Result<&'a str> { v.get(key).and_then(Value::as_str).filter(|s|!s.trim().is_empty()).ok_or_else(||MusicError::Request(format!("Missing or empty: {key}"))) }
fn arg_i64(v:&Value,key:&str)->Result<i64>{v.get(key).and_then(Value::as_i64).ok_or_else(||MusicError::Request(format!("Expected integer: {key}")))}

#[cfg(test)]
mod tests {
 use super::*;
 #[test] fn can_create_playlist_and_search_empty_library() {
  let app=MusicApp::open(":memory:").expect("database created");
  assert_eq!(app.execute("music.search",json!({"query":"abc"})).unwrap(), json!([]));
  assert_eq!(app.execute("music.playlist.create",json!({"name":"Favorites"})).unwrap()["name"],"Favorites");
  assert_eq!(app.execute("music.playlist.list",json!({})).unwrap().as_array().unwrap().len(),1);
 }
 #[test] fn validation_catches_invalid_volume() { let app=MusicApp::open(":memory:").unwrap(); assert!(app.execute("music.volume.set",json!({"volume":2})).is_err()); }
 #[test] fn unknown_command_is_rejected(){let app=MusicApp::open(":memory:").unwrap(); assert!(app.execute("bad",json!({})).is_err());}
}
