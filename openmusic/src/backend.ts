// One command surface for the UI. The desktop build forwards every command to the Rust
// `MusicApp::execute` registry; the browser build cannot run Rodio/SQLite, so it implements the
// same command names on top of IndexedDB and an HTMLAudioElement (see webBackend.ts).

export type Track={id:number,path:string,title:string,artist:string,album:string,duration_seconds:number|null};
export type Playlist={id:number,name:string};
export type Playback={track_id:number|null,playing:boolean,volume:number,position_seconds:number,duration_seconds:number|null};
export type ImportResult={imported:number,already_present:number};

export interface Backend{
  kind:'desktop'|'web';
  command<T>(name:string,args?:Record<string,unknown>):Promise<T>;
  /** Asks the user for music (folder on desktop, files on web) and imports it. Null when cancelled. */
  importMusic():Promise<ImportResult|null>;
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
