use rodio::{Decoder, OutputStream, Sink, Source};
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{fs::File, io::BufReader, path::{Path, PathBuf}, sync::{atomic::{AtomicBool, Ordering}, mpsc, Arc, Mutex}, thread, time::Duration};
use thiserror::Error;
use walkdir::WalkDir;

pub mod lyrics;
pub mod queue;
use lyrics::{Lyrics, MAX_LYRICS_BYTES};
use queue::{Queue, RepeatMode, SavedQueue};

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
    /// Same position in milliseconds, for lyrics timing.
    pub position_ms: u64,
}
/// `music.status` response: the audio thread's state plus where the queue stands.
#[derive(Debug, Clone, Serialize)]
pub struct Status {
    #[serde(flatten)] pub playback: PlaybackState,
    pub queue_index: Option<usize>, pub queue_length: usize, pub queue_revision: u64,
    pub repeat: RepeatMode, pub shuffle: bool, pub has_next: bool,
}
impl Default for PlaybackState {
    fn default() -> Self { Self { track_id: None, playing: false, volume: 0.75, position_seconds: 0, duration_seconds: None, position_ms: 0 } }
}

/// `Play` carries the queue cursor it was started for, so the audio thread can tell whether a finished track is still current.
/// `Resume` carries the current queue track to start when nothing is loaded (after a restart, or when the queue finished).
enum AudioCommand { Play(Track, u64), Pause, Resume(Option<(Track, u64)>), Stop, Seek(u64), Volume(f32), Shutdown }

/// Owns the audio device on a dedicated thread so that database and UI work never block its command loop.
/// The thread is intentionally not the real-time audio callback: Rodio/CPAL handle the callback.
struct AudioService { sender: mpsc::Sender<AudioCommand>, state: Arc<Mutex<PlaybackState>> }
impl AudioService {
    fn new(queue: Arc<Mutex<Queue>>, queue_dirty: Arc<AtomicBool>) -> Self {
        let (sender, receiver) = mpsc::channel::<AudioCommand>();
        let state = Arc::new(Mutex::new(PlaybackState::default()));
        let shared = Arc::clone(&state);
        thread::spawn(move || {
            let mut stream_and_handle = OutputStream::try_default().ok();
            let mut sink: Option<Sink> = None;
            let mut playing_cursor = 0u64;
            loop {
                let message = match receiver.recv_timeout(Duration::from_millis(200)) {
                    Ok(v) => Some(v), Err(mpsc::RecvTimeoutError::Timeout) => None,
                    Err(mpsc::RecvTimeoutError::Disconnected) => break,
                };
                match message {
                    Some(AudioCommand::Shutdown) => break,
                    Some(AudioCommand::Play(track, cursor)) => {
                        if let Some(old) = sink.take() { old.stop(); }
                        sink = start_track(&mut stream_and_handle, &shared, &track);
                        playing_cursor = cursor;
                    }
                    Some(AudioCommand::Pause) => { if let Some(s) = &sink { s.pause(); } if let Ok(mut st) = shared.lock() { st.playing = false; } }
                    Some(AudioCommand::Resume(fallback)) => {
                        if let Some(s) = &sink { s.play(); if let Ok(mut st) = shared.lock() { st.playing = true; } }
                        else if let Some((track, cursor)) = fallback { sink = start_track(&mut stream_and_handle, &shared, &track); playing_cursor = cursor; }
                    }
                    Some(AudioCommand::Stop) => { if let Some(s) = sink.take() { s.stop(); } if let Ok(mut st) = shared.lock() { st.track_id = None; st.playing = false; st.position_seconds = 0; st.position_ms = 0; } }
                    Some(AudioCommand::Seek(seconds)) => {
                        if let Some(s) = &sink { if let Err(e) = s.try_seek(Duration::from_secs(seconds)) { eprintln!("Seek failed: {e}"); } }
                    }
                    Some(AudioCommand::Volume(value)) => { if let Some(s) = &sink { s.set_volume(value); } if let Ok(mut st) = shared.lock() { st.volume = value; } }
                    None => {}
                }
                if let Some(s) = &sink {
                    if let Ok(mut st) = shared.lock() { let pos = s.get_pos(); st.position_seconds = pos.as_secs(); st.position_ms = pos.as_millis() as u64; }
                }
                // A drained sink means the track finished on its own: advance the queue, unless a command
                // already moved it (cursor changed), in which case that command's Play is on its way.
                if sink.as_ref().is_some_and(Sink::empty) {
                    sink = None;
                    let next = queue.lock().ok().and_then(|mut q| {
                        if q.cursor() != playing_cursor { return None; }
                        let track = q.on_track_end();
                        queue_dirty.store(true, Ordering::Release);
                        track.map(|t| (t, q.cursor()))
                    });
                    match next {
                        Some((track, cursor)) => { sink = start_track(&mut stream_and_handle, &shared, &track); playing_cursor = cursor; }
                        None => if let Ok(mut st) = shared.lock() { st.playing = false; },
                    }
                }
            }
        });
        Self { sender, state }
    }
    fn send(&self, cmd: AudioCommand) -> Result<()> { self.sender.send(cmd).map_err(|_| MusicError::Playback("Audio service not running".into())) }
    fn status(&self) -> Result<PlaybackState> { self.state.lock().map(|s| s.clone()).map_err(|_| MusicError::Playback("Playback state lock poisoned".into())) }
}
/// Opens and starts `track`, recording the outcome in the shared state. Runs on the audio thread.
fn start_track(stream: &mut Option<(OutputStream, rodio::OutputStreamHandle)>, shared: &Mutex<PlaybackState>, track: &Track) -> Option<Sink> {
    let playback = (|| -> std::result::Result<Sink, String> {
        if stream.is_none() { *stream = OutputStream::try_default().ok(); }
        let (_, handle) = stream.as_ref().ok_or("No audio output device")?;
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
                st.position_seconds = 0; st.position_ms = 0; st.duration_seconds = track.duration_seconds;
            }
            Some(s)
        }
        Err(message) => {
            eprintln!("OpenMusic playback error for {}: {message}", track.path);
            if let Ok(mut st) = shared.lock() { st.track_id = None; st.playing = false; }
            None
        }
    }
}
impl Drop for AudioService { fn drop(&mut self) { let _ = self.sender.send(AudioCommand::Shutdown); } }

