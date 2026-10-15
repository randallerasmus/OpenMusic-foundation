//! Play queue: the ordered tracks, the current position, and repeat/shuffle modes.
//! It is shared by `MusicApp` (commands) and the audio thread (advancing when a track ends), so it holds
//! already-resolved `Track`s and never touches the database; `MusicApp` persists it.

use crate::Track;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RepeatMode { #[default] Off, All, One }
impl RepeatMode {
    pub fn parse(s: &str) -> Option<Self> { match s { "off" => Some(Self::Off), "all" => Some(Self::All), "one" => Some(Self::One), _ => None } }
    pub fn as_str(self) -> &'static str { match self { Self::Off => "off", Self::All => "all", Self::One => "one" } }
}

/// One slot in the queue. `entry` is unique per slot, so the same song can be queued twice and still be told apart.
#[derive(Debug, Clone, Serialize)]
pub struct QueueItem { pub entry: u64, pub track: Track }

#[derive(Debug, Clone, Serialize)]
pub struct QueueView {
    pub items: Vec<QueueItem>, pub index: Option<usize>, pub repeat: RepeatMode,
    pub shuffle: bool, pub source: Option<String>, pub revision: u64,
}

/// What `MusicApp` stores in SQLite: track ids in play order and in original order, plus modes.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SavedQueue {
    pub items: Vec<i64>, pub unshuffled: Vec<i64>, pub index: Option<usize>,
    pub repeat: RepeatMode, pub shuffle: bool, pub source: Option<String>,
}

#[derive(Debug)]
pub struct Queue {
    items: Vec<QueueItem>,
    /// Original order, restored when shuffle is turned off. Mirrors `items` while shuffle is off.
    unshuffled: Vec<QueueItem>,
    index: Option<usize>,
    repeat: RepeatMode,
    shuffle: bool,
    source: Option<String>,
    next_entry: u64,
    /// Bumped whenever the current slot changes, so a stale end-of-track event cannot advance twice.
    cursor: u64,
    /// Bumped on every change, so clients refetch the queue only when it changed.
    revision: u64,
    rng: u64,
}

impl Default for Queue { fn default() -> Self { Self::with_seed(seed()) } }

fn seed() -> u64 {
    let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos() as u64).unwrap_or(0);
    nanos | 1
}

impl Queue {
    pub fn with_seed(seed: u64) -> Self {
        Self { items: vec![], unshuffled: vec![], index: None, repeat: RepeatMode::Off, shuffle: false, source: None,
               next_entry: 1, cursor: 0, revision: 0, rng: seed | 1 }
    }

    pub fn current(&self) -> Option<&Track> { self.index.and_then(|i| self.items.get(i)).map(|item| &item.track) }
    pub fn index(&self) -> Option<usize> { self.index }
    pub fn len(&self) -> usize { self.items.len() }
    pub fn is_empty(&self) -> bool { self.items.is_empty() }
    pub fn repeat(&self) -> RepeatMode { self.repeat }
    pub fn shuffle(&self) -> bool { self.shuffle }
    pub fn cursor(&self) -> u64 { self.cursor }
    pub fn revision(&self) -> u64 { self.revision }

    pub fn view(&self) -> QueueView {
        QueueView { items: self.items.clone(), index: self.index, repeat: self.repeat, shuffle: self.shuffle, source: self.source.clone(), revision: self.revision }
    }

    /// Replaces the queue with `tracks`, positioned on `start`. With shuffle on, `start` plays first and the rest are shuffled.
    pub fn replace(&mut self, tracks: Vec<Track>, start: usize, source: Option<String>) -> Option<Track> {
        let items: Vec<QueueItem> = tracks.into_iter().map(|track| self.item(track)).collect();
        self.unshuffled = items.clone();
        self.items = items;
        self.source = source;
        self.index = if self.items.is_empty() { None } else { Some(start.min(self.items.len() - 1)) };
        if self.shuffle { self.shuffle_upcoming(); }
        self.moved()
    }

    /// The track the next-track button would play, without moving.
    pub fn peek_next(&self) -> Option<&Track> {
        let next = match self.index { None => 0, Some(i) => i + 1 };
        if next < self.items.len() { return Some(&self.items[next].track); }
        if self.repeat != RepeatMode::Off { return self.items.first().map(|item| &item.track); }
        None
    }

