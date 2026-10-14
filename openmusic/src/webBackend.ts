// Browser implementation of the OpenMusic command registry. Mirrors the command names, argument
// validation and response shapes of `MusicApp::execute` (crates/openmusic-core) so the UI is
// identical on desktop and web. Imported audio is copied into IndexedDB on this device: nothing is
// uploaded, and playback works offline once the files are stored.
import type {Backend, ImportResult, Playback, Playlist, Track} from './backend';

const AUDIO_EXTENSIONS=['mp3','flac','wav','ogg','m4a','aac','alac'];
const DB_NAME='openmusic';

type StoredTrack=Track&{fingerprint:string,mime:string};
type PlaylistEntry={id?:number,playlist_id:number,track_id:number,position:number};

function req<T>(r:IDBRequest<T>):Promise<T>{return new Promise((ok,fail)=>{r.onsuccess=()=>ok(r.result);r.onerror=()=>fail(r.error);});}
function done(tx:IDBTransaction):Promise<void>{return new Promise((ok,fail)=>{tx.oncomplete=()=>ok();tx.onerror=()=>fail(tx.error);tx.onabort=()=>fail(tx.error??new Error('Transaction aborted'));});}

function openDb():Promise<IDBDatabase>{
  return new Promise((ok,fail)=>{
    const open=indexedDB.open(DB_NAME,1);
    open.onupgradeneeded=()=>{
      const db=open.result;
      db.createObjectStore('tracks',{keyPath:'id',autoIncrement:true}).createIndex('fingerprint','fingerprint',{unique:true});
      db.createObjectStore('files'); // key: track id, value: audio Blob
      db.createObjectStore('playlists',{keyPath:'id',autoIncrement:true}).createIndex('name','name',{unique:true});
      db.createObjectStore('playlist_tracks',{keyPath:'id',autoIncrement:true}).createIndex('playlist_id','playlist_id');
    };
    open.onsuccess=()=>ok(open.result);
    open.onerror=()=>fail(open.error??new Error('Could not open the on-device music library'));
  });
}

const request=(message:string)=>new Error(`Invalid request: ${message}`);
function argStr(args:Record<string,unknown>,key:string){const v=args[key];if(typeof v!=='string')throw request(`missing string argument '${key}'`);return v;}
function argInt(args:Record<string,unknown>,key:string){const v=args[key];if(typeof v!=='number'||!Number.isInteger(v))throw request(`missing integer argument '${key}'`);return v;}
const byTitle=(a:Track,b:Track)=>a.title.localeCompare(b.title,undefined,{sensitivity:'base'});
const publicTrack=({fingerprint:_f,mime:_m,...t}:StoredTrack):Track=>t;

export async function createWebBackend():Promise<Backend>{
  const db=await openDb();
  const audio=new Audio();
  audio.preload='auto';
  let currentId:number|null=null,objectUrl:string|null=null;

  async function allTracks(){return (await req(db.transaction('tracks').objectStore('tracks').getAll()) as StoredTrack[]).map(publicTrack).sort(byTitle);}
  async function trackById(id:number){const t=await req(db.transaction('tracks').objectStore('tracks').get(id)) as StoredTrack|undefined;if(!t)throw new Error(`Track ${id} not found`);return t;}

  function status():Playback{
    return {track_id:currentId,playing:currentId!==null&&!audio.paused&&!audio.ended,volume:audio.volume,
      position_seconds:Math.floor(audio.currentTime||0),duration_seconds:Number.isFinite(audio.duration)?Math.round(audio.duration):null};
  }

  async function play(id:number){
    const track=await trackById(id);
    const blob=await req(db.transaction('files').objectStore('files').get(id)) as Blob|undefined;
    if(!blob)throw new Error(`The audio for “${track.title}” is missing from this device. Import it again.`);
    audio.pause();
    if(objectUrl)URL.revokeObjectURL(objectUrl);
    objectUrl=URL.createObjectURL(blob);
    audio.src=objectUrl;currentId=id;
    if('mediaSession' in navigator)navigator.mediaSession.metadata=new MediaMetadata({title:track.title,artist:track.artist,album:track.album,artwork:[{src:'/icon-512.png',sizes:'512x512',type:'image/png'}]});
    try{await audio.play();}
    catch(e){
      if(e instanceof DOMException&&e.name==='NotSupportedError')throw new Error(`This browser can't play “${track.title}” (${track.mime||'unknown format'}). MP3 and M4A/AAC work everywhere.`);
      throw new Error(`Playback failed: ${e instanceof Error?e.message:String(e)}`);
    }
  }

  async function importFiles(files:File[]):Promise<ImportResult>{
    const audioFiles=files.filter(f=>AUDIO_EXTENSIONS.includes(f.name.split('.').pop()?.toLowerCase()??'')||f.type.startsWith('audio/'));
    let imported=0,already_present=0;
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
    return {imported,already_present};
  }

  function pickFiles():Promise<File[]|null>{
    return new Promise(resolve=>{
      const input=document.createElement('input');
      input.type='file';input.multiple=true;input.accept='audio/*,'+AUDIO_EXTENSIONS.map(e=>'.'+e).join(',');
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
    ms.setActionHandler('previoustrack',()=>{audio.currentTime=0;});
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
      case 'music.play':await play(argInt(args,'track_id'));return ok;
      case 'music.pause':audio.pause();return ok;
      case 'music.resume':if(currentId!==null)await audio.play();return ok;
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
        await done(tx);return {updated:!!t};
      }
      default:throw new Error(`Invalid request: Unknown command: ${name}`);
    }
  }

  return {
    kind:'web',
    command:<T,>(name:string,args:Record<string,unknown>={})=>execute(name,args) as Promise<T>,
    async importMusic(){const files=await pickFiles();return files&&files.length?importFiles(files):null;},
  };
}
