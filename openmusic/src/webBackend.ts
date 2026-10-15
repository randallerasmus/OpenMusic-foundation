// Browser implementation of the OpenMusic command registry. Mirrors the command names, argument
// validation and response shapes of `MusicApp::execute` (crates/openmusic-core) so the UI is
// identical on desktop and web. Imported audio is copied into IndexedDB on this device: nothing is
// uploaded, and playback works offline once the files are stored.
import type {Backend, ImportResult, Playback, Playlist, Track} from './backend';
import {Queue, type RepeatMode, type SavedQueue} from './queue';
import {makeLyrics, MAX_LYRICS_BYTES} from './lyrics';
import {extractAudio} from './mp4audio';
import {lookup as lrclibLookup} from './lrclib';

const AUDIO_EXTENSIONS=['mp3','flac','wav','ogg','m4a','aac','alac'];
const DB_NAME='openmusic';
// The queue is small and per-device, so it lives in localStorage.
const QUEUE_KEY='openmusic.queue';

type StoredTrack=Track&{fingerprint:string,mime:string};
type PlaylistEntry={id?:number,playlist_id:number,track_id:number,position:number};

function req<T>(r:IDBRequest<T>):Promise<T>{return new Promise((ok,fail)=>{r.onsuccess=()=>ok(r.result);r.onerror=()=>fail(r.error);});}
function done(tx:IDBTransaction):Promise<void>{return new Promise((ok,fail)=>{tx.oncomplete=()=>ok();tx.onerror=()=>fail(tx.error);tx.onabort=()=>fail(tx.error??new Error('Transaction aborted'));});}

function openDb():Promise<IDBDatabase>{
  return new Promise((ok,fail)=>{
    const open=indexedDB.open(DB_NAME,2);
    // Each step upgrades from the version before it, so existing libraries keep their songs.
    open.onupgradeneeded=e=>{
      const db=open.result;
      if(e.oldVersion<1){
        db.createObjectStore('tracks',{keyPath:'id',autoIncrement:true}).createIndex('fingerprint','fingerprint',{unique:true});
        db.createObjectStore('files'); // key: track id, value: audio Blob
        db.createObjectStore('playlists',{keyPath:'id',autoIncrement:true}).createIndex('name','name',{unique:true});
        db.createObjectStore('playlist_tracks',{keyPath:'id',autoIncrement:true}).createIndex('playlist_id','playlist_id');
      }
      if(e.oldVersion<2)db.createObjectStore('lyrics'); // key: track id, value: {text, source}
    };
    // Another open tab still on the old version would block the upgrade indefinitely.
    open.onblocked=()=>fail(new Error('Close other OpenMusic tabs so the library can be updated, then reload.'));
    open.onsuccess=()=>ok(open.result);
    open.onerror=e=>{
      // A newer build (since rolled back) already upgraded this device's library. Open it at its current
      // version instead of failing: newer versions only ever add stores, so everything this build needs is there.
      if(open.error?.name==='VersionError'){e.preventDefault();const any=indexedDB.open(DB_NAME);any.onsuccess=()=>ok(any.result);any.onerror=()=>fail(any.error??new Error('Could not open the on-device music library'));return;}
      fail(open.error??new Error('Could not open the on-device music library'));
    };
  });
}

const request=(message:string)=>new Error(`Invalid request: ${message}`);
function argStr(args:Record<string,unknown>,key:string){const v=args[key];if(typeof v!=='string')throw request(`missing string argument '${key}'`);return v;}
function argInt(args:Record<string,unknown>,key:string){const v=args[key];if(typeof v!=='number'||!Number.isInteger(v))throw request(`missing integer argument '${key}'`);return v;}
function argIndex(args:Record<string,unknown>,key:string){const v=args[key];if(typeof v!=='number'||!Number.isInteger(v)||v<0)throw request(`expected nonnegative integer: ${key}`);return v;}
function argIds(args:Record<string,unknown>){
  const v=args.track_ids;
  if(!Array.isArray(v))throw request('track_ids must be an array of track ids');
  if(!v.length)throw request('track_ids must not be empty');
  if(!v.every(x=>typeof x==='number'&&Number.isInteger(x)))throw request('track_ids must contain only integers');
  return v as number[];
}
const byTitle=(a:Track,b:Track)=>a.title.localeCompare(b.title,undefined,{sensitivity:'base'});
const publicTrack=({fingerprint:_f,mime:_m,...t}:StoredTrack):Track=>t;