    /// Next-track button. Wraps when repeat is on (repeat-one still skips, as users expect); None at the end otherwise.
    pub fn next(&mut self) -> Option<Track> {
        let next = match self.index { None => 0, Some(i) => i + 1 };
        if next < self.items.len() { self.index = Some(next); }
        else if self.repeat != RepeatMode::Off && !self.items.is_empty() { self.index = Some(0); }
        else { return None; }
        self.moved()
    }

    /// Called when the current track finishes on its own.
    pub fn on_track_end(&mut self) -> Option<Track> {
        if self.repeat == RepeatMode::One && self.index.is_some() { return self.moved(); }
        self.next()
    }

    /// Previous-track button. None when already at the start and not repeating; the caller then restarts the track.
    pub fn previous(&mut self) -> Option<Track> {
        match self.index {
            Some(i) if i > 0 => self.index = Some(i - 1),
            Some(_) if self.repeat == RepeatMode::All => self.index = Some(self.items.len() - 1),
            _ => return None,
        }
        self.moved()
    }

    pub fn jump(&mut self, index: usize) -> Option<Track> {
        if index >= self.items.len() { return None; }
        self.index = Some(index);
        self.moved()
    }

    /// Adds tracks right after the current one ("play next") or at the end.
    pub fn add(&mut self, tracks: Vec<Track>, play_next: bool) {
        let items: Vec<QueueItem> = tracks.into_iter().map(|track| self.item(track)).collect();
        let at = if play_next { self.index.map_or(0, |i| i + 1) } else { self.items.len() };
        self.items.splice(at..at, items.iter().cloned());
        if self.shuffle {
            let current = self.current_entry();
            let at = if play_next { current.and_then(|e| self.unshuffled.iter().position(|x| x.entry == e)).map_or(0, |i| i + 1) } else { self.unshuffled.len() };
            self.unshuffled.splice(at..at, items);
        } else { self.unshuffled = self.items.clone(); }
        self.changed();
    }

    /// Removes an upcoming or past slot. The current slot cannot be removed while it is loaded.
    pub fn remove(&mut self, index: usize) -> Result<(), String> {
        if index >= self.items.len() { return Err(format!("Queue has no item at index {index}")); }
        if Some(index) == self.index { return Err("The current track cannot be removed from the queue".into()); }
        let entry = self.items.remove(index).entry;
        self.unshuffled.retain(|item| item.entry != entry);
        if let Some(i) = self.index { if index < i { self.index = Some(i - 1); } }
        self.changed();
        Ok(())
    }

    /// Moves a slot; the current track keeps playing and stays current wherever it ends up.
    pub fn move_item(&mut self, from: usize, to: usize) -> Result<(), String> {
        let len = self.items.len();
        if from >= len || to >= len { return Err(format!("Queue indices must be below {len}")); }
        let current = self.current_entry();
        let item = self.items.remove(from);
        self.items.insert(to, item);
        self.index = current.and_then(|e| self.items.iter().position(|x| x.entry == e));
        if !self.shuffle { self.unshuffled = self.items.clone(); }
        self.changed();
        Ok(())
    }

    /// Clears everything except the current track.
    pub fn clear(&mut self) {
        let keep: Vec<QueueItem> = self.index.and_then(|i| self.items.get(i)).cloned().into_iter().collect();
        self.index = if keep.is_empty() { None } else { Some(0) };
        self.items = keep.clone();
        self.unshuffled = keep;
        self.changed();
    }

    pub fn set_repeat(&mut self, mode: RepeatMode) { self.repeat = mode; self.changed(); }

    /// Turning shuffle on keeps the current track and shuffles everything else after it;
    /// turning it off restores the original order, still on the current track.
    pub fn set_shuffle(&mut self, enabled: bool) {
        if enabled == self.shuffle { return; }
        self.shuffle = enabled;
        if enabled { self.unshuffled = self.items.clone(); self.shuffle_upcoming(); }
        else {
            let current = self.current_entry();
            self.items = self.unshuffled.clone();
            self.index = current.and_then(|e| self.items.iter().position(|x| x.entry == e)).or(if self.items.is_empty() { None } else { Some(0) });
        }
        self.changed();
    }