pub struct MusicApp { database: Mutex<Connection>, audio: AudioService, queue: Arc<Mutex<Queue>>, queue_dirty: Arc<AtomicBool> }
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
          CREATE INDEX IF NOT EXISTS idx_playlist_order ON playlist_tracks(playlist_id, position);
          CREATE TABLE IF NOT EXISTS queue_state (id INTEGER PRIMARY KEY CHECK (id = 1), state TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS lyrics (track_id INTEGER PRIMARY KEY REFERENCES tracks(id) ON DELETE CASCADE, text TEXT NOT NULL);")?;
        let mut queue = Queue::default();
        let saved: Option<String> = conn.query_row("SELECT state FROM queue_state WHERE id=1", [], |r| r.get(0)).ok();
        // A saved queue that no longer parses is dropped rather than blocking startup.
        if let Some(saved) = saved.and_then(|json| serde_json::from_str::<SavedQueue>(&json).ok()) {
            let mut stmt = conn.prepare("SELECT id,path,title,artist,album,duration_seconds FROM tracks WHERE id=?1")?;
            queue.restore(saved, |id| stmt.query_row([id], track_row).ok());
        }
        let queue = Arc::new(Mutex::new(queue));
        let queue_dirty = Arc::new(AtomicBool::new(false));
        let audio = AudioService::new(Arc::clone(&queue), Arc::clone(&queue_dirty));
        Ok(Self { database: Mutex::new(conn), audio, queue, queue_dirty })
    }
    fn queue(&self) -> Result<std::sync::MutexGuard<'_, Queue>> { self.queue.lock().map_err(|_| MusicError::Playback("Queue lock poisoned".into())) }
    fn save_queue(&self, queue: &Queue) -> Result<()> {
        let state = serde_json::to_string(&queue.saved()).map_err(|e| MusicError::Request(e.to_string()))?;
        self.db()?.execute("INSERT INTO queue_state(id,state) VALUES(1,?1) ON CONFLICT(id) DO UPDATE SET state=excluded.state", [state])?;
        Ok(())
    }
    /// Applies a queue change, saves it, and starts whatever track the change made current.
    fn queue_command(&self, change: impl FnOnce(&mut Queue) -> Result<Option<Track>>) -> Result<Value> {
        let mut queue = self.queue()?;
        let track = change(&mut queue)?;
        if let Some(track) = &track { self.audio.send(AudioCommand::Play(track.clone(), queue.cursor()))?; }
        self.save_queue(&queue)?;
        Ok(json!({"accepted": true, "track": track}))
    }
    fn tracks_by_ids(&self, ids: &[i64]) -> Result<Vec<Track>> {
        let conn = self.db()?;
        let mut stmt = conn.prepare("SELECT id,path,title,artist,album,duration_seconds FROM tracks WHERE id=?1")?;
        ids.iter().map(|id| stmt.query_row([id], track_row).map_err(|e| match e {
            rusqlite::Error::QueryReturnedNoRows => MusicError::Request(format!("Track {id} not found")), e => e.into() })).collect()
    }
    /// Saved lyrics win; otherwise a `.lrc` with the same name beside the audio file. None when neither exists.
    fn lyrics(&self, track_id: i64) -> Result<Option<Lyrics>> {
        let track = self.track_by_id(track_id)?;
        let saved: Option<String> = self.db()?.query_row("SELECT text FROM lyrics WHERE track_id=?1", [track_id], |r| r.get(0)).ok();
        if let Some(text) = saved { return Ok(Some(Lyrics::new(text, "saved"))); }
        let sidecar = Path::new(&track.path).with_extension("lrc");
        match std::fs::metadata(&sidecar) {
            Ok(meta) if meta.is_file() => {
                if meta.len() as usize > MAX_LYRICS_BYTES { return Err(MusicError::Request(format!("{} is larger than {} KB", sidecar.display(), MAX_LYRICS_BYTES / 1024))); }
                let text = String::from_utf8_lossy(&std::fs::read(&sidecar)?).into_owned();
                Ok(Some(Lyrics::new(text.trim_start_matches('\u{feff}').to_owned(), "file")))
            }
            _ => Ok(None),
        }
    }
    fn status(&self) -> Result<Status> {
        let playback = self.audio.status()?;
        let queue = self.queue()?;
        Ok(Status { playback, queue_index: queue.index(), queue_length: queue.len(), queue_revision: queue.revision(),
                    repeat: queue.repeat(), shuffle: queue.shuffle(), has_next: queue.peek_next().is_some() })
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
        // The audio thread advances the queue when a track ends but never writes to the database; persist that here.
        if self.queue_dirty.swap(false, Ordering::AcqRel) { let queue = self.queue()?; self.save_queue(&queue)?; }
        match name {
            "music.library.scan" | "music.library.import" => self.scan(arg_str(&args,"path")?),
            "music.library.list" => Ok(json!(self.tracks_query("SELECT id,path,title,artist,album,duration_seconds FROM tracks ORDER BY title COLLATE NOCASE LIMIT 1000",None)?)),
            "music.search" => {
                let term = format!("%{}%", arg_str(&args,"query")?);
                Ok(json!(self.tracks_query("SELECT id,path,title,artist,album,duration_seconds FROM tracks WHERE title LIKE ?1 OR artist LIKE ?1 OR album LIKE ?1 ORDER BY title COLLATE NOCASE LIMIT 500",Some(&term))?))
            }
            // Plays one track on its own; use music.queue.set to play it within a list.
            "music.play" => { let track = self.track_by_id(arg_i64(&args,"track_id")?)?; self.queue_command(|q| Ok(q.replace(vec![track], 0, None))) }
            "music.pause" => { self.audio.send(AudioCommand::Pause)?; Ok(json!({"accepted":true})) }
            "music.resume" => {
                let queue = self.queue()?;
                self.audio.send(AudioCommand::Resume(queue.current().cloned().map(|t| (t, queue.cursor()))))?; Ok(json!({"accepted":true}))
            }
            "music.next" => {
                let mut queue = self.queue()?;
                match queue.next() {
                    Some(track) => { self.audio.send(AudioCommand::Play(track.clone(), queue.cursor()))?; self.save_queue(&queue)?; Ok(json!({"accepted":true,"track":track})) }
                    None => Ok(json!({"accepted":false,"reason":"End of queue"})),
                }
            }
            "music.previous" => {
                // Like most players: past the first 3 seconds, or with nothing before, restart the current track.
                let status = self.audio.status()?;
                let mut queue = self.queue()?;
                if status.track_id.is_some() && status.position_seconds > 3 { self.audio.send(AudioCommand::Seek(0))?; return Ok(json!({"accepted":true,"restarted":true})); }
                let track = match queue.previous() { Some(track) => Some(track), None => match queue.index() { Some(i) => queue.jump(i), None => None } };
                match track {
                    Some(track) => { self.audio.send(AudioCommand::Play(track.clone(), queue.cursor()))?; self.save_queue(&queue)?; Ok(json!({"accepted":true,"track":track})) }
                    None => Ok(json!({"accepted":false,"reason":"Queue is empty"})),
                }
            }
            "music.queue.get" => Ok(json!(self.queue()?.view())),
            "music.queue.set" => {
                let ids = arg_ids(&args)?;
                let start = arg_opt_index(&args, "start_index")?.unwrap_or(0);
                if start >= ids.len() { return Err(MusicError::Request(format!("start_index must be below {}", ids.len()))); }
                let source = args.get("source").and_then(Value::as_str).map(str::to_owned);
                let tracks = self.tracks_by_ids(&ids)?;
                self.queue_command(|q| Ok(q.replace(tracks, start, source)))
            }
            "music.queue.add" => {
                let tracks = self.tracks_by_ids(&arg_ids(&args)?)?;
                let play_next = match args.get("position").and_then(Value::as_str).unwrap_or("last") {
                    "next" => true, "last" => false,
                    other => return Err(MusicError::Request(format!("position must be \"next\" or \"last\", not {other:?}"))),
                };
                self.queue_command(|q| { q.add(tracks, play_next); Ok(None) })
            }
            "music.queue.jump" => {
                let index = arg_index(&args, "index")?;
                self.queue_command(|q| q.jump(index).map(Some).ok_or_else(|| MusicError::Request(format!("Queue has no item at index {index}"))))
            }
            "music.queue.remove" => { let index = arg_index(&args, "index")?; self.queue_command(|q| q.remove(index).map(|_| None).map_err(MusicError::Request)) }
            "music.queue.move" => { let (from, to) = (arg_index(&args, "from")?, arg_index(&args, "to")?); self.queue_command(|q| q.move_item(from, to).map(|_| None).map_err(MusicError::Request)) }
            "music.queue.clear" => self.queue_command(|q| { q.clear(); Ok(None) }),
            "music.repeat.set" => {
                let mode = arg_str(&args, "mode")?;
                let mode = RepeatMode::parse(mode).ok_or_else(|| MusicError::Request(format!("mode must be off, all or one, not {mode:?}")))?;
                self.queue_command(|q| { q.set_repeat(mode); Ok(None) })
            }
            "music.shuffle.set" => {
                let enabled = args.get("enabled").and_then(Value::as_bool).ok_or_else(|| MusicError::Request("enabled must be true or false".into()))?;
                self.queue_command(|q| { q.set_shuffle(enabled); Ok(None) })
            }
            "music.stop" => { self.audio.send(AudioCommand::Stop)?; Ok(json!({"accepted":true})) }
            "music.seek" => { let sec=arg_i64(&args,"seconds")?; if sec<0 {return Err(MusicError::Request("seconds must be nonnegative".into()));} self.audio.send(AudioCommand::Seek(sec as u64))?; Ok(json!({"accepted":true})) }
            "music.volume.set" => { let v=args.get("volume").and_then(Value::as_f64).ok_or_else(|| MusicError::Request("volume must be a number".into()))?; if !(0.0..=1.0).contains(&v) {return Err(MusicError::Request("volume must be between 0 and 1".into()));} self.audio.send(AudioCommand::Volume(v as f32))?; Ok(json!({"accepted":true})) }
            "music.status" => Ok(json!(self.status()?)),
            "music.lyrics.get" => Ok(json!(self.lyrics(arg_i64(&args,"track_id")?)?)),
            "music.lyrics.set" => {
                let id = arg_i64(&args,"track_id")?;
                let text = arg_str(&args,"text")?.trim();
                if text.len() > MAX_LYRICS_BYTES { return Err(MusicError::Request(format!("Lyrics must be under {} KB", MAX_LYRICS_BYTES / 1024))); }
                self.track_by_id(id)?;
                self.db()?.execute("INSERT INTO lyrics(track_id,text) VALUES(?1,?2) ON CONFLICT(track_id) DO UPDATE SET text=excluded.text", params![id, text])?;
                Ok(json!(Lyrics::new(text.to_owned(), "saved")))
            }
            // Removes saved lyrics only; a .lrc file beside the audio is the user's file and is left alone.
            "music.lyrics.clear" => { let id = arg_i64(&args,"track_id")?; let n = self.db()?.execute("DELETE FROM lyrics WHERE track_id=?1", [id])?; Ok(json!({"removed": n > 0})) }
            "music.playlist.create" => { let name=arg_str(&args,"name")?; let conn=self.db()?; conn.execute("INSERT INTO playlists(name) VALUES(?1)",[name])?; Ok(json!({"id":conn.last_insert_rowid(),"name":name})) }
            "music.playlist.list" => { let conn=self.db()?; let mut stmt=conn.prepare("SELECT id,name FROM playlists ORDER BY name COLLATE NOCASE")?; let rows=stmt.query_map([],|r|Ok(json!({"id":r.get::<_,i64>(0)?,"name":r.get::<_,String>(1)?})))?.collect::<std::result::Result<Vec<_>,_>>()?; Ok(json!(rows)) }
            "music.playlist.add_track" => { let pid=arg_i64(&args,"playlist_id")?; let tid=arg_i64(&args,"track_id")?; let conn=self.db()?; conn.execute("INSERT INTO playlist_tracks(playlist_id,track_id,position) VALUES(?1,?2,COALESCE((SELECT MAX(position)+1 FROM playlist_tracks WHERE playlist_id=?1),0))",params![pid,tid])?; Ok(json!({"added":true})) }
            "music.playlist.tracks" => { let pid=arg_i64(&args,"playlist_id")?; let conn=self.db()?; let mut stmt=conn.prepare("SELECT t.id,t.path,t.title,t.artist,t.album,t.duration_seconds FROM tracks t JOIN playlist_tracks pt ON pt.track_id=t.id WHERE pt.playlist_id=?1 ORDER BY pt.position")?; let rows=stmt.query_map([pid],|r|Ok(Track{id:r.get(0)?,path:r.get(1)?,title:r.get(2)?,artist:r.get(3)?,album:r.get(4)?,duration_seconds:r.get(5)?}))?.collect::<std::result::Result<Vec<_>,_>>()?; Ok(json!(rows)) }
            "music.metadata.update" => { let id=arg_i64(&args,"track_id")?; let title=arg_str(&args,"title")?; let artist=arg_str(&args,"artist")?; let album=arg_str(&args,"album")?; let conn=self.db()?; let changed=conn.execute("UPDATE tracks SET title=?1,artist=?2,album=?3 WHERE id=?4",params![title,artist,album,id])?; drop(conn); if changed>0 { let track=self.track_by_id(id)?; self.queue()?.refresh_track(&track); } Ok(json!({"updated":changed>0})) }
            _ => Err(MusicError::Request(format!("Unknown command: {name}"))),
        }
    }
}
fn arg_str<'a>(v: &'a Value, key: &str) -> Result<&'a str> { v.get(key).and_then(Value::as_str).filter(|s|!s.trim().is_empty()).ok_or_else(||MusicError::Request(format!("Missing or empty: {key}"))) }
fn arg_i64(v:&Value,key:&str)->Result<i64>{v.get(key).and_then(Value::as_i64).ok_or_else(||MusicError::Request(format!("Expected integer: {key}")))}
fn arg_index(v:&Value,key:&str)->Result<usize>{arg_opt_index(v,key)?.ok_or_else(||MusicError::Request(format!("Expected nonnegative integer: {key}")))}
fn arg_opt_index(v:&Value,key:&str)->Result<Option<usize>>{match v.get(key){None|Some(Value::Null)=>Ok(None),Some(x)=>x.as_u64().map(|n|Some(n as usize)).ok_or_else(||MusicError::Request(format!("Expected nonnegative integer: {key}")))}}
fn arg_ids(v:&Value)->Result<Vec<i64>>{
    let ids=v.get("track_ids").and_then(Value::as_array).ok_or_else(||MusicError::Request("track_ids must be an array of track ids".into()))?;
    if ids.is_empty(){return Err(MusicError::Request("track_ids must not be empty".into()));}
    ids.iter().map(|x|x.as_i64().ok_or_else(||MusicError::Request("track_ids must contain only integers".into()))).collect()
}
fn track_row(r:&rusqlite::Row<'_>)->rusqlite::Result<Track>{Ok(Track{id:r.get(0)?,path:r.get(1)?,title:r.get(2)?,artist:r.get(3)?,album:r.get(4)?,duration_seconds:r.get(5)?})}

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

 // Rows point at files that don't exist: these tests cover queue bookkeeping, which must not depend on an audio device.
 fn with_tracks(app:&MusicApp,n:i64){let conn=app.db().unwrap();for i in 1..=n{conn.execute("INSERT INTO tracks(id,path,title) VALUES(?1,?2,?3)",params![i,format!("/missing/{i}.mp3"),format!("Song {i}")]).unwrap();}}
 fn queue_ids(app:&MusicApp)->Vec<i64>{app.execute("music.queue.get",json!({})).unwrap()["items"].as_array().unwrap().iter().map(|x|x["track"]["id"].as_i64().unwrap()).collect()}
 fn status(app:&MusicApp)->Value{app.execute("music.status",json!({})).unwrap()}

 #[test] fn queue_set_next_previous_and_status(){
  let app=MusicApp::open(":memory:").unwrap(); with_tracks(&app,3);
  let r=app.execute("music.queue.set",json!({"track_ids":[1,2,3],"start_index":1,"source":"All Songs"})).unwrap();
  assert_eq!(r["track"]["id"],2);
  let s=status(&app); assert_eq!(s["queue_index"],1); assert_eq!(s["queue_length"],3); assert_eq!(s["has_next"],true); assert_eq!(s["repeat"],"off");
  assert_eq!(app.execute("music.next",json!({})).unwrap()["track"]["id"],3);
  assert_eq!(app.execute("music.next",json!({})).unwrap()["accepted"],false);
  assert_eq!(status(&app)["has_next"],false);
  app.execute("music.repeat.set",json!({"mode":"all"})).unwrap();
  assert_eq!(status(&app)["has_next"],true);
  assert_eq!(app.execute("music.next",json!({})).unwrap()["track"]["id"],1);
  assert_eq!(app.execute("music.previous",json!({})).unwrap()["track"]["id"],3);
  assert_eq!(app.execute("music.queue.get",json!({})).unwrap()["source"],"All Songs");
 }
 #[test] fn queue_editing_commands(){
  let app=MusicApp::open(":memory:").unwrap(); with_tracks(&app,5);
  app.execute("music.queue.set",json!({"track_ids":[1,2,3]})).unwrap();
  app.execute("music.queue.add",json!({"track_ids":[5],"position":"next"})).unwrap();
  app.execute("music.queue.add",json!({"track_ids":[4]})).unwrap();
  assert_eq!(queue_ids(&app),vec![1,5,2,3,4]);
  app.execute("music.queue.move",json!({"from":4,"to":1})).unwrap();
  assert_eq!(queue_ids(&app),vec![1,4,5,2,3]);
  app.execute("music.queue.remove",json!({"index":2})).unwrap();
  assert_eq!(queue_ids(&app),vec![1,4,2,3]);
  assert!(app.execute("music.queue.remove",json!({"index":0})).is_err(),"current track stays");
  assert_eq!(app.execute("music.queue.jump",json!({"index":3})).unwrap()["track"]["id"],3);
  app.execute("music.queue.clear",json!({})).unwrap();
  assert_eq!(queue_ids(&app),vec![3]);
 }
 #[test] fn shuffle_command_keeps_current_and_restores_order(){
  let app=MusicApp::open(":memory:").unwrap(); with_tracks(&app,12);
  app.execute("music.queue.set",json!({"track_ids":(1..=12).collect::<Vec<_>>(),"start_index":4})).unwrap();
  app.execute("music.shuffle.set",json!({"enabled":true})).unwrap();
  let shuffled=queue_ids(&app); assert_eq!(shuffled[0],5); assert_eq!(status(&app)["shuffle"],true);
  let mut sorted=shuffled.clone(); sorted.sort(); assert_eq!(sorted,(1..=12).collect::<Vec<_>>());
  app.execute("music.shuffle.set",json!({"enabled":false})).unwrap();
  assert_eq!(queue_ids(&app),(1..=12).collect::<Vec<_>>());
  assert_eq!(status(&app)["queue_index"],4);
 }
 #[test] fn play_replaces_queue_with_single_track(){
  let app=MusicApp::open(":memory:").unwrap(); with_tracks(&app,3);
  app.execute("music.queue.set",json!({"track_ids":[1,2,3]})).unwrap();
  app.execute("music.play",json!({"track_id":2})).unwrap();
  assert_eq!(queue_ids(&app),vec![2]);
 }
 #[test] fn queue_commands_validate_input(){
  let app=MusicApp::open(":memory:").unwrap(); with_tracks(&app,2);
  for (name,args) in [("music.queue.set",json!({"track_ids":[]})),("music.queue.set",json!({"track_ids":[1,99]})),("music.queue.set",json!({"track_ids":[1],"start_index":1})),
                      ("music.queue.set",json!({"track_ids":"1"})),("music.queue.add",json!({"track_ids":[1],"position":"middle"})),("music.queue.jump",json!({"index":0})),
                      ("music.queue.move",json!({"from":-1,"to":0})),("music.repeat.set",json!({"mode":"twice"})),("music.shuffle.set",json!({"enabled":"yes"}))] {
   assert!(app.execute(name,args.clone()).is_err(),"{name} {args} should fail");
  }
  assert_eq!(app.execute("music.next",json!({})).unwrap()["accepted"],false);
  assert_eq!(app.execute("music.previous",json!({})).unwrap()["accepted"],false);
 }
 #[test] fn metadata_edit_updates_queued_copy(){
  let app=MusicApp::open(":memory:").unwrap(); with_tracks(&app,1);
  app.execute("music.queue.set",json!({"track_ids":[1]})).unwrap();
  app.execute("music.metadata.update",json!({"track_id":1,"title":"Renamed","artist":"X","album":"Y"})).unwrap();
  assert_eq!(app.execute("music.queue.get",json!({})).unwrap()["items"][0]["track"]["title"],"Renamed");
 }
 #[test] fn lyrics_saved_then_sidecar_file(){
  let dir=std::env::temp_dir().join(format!("openmusic-lyrics-test-{}",std::process::id()));
  std::fs::create_dir_all(&dir).unwrap();
  let audio=dir.join("song.mp3"); std::fs::write(&audio,b"").unwrap();
  let app=MusicApp::open(":memory:").unwrap();
  app.db().unwrap().execute("INSERT INTO tracks(id,path,title) VALUES(1,?1,'Song')",[audio.to_string_lossy().into_owned()]).unwrap();
  assert_eq!(app.execute("music.lyrics.get",json!({"track_id":1})).unwrap(),Value::Null);
  std::fs::write(dir.join("song.lrc"),"\u{feff}[ti:Song]\n[00:01.00]From the file").unwrap();
  let l=app.execute("music.lyrics.get",json!({"track_id":1})).unwrap();
  assert_eq!(l["source"],"file"); assert_eq!(l["synced"],true); assert_eq!(l["lines"][0]["time_ms"],1000); assert_eq!(l["lines"][0]["text"],"From the file");
  let saved=app.execute("music.lyrics.set",json!({"track_id":1,"text":"  Plain words\nSecond line  "})).unwrap();
  assert_eq!(saved["synced"],false); assert_eq!(saved["lines"][1]["text"],"Second line");
  assert_eq!(app.execute("music.lyrics.get",json!({"track_id":1})).unwrap()["source"],"saved","saved lyrics win over the file");
  assert_eq!(app.execute("music.lyrics.clear",json!({"track_id":1})).unwrap()["removed"],true);
  assert_eq!(app.execute("music.lyrics.get",json!({"track_id":1})).unwrap()["source"],"file","file is untouched");
  assert!(app.execute("music.lyrics.set",json!({"track_id":1,"text":"   "})).is_err());
  assert!(app.execute("music.lyrics.set",json!({"track_id":9,"text":"x"})).is_err());
  assert!(app.execute("music.lyrics.get",json!({"track_id":9})).is_err());
  let _=std::fs::remove_dir_all(&dir);
 }
 #[test] fn queue_survives_reopen(){
  let path=std::env::temp_dir().join(format!("openmusic-queue-test-{}.sqlite",std::process::id()));
  let _=std::fs::remove_file(&path);
  {
   let app=MusicApp::open(&path).unwrap(); with_tracks(&app,4);
   app.execute("music.queue.set",json!({"track_ids":[4,3,2,1],"start_index":2,"source":"Mix"})).unwrap();
   app.execute("music.repeat.set",json!({"mode":"one"})).unwrap();
  }
  {
   let app=MusicApp::open(&path).unwrap();
   assert_eq!(queue_ids(&app),vec![4,3,2,1]);
   let s=status(&app); assert_eq!(s["queue_index"],2); assert_eq!(s["repeat"],"one");
   assert_eq!(app.execute("music.queue.get",json!({})).unwrap()["source"],"Mix");
  }
  for suffix in ["","-wal","-shm"]{let _=std::fs::remove_file(format!("{}{suffix}",path.display()));}
 }
}