export async function createWebBackend():Promise<Backend>{
  const db=await openDb();
  const audio=new Audio();
  audio.preload='auto';
  let currentId:number|null=null,objectUrl:string|null=null;
  const queue=new Queue();
  // Cursor of the queue slot the loaded audio belongs to, so a stale `ended` event cannot advance twice.
  let playingCursor=-1;

  async function allTracks(){return (await req(db.transaction('tracks').objectStore('tracks').getAll()) as StoredTrack[]).map(publicTrack).sort(byTitle);}
  async function trackById(id:number){const t=await req(db.transaction('tracks').objectStore('tracks').get(id)) as StoredTrack|undefined;if(!t)throw new Error(`Track ${id} not found`);return t;}

  function status():Playback{
    return {track_id:currentId,playing:currentId!==null&&!audio.paused&&!audio.ended,volume:audio.volume,
      position_seconds:Math.floor(audio.currentTime||0),position_ms:Math.round((audio.currentTime||0)*1000),duration_seconds:Number.isFinite(audio.duration)?Math.round(audio.duration):null,
      queue_index:queue.index,queue_length:queue.length,queue_revision:queue.revision,repeat:queue.repeat,shuffle:queue.shuffle,has_next:queue.peekNext()!==null};
  }

  async function play(track:Track,cursor:number){
    const blob=await req(db.transaction('files').objectStore('files').get(track.id)) as Blob|undefined;
    if(!blob)throw new Error(`The audio for “${track.title}” is missing from this device. Import it again.`);
    audio.pause();
    if(objectUrl)URL.revokeObjectURL(objectUrl);
    objectUrl=URL.createObjectURL(blob);
    audio.src=objectUrl;currentId=track.id;playingCursor=cursor;
    if('mediaSession' in navigator)navigator.mediaSession.metadata=new MediaMetadata({title:track.title,artist:track.artist,album:track.album,artwork:[{src:'/icon-512.png',sizes:'512x512',type:'image/png'}]});
    try{await audio.play();}
    catch(e){
      const mime=(track as Partial<StoredTrack>).mime;
      if(e instanceof DOMException&&e.name==='NotSupportedError')throw new Error(`This browser can't play “${track.title}” (${mime||'unknown format'}). MP3 and M4A/AAC work everywhere.`);
      throw new Error(`Playback failed: ${e instanceof Error?e.message:String(e)}`);
    }
  }

  function saveQueue(){try{localStorage.setItem(QUEUE_KEY,JSON.stringify(queue.saved()));}catch{/* storage unavailable: the queue just won't survive a reload */}}
  /** Saves the queue and starts the track a change made current, mirroring MusicApp::queue_command. */
  async function queueCommand(track:Track|null){
    saveQueue();
    if(track)await play(track,queue.cursor);
    return {accepted:true,track};
  }
  async function tracksByIds(ids:number[]){
    const tx=db.transaction('tracks');
    return Promise.all(ids.map(async id=>{const t=await req(tx.objectStore('tracks').get(id)) as StoredTrack|undefined;if(!t)throw request(`Track ${id} not found`);return publicTrack(t);}));
  }

  try{
    const saved=JSON.parse(localStorage.getItem(QUEUE_KEY)??'null') as SavedQueue|null;
    if(saved&&Array.isArray(saved.items)){const byId=new Map((await allTracks()).map(t=>[t.id,t]));queue.restore(saved,id=>byId.get(id));}
  }catch{/* unreadable saved queue: start empty */}

  audio.addEventListener('ended',()=>{
    if(queue.cursor!==playingCursor)return;
    const next=queue.onTrackEnd();saveQueue();
    if(next)play(next,queue.cursor).catch(e=>console.warn('OpenMusic could not continue the queue:',e));
  });

  async function importFiles(files:File[]):Promise<ImportResult>{
    const ext=(f:File)=>f.name.split('.').pop()?.toLowerCase()??'';
    const audioFiles=files.filter(f=>AUDIO_EXTENSIONS.includes(ext(f))||f.type.startsWith('audio/'));
    let imported=0,already_present=0,lyrics=0;
    for(const file of audioFiles){
      // One transaction per file keeps memory bounded when importing many large files.
      const tx=db.transaction(['tracks','files'],'readwrite');
      const tracks=tx.objectStore('tracks');
      const fingerprint=`${file.name}|${file.size}|${file.lastModified}`;
      if(await req(tracks.index('fingerprint').getKey(fingerprint))!==undefined){already_present++;await done(tx);continue;}
      const title=file.name.replace(/\.[^.]+$/,'')||'Untitled';
      const id=await req(tracks.add({path:file.name,title,artist:'Unknown Artist',album:'Unknown Album',duration_seconds:null,fingerprint,mime:file.type}));
      tx.objectStore('files').put(file,id);
      await done(tx);imported++;
    }
    // Ask the browser not to evict the library under storage pressure (best effort; may be denied).
    if(imported>0)await navigator.storage?.persist?.().catch(()=>false);
    // A .lrc chosen alongside the audio attaches to the song with the same file name (e.g. Song.mp3 + Song.lrc).
    const lrcFiles=files.filter(f=>ext(f)==='lrc'&&f.size<=MAX_LYRICS_BYTES);
    if(lrcFiles.length){
      const stem=(name:string)=>name.replace(/\.[^.]+$/,'').toLowerCase();
      const byStem=new Map((await req(db.transaction('tracks').objectStore('tracks').getAll()) as StoredTrack[]).map(t=>[stem(t.path),t.id]));
      for(const file of lrcFiles){
        const id=byStem.get(stem(file.name));
        const text=(await file.text()).replace(/^\uFEFF/,'').trim();
        if(id===undefined||!text)continue;
        const tx=db.transaction('lyrics','readwrite');tx.objectStore('lyrics').put({text,source:'saved'},id);await done(tx);lyrics++;
      }
    }
    return {imported,already_present,lyrics};
  }

  function pickFiles():Promise<File[]|null>{
    return new Promise(resolve=>{
      const input=document.createElement('input');
      input.type='file';input.multiple=true;input.accept='audio/*,'+[...AUDIO_EXTENSIONS,'lrc'].map(e=>'.'+e).join(',');
      // iOS Safari only reliably fires `change` for inputs that are attached to the document.
      input.hidden=true;input.setAttribute('data-openmusic-import','');
      const finish=(files:File[]|null)=>{input.remove();resolve(files);};
      input.onchange=()=>finish(input.files?Array.from(input.files):null);
      input.addEventListener('cancel',()=>finish(null));
      document.body.append(input);
      input.click();
    });
  }

  if('mediaSession' in navigator){
    const ms=navigator.mediaSession;
    ms.setActionHandler('play',()=>void audio.play());
    ms.setActionHandler('pause',()=>audio.pause());
    ms.setActionHandler('previoustrack',()=>void execute('music.previous',{}).catch(e=>console.warn(e)));
    ms.setActionHandler('nexttrack',()=>void execute('music.next',{}).catch(e=>console.warn(e)));
    ms.setActionHandler('seekto',d=>{if(d.seekTime!=null)audio.currentTime=d.seekTime;});
    try{ms.setActionHandler('stop',()=>{audio.pause();audio.currentTime=0;});}catch{/* not supported everywhere */}
  }

  const ok={accepted:true};
  async function execute(name:string,args:Record<string,unknown>):Promise<unknown>{
    switch(name){
      case 'music.library.scan':case 'music.library.import':
        throw new Error('Folder scanning is only available in the desktop app. Use “Import music” to choose songs.');
      case 'music.library.list':return (await allTracks()).slice(0,1000);
      case 'music.search':{const q=argStr(args,'query').toLowerCase();return (await allTracks()).filter(t=>[t.title,t.artist,t.album].some(v=>v.toLowerCase().includes(q))).slice(0,500);}
      // Plays one track on its own; use music.queue.set to play it within a list.
      case 'music.play':{const track=publicTrack(await trackById(argInt(args,'track_id')));return queueCommand(queue.replace([track],0,null));}
      case 'music.pause':audio.pause();return ok;
      case 'music.resume':{
        // Nothing loaded (after a reload, or the queue finished): start the current queue track.
        const cur=queue.current();
        if((currentId===null||audio.ended)&&cur)await play(cur,queue.cursor);
        else if(currentId!==null)await audio.play();
        return ok;
      }
      case 'music.next':{const track=queue.next();if(!track)return {accepted:false,reason:'End of queue'};return queueCommand(track);}
      case 'music.previous':{
        if(currentId!==null&&audio.currentTime>3){audio.currentTime=0;return {accepted:true,restarted:true};}
        const track=queue.previous()??(queue.index===null?null:queue.jump(queue.index));
        if(!track)return {accepted:false,reason:'Queue is empty'};
        return queueCommand(track);
      }
      case 'music.queue.get':return queue.view();
      case 'music.lyrics.get':{
        const id=argInt(args,'track_id');await trackById(id);
        // The browser can't read files beside the audio, so every web lyric is stored in the library ("saved").
        const stored=await req(db.transaction('lyrics').objectStore('lyrics').get(id)) as {text:string,source?:string}|undefined;
        return stored?makeLyrics(stored.text,stored.source==='lrclib'?'lrclib':'saved'):null;
      }
      case 'music.lyrics.set':{
        const id=argInt(args,'track_id'),text=argStr(args,'text').trim();
        if(!text)throw request("missing or empty: text");
        const source=args.source??'saved';
        if(source!=='saved'&&source!=='lrclib')throw request(`source must be "saved" or "lrclib", not ${JSON.stringify(source)}`);
        if(new Blob([text]).size>MAX_LYRICS_BYTES)throw request(`Lyrics must be under ${MAX_LYRICS_BYTES/1024} KB`);
        await trackById(id);
        const tx=db.transaction('lyrics','readwrite');tx.objectStore('lyrics').put({text,source},id);await done(tx);
        return makeLyrics(text,source);
      }
      case 'music.lyrics.lookup':{
        const track=publicTrack(await trackById(argInt(args,'track_id')));
        const query=typeof args.query==='string'?args.query:null;
        const d=typeof args.duration_seconds==='number'&&args.duration_seconds>0?args.duration_seconds:track.duration_seconds;
        return lrclibLookup(track,query,d??null);
      }
      case 'music.lyrics.clear':{
        const id=argInt(args,'track_id');
        const tx=db.transaction('lyrics','readwrite');const store=tx.objectStore('lyrics');
        const had=await req(store.getKey(id))!==undefined;store.delete(id);await done(tx);
        return {removed:had};
      }
      case 'music.queue.set':{
        const ids=argIds(args);
        const start=args.start_index==null?0:argIndex(args,'start_index');
        if(start>=ids.length)throw request(`start_index must be below ${ids.length}`);
        const source=typeof args.source==='string'?args.source:null;
        const tracks=await tracksByIds(ids);
        return queueCommand(queue.replace(tracks,start,source));
      }
      case 'music.queue.add':{
        const tracks=await tracksByIds(argIds(args));
        const position=args.position??'last';
        if(position!=='next'&&position!=='last')throw request(`position must be "next" or "last", not ${JSON.stringify(position)}`);
        queue.add(tracks,position==='next');return queueCommand(null);
      }
      case 'music.queue.jump':{
        const index=argIndex(args,'index');const track=queue.jump(index);
        if(!track)throw request(`Queue has no item at index ${index}`);
        return queueCommand(track);
      }
      case 'music.queue.remove':queue.remove(argIndex(args,'index'));return queueCommand(null);
      case 'music.queue.move':queue.move(argIndex(args,'from'),argIndex(args,'to'));return queueCommand(null);
      case 'music.queue.clear':queue.clear();return queueCommand(null);
      case 'music.repeat.set':{
        const mode=argStr(args,'mode');
        if(mode!=='off'&&mode!=='all'&&mode!=='one')throw request(`mode must be off, all or one, not ${JSON.stringify(mode)}`);
        queue.setRepeat(mode as RepeatMode);return queueCommand(null);
      }
      case 'music.shuffle.set':{
        if(typeof args.enabled!=='boolean')throw request('enabled must be true or false');
        queue.setShuffle(args.enabled);return queueCommand(null);
      }
      case 'music.stop':audio.pause();audio.currentTime=0;currentId=null;return ok;
      case 'music.seek':{const s=argInt(args,'seconds');if(s<0)throw request('seconds must be nonnegative');audio.currentTime=s;return ok;}
      case 'music.volume.set':{const v=args.volume;if(typeof v!=='number')throw request('volume must be a number');if(v<0||v>1)throw request('volume must be between 0 and 1');audio.volume=v;return ok;}
      case 'music.status':return status();
      case 'music.playlist.create':{
        const n=argStr(args,'name');
        try{const id=await req(db.transaction('playlists','readwrite').objectStore('playlists').add({name:n}));return {id,name:n};}
        catch(e){if(e instanceof DOMException&&e.name==='ConstraintError')throw new Error(`A playlist named “${n}” already exists`);throw e;}
      }
      case 'music.playlist.list':return (await req(db.transaction('playlists').objectStore('playlists').getAll()) as Playlist[]).sort((a,b)=>a.name.localeCompare(b.name,undefined,{sensitivity:'base'}));
      case 'music.playlist.add_track':{
        const playlist_id=argInt(args,'playlist_id'),track_id=argInt(args,'track_id');
        const tx=db.transaction(['playlists','tracks','playlist_tracks'],'readwrite');
        if(await req(tx.objectStore('playlists').getKey(playlist_id))===undefined)throw new Error(`Playlist ${playlist_id} not found`);
        if(await req(tx.objectStore('tracks').getKey(track_id))===undefined)throw new Error(`Track ${track_id} not found`);
        const store=tx.objectStore('playlist_tracks');
        const entries=await req(store.index('playlist_id').getAll(playlist_id)) as PlaylistEntry[];
        store.add({playlist_id,track_id,position:entries.reduce((m,e)=>Math.max(m,e.position+1),0)});
        await done(tx);return {added:true};
      }
      case 'music.playlist.tracks':{
        const playlist_id=argInt(args,'playlist_id');
        const tx=db.transaction(['tracks','playlist_tracks']);
        const entries=(await req(tx.objectStore('playlist_tracks').index('playlist_id').getAll(playlist_id)) as PlaylistEntry[]).sort((a,b)=>a.position-b.position);
        const tracks=await Promise.all(entries.map(e=>req(tx.objectStore('tracks').get(e.track_id)) as Promise<StoredTrack|undefined>));
        return tracks.filter((t):t is StoredTrack=>!!t).map(publicTrack);
      }
      case 'music.metadata.update':{
        const id=argInt(args,'track_id'),title=argStr(args,'title'),artist=argStr(args,'artist'),album=argStr(args,'album');
        const tx=db.transaction('tracks','readwrite');const store=tx.objectStore('tracks');
        const t=await req(store.get(id)) as StoredTrack|undefined;
        if(t)store.put({...t,title,artist,album});
        await done(tx);
        if(t){queue.refreshTrack(publicTrack({...t,title,artist,album}));saveQueue();}
        return {updated:!!t};
      }
      default:throw new Error(`Invalid request: Unknown command: ${name}`);
    }
  }

  return {
    kind:'web',
    command:<T,>(name:string,args:Record<string,unknown>={})=>execute(name,args) as Promise<T>,
    async importMusic(){const files=await pickFiles();return files&&files.length?importFiles(files):null;},
    extractAudio,
    addAudioFile:file=>importFiles([file]),
  };
}