    /// Keeps queued copies in step after a metadata edit.
    pub fn refresh_track(&mut self, track: &Track) {
        let mut hit = false;
        for item in self.items.iter_mut().chain(self.unshuffled.iter_mut()) { if item.track.id == track.id { item.track = track.clone(); hit = true; } }
        if hit { self.changed(); }
    }

    pub fn saved(&self) -> SavedQueue {
        SavedQueue { items: self.items.iter().map(|x| x.track.id).collect(), unshuffled: self.unshuffled.iter().map(|x| x.track.id).collect(),
                     index: self.index, repeat: self.repeat, shuffle: self.shuffle, source: self.source.clone() }
    }

    /// Rebuilds a saved queue. Tracks that no longer exist are dropped; if the current one is gone, nothing is current.
    pub fn restore(&mut self, saved: SavedQueue, mut lookup: impl FnMut(i64) -> Option<Track>) {
        let mut items = vec![];
        let mut index = None;
        for (i, id) in saved.items.iter().enumerate() {
            if let Some(track) = lookup(*id) { if saved.index == Some(i) { index = Some(items.len()); } items.push(self.item(track)); }
        }
        // Reuse the play-order entries for the original order so turning shuffle off can find the current slot.
        let mut pool = items.clone();
        let mut unshuffled = vec![];
        for id in &saved.unshuffled {
            if let Some(p) = pool.iter().position(|x| x.track.id == *id) { unshuffled.push(pool.remove(p)); }
        }
        unshuffled.extend(pool);
        self.items = items;
        self.unshuffled = if saved.shuffle { unshuffled } else { self.items.clone() };
        self.index = index;
        self.repeat = saved.repeat;
        self.shuffle = saved.shuffle;
        self.source = saved.source;
        self.changed();
    }

    fn item(&mut self, track: Track) -> QueueItem { let entry = self.next_entry; self.next_entry += 1; QueueItem { entry, track } }
    fn current_entry(&self) -> Option<u64> { self.index.and_then(|i| self.items.get(i)).map(|x| x.entry) }
    fn changed(&mut self) { self.revision += 1; }
    fn moved(&mut self) -> Option<Track> { self.cursor += 1; self.changed(); self.current().cloned() }

