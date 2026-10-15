import type {RepeatMode} from './queue';
export type {QueueItem, QueueView, RepeatMode} from './queue';

// One command surface for the UI. The desktop build forwards every command to the Rust
// `MusicApp::execute` registry; the browser build cannot run Rodio/SQLite, so it implements the
// same command names on top of IndexedDB and an HTMLAudioElement (see webBackend.ts).

export type Track={id:number,path:string,title:string,artist:string,album:string,duration_seconds:number|null};
export type Playlist={id:number,name:string};
export type Playback={track_id:number|null,playing:boolean,volume:number,position_seconds:number,duration_seconds:number|null,position_ms:number,
  queue_index:number|null,queue_length:number,queue_revision:number,repeat:RepeatMode,shuffle:boolean,has_next:boolean};
export type ImportResult={imported:number,already_present:number,
  /** Web only: .lrc files matched to songs during this import. */
  lyrics?:number};
export type {LyricLine, Lyrics} from './lyrics';
import type {ExtractedAudio} from './mp4audio';
export type {ExtractedAudio} from './mp4audio';

export interface Backend{
  kind:'desktop'|'web';
  command<T>(name:string,args?:Record<string,unknown>):Promise<T>;
  /** Asks the user for music (folder on desktop, files on web) and imports it. Null when cancelled. */
  importMusic():Promise<ImportResult|null>;
  /** Copies a video's audio track into an .m4a without re-encoding. Web only for now (absent on desktop). */
  extractAudio?(video:File):Promise<ExtractedAudio>;
  /** Adds one audio file (e.g. an extracted .m4a) to the library. Web only for now. */
  addAudioFile?(file:File):Promise<ImportResult>;
}

const isTauri=typeof window!=='undefined'&&'__TAURI_INTERNALS__' in window;

const desktopBackend:Backend={
  kind:'desktop',
  async command<T>(name:string,args:Record<string,unknown>={}){
    const {invoke}=await import('@tauri-apps/api/core');
    return invoke<T>('music_command',{command:name,args});
  },
  async importMusic(){
    const {open}=await import('@tauri-apps/plugin-dialog');
    let path:string|null;
    try{path=await open({directory:true,multiple:false,title:'Choose a music folder to import'});}
    catch(e){throw new Error(`Folder picker failed: ${e}`);}
    if(!path)return null;
    return this.command<ImportResult>('music.library.scan',{path});
  },
};

export async function loadBackend():Promise<Backend>{
  if(isTauri)return desktopBackend;
  const {createWebBackend}=await import('./webBackend');
  return createWebBackend();
}