    /// Puts the current slot first and Fisher-Yates shuffles the rest. Played history is folded into the shuffle.
    fn shuffle_upcoming(&mut self) {
        let Some(i) = self.index else {
            let mut items = std::mem::take(&mut self.items);
            self.shuffle_slice(&mut items);
            self.items = items;
            return;
        };
        let current = self.items.remove(i);
        let mut rest = std::mem::take(&mut self.items);
        self.shuffle_slice(&mut rest);
        self.items = std::iter::once(current).chain(rest).collect();
        self.index = Some(0);
    }
    fn shuffle_slice(&mut self, items: &mut [QueueItem]) {
        for i in (1..items.len()).rev() { let j = (self.random() % (i as u64 + 1)) as usize; items.swap(i, j); }
    }
    /// xorshift64*: plenty for shuffling, and avoids a dependency.
    fn random(&mut self) -> u64 {
        self.rng ^= self.rng >> 12; self.rng ^= self.rng << 25; self.rng ^= self.rng >> 27;
        self.rng.wrapping_mul(0x2545_F491_4F6C_DD1D)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn t(id: i64) -> Track { Track { id, path: format!("/music/{id}.mp3"), title: format!("Song {id}"), artist: "A".into(), album: "B".into(), duration_seconds: None } }
    fn ids(q: &Queue) -> Vec<i64> { q.view().items.iter().map(|x| x.track.id).collect() }
    fn queue(n: i64, start: usize) -> Queue { let mut q = Queue::with_seed(42); q.replace((1..=n).map(t).collect(), start, None); q }

    #[test] fn replace_starts_at_requested_track() {
        let q = queue(4, 2);
        assert_eq!(q.current().unwrap().id, 3);
        assert_eq!(q.peek_next().unwrap().id, 4);
    }
    #[test] fn next_stops_at_end_without_repeat_and_wraps_with_repeat_all() {
        let mut q = queue(2, 0);
        assert_eq!(q.next().unwrap().id, 2);
        assert!(q.next().is_none());
        assert_eq!(q.current().unwrap().id, 2, "stays on the last track");
        q.set_repeat(RepeatMode::All);
        assert_eq!(q.next().unwrap().id, 1);
    }
    #[test] fn repeat_one_replays_on_end_but_next_button_still_skips() {
        let mut q = queue(3, 0);
        q.set_repeat(RepeatMode::One);
        let cursor = q.cursor();
        assert_eq!(q.on_track_end().unwrap().id, 1);
        assert!(q.cursor() > cursor, "replaying the same track still counts as a move");
        assert_eq!(q.next().unwrap().id, 2);
    }
    #[test] fn previous_stops_at_start_unless_repeating_all() {
        let mut q = queue(3, 0);
        assert!(q.previous().is_none());
        q.set_repeat(RepeatMode::All);
        assert_eq!(q.previous().unwrap().id, 3);
    }
    #[test] fn shuffle_keeps_current_first_and_unshuffle_restores_order() {
        let mut q = queue(20, 5);
        q.set_shuffle(true);
        assert_eq!(q.index(), Some(0));
        assert_eq!(q.current().unwrap().id, 6);
        let mut sorted = ids(&q); sorted.sort();
        assert_eq!(sorted, (1..=20).collect::<Vec<_>>(), "shuffle neither drops nor duplicates");
        assert_ne!(ids(&q), (1..=20).collect::<Vec<_>>());
        q.next();
        let playing = q.current().unwrap().id;
        q.set_shuffle(false);
        assert_eq!(ids(&q), (1..=20).collect::<Vec<_>>());
        assert_eq!(q.current().unwrap().id, playing);
    }
    #[test] fn add_play_next_and_last() {
        let mut q = queue(3, 0);
        q.add(vec![t(9)], true);
        q.add(vec![t(8)], false);
        assert_eq!(ids(&q), vec![1, 9, 2, 3, 8]);
    }
    #[test] fn add_while_shuffled_survives_unshuffle() {
        let mut q = queue(5, 0);
        q.set_shuffle(true);
        q.add(vec![t(9)], true);
        assert_eq!(q.peek_next().unwrap().id, 9);
        q.set_shuffle(false);
        assert_eq!(ids(&q), vec![1, 9, 2, 3, 4, 5]);
    }
    #[test] fn remove_and_move_keep_the_current_track() {
        let mut q = queue(5, 2);
        assert!(q.remove(2).is_err());
        q.remove(0).unwrap();
        assert_eq!(q.current().unwrap().id, 3);
        q.move_item(1, 3).unwrap();
        assert_eq!(ids(&q), vec![2, 4, 5, 3]);
        assert_eq!(q.current().unwrap().id, 3);
        assert!(q.move_item(0, 9).is_err());
    }
    #[test] fn same_song_twice_is_two_entries() {
        let mut q = Queue::with_seed(1);
        q.replace(vec![t(1), t(1)], 1, None);
        q.remove(0).unwrap();
        assert_eq!(q.len(), 1);
        assert_eq!(q.index(), Some(0));
    }
    #[test] fn clear_keeps_only_current() {
        let mut q = queue(4, 1);
        q.clear();
        assert_eq!(ids(&q), vec![2]);
        assert_eq!(q.index(), Some(0));
    }
    #[test] fn restore_drops_missing_tracks_and_keeps_position() {
        let mut q = queue(4, 2);
        q.set_repeat(RepeatMode::All);
        let saved = q.saved();
        let mut back = Queue::with_seed(7);
        back.restore(saved, |id| (id != 2).then(|| t(id)));
        assert_eq!(ids(&back), vec![1, 3, 4]);
        assert_eq!(back.current().unwrap().id, 3);
        assert_eq!(back.repeat(), RepeatMode::All);
    }
    #[test] fn restore_shuffled_queue_can_unshuffle() {
        let mut q = queue(6, 0);
        q.set_shuffle(true);
        let mut back = Queue::with_seed(3);
        back.restore(q.saved(), |id| Some(t(id)));
        assert_eq!(ids(&back), ids(&q));
        back.set_shuffle(false);
        assert_eq!(ids(&back), (1..=6).collect::<Vec<_>>());
        assert_eq!(back.current().unwrap().id, 1);
    }
}
