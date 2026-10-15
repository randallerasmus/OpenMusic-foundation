import React, {useEffect, useRef, useState} from 'react';
import type {Lyrics, Playback, Track} from './backend';
import {MessageSquareQuote} from 'lucide-react';

type Request=<T>(name:string,args?:Record<string,unknown>)=>Promise<T>;
type Props={track:Track,status:Playback,request:Request,seek(seconds:number):void};

// Lead time so a line lights up just as it is sung rather than a beat late.
const LEAD_MS=150;
// After the user scrolls the lyrics themselves, stop following playback for a while.
const MANUAL_SCROLL_MS=4000;

/** Lyrics for the Now Playing sheet: follows playback for timed (LRC) lyrics, tap a line to jump there. */
export function LyricsPanel({track,status,request,seek}:Props){
 const [lyrics,setLyrics]=useState<Lyrics|null|undefined>(undefined);
 const [editing,setEditing]=useState(false);
 const [error,setError]=useState('');
 useEffect(()=>{
  let live=true;setLyrics(undefined);setEditing(false);setError('');
  request<Lyrics|null>('music.lyrics.get',{track_id:track.id}).then(l=>{if(live)setLyrics(l);}).catch(e=>{if(live){setLyrics(null);setError(String(e instanceof Error?e.message:e));}});
  return()=>{live=false};
 },[track.id]);

 async function save(text:string){
  try{setError('');setLyrics(await request<Lyrics>('music.lyrics.set',{track_id:track.id,text}));setEditing(false);}
  catch(e){setError(e instanceof Error?e.message:String(e));}
 }
 async function remove(){
  try{setError('');await request('music.lyrics.clear',{track_id:track.id});setLyrics(await request<Lyrics|null>('music.lyrics.get',{track_id:track.id}));}
  catch(e){setError(e instanceof Error?e.message:String(e));}
 }

 if(editing)return <LyricsEditor initial={lyrics?.source==='saved'?lyrics.text:''} error={error} onSave={save} onCancel={()=>{setEditing(false);setError('');}}/>;
 if(lyrics===undefined)return <section className="np-lyrics np-lyrics-empty"><p>Loading lyrics…</p></section>;
 if(lyrics===null)return <section className="np-lyrics np-lyrics-empty">
  <MessageSquareQuote size={34}/>
  <h2>No lyrics for this song</h2>
  <p>Paste lyrics, or import a <b>.lrc</b> file with the same name as the song (for example <i>{track.title}.lrc</i>) to get lyrics that follow along.</p>
  {error&&<p className="np-lyrics-error" role="alert">{error}</p>}
  <button className="np-pill" onClick={()=>setEditing(true)}>Add Lyrics</button>
 </section>;
 return <>
  {lyrics.synced?<SyncedLyrics lyrics={lyrics} status={status} seek={seek}/>:
   <section className="np-lyrics" aria-label="Lyrics">{lyrics.lines.map((l,i)=><p key={i} className="np-line plain">{l.text||' '}</p>)}
    <p className="np-lyrics-note">These lyrics aren't time-synced.</p></section>}
  <div className="np-lyrics-actions">
   <span>{lyrics.source==='file'?'From a .lrc file next to the song':'Saved in your library'}</span>
   <button onClick={()=>setEditing(true)}>{lyrics.source==='file'?'Replace':'Edit'}</button>
   {lyrics.source==='saved'&&<button onClick={()=>void remove()}>Remove</button>}
  </div>
  {error&&<p className="np-lyrics-error" role="alert">{error}</p>}
 </>;
}

/** Status arrives every ~500 ms; between polls the position is extrapolated so lines change on time. */
function usePlaybackMs(status:Playback){
 const anchor=useRef({ms:status.position_ms,at:performance.now()});
 const [, tick]=useState(0);
 useEffect(()=>{anchor.current={ms:status.position_ms,at:performance.now()};},[status]);
 useEffect(()=>{
  if(!status.playing)return;
  const timer=setInterval(()=>tick(n=>n+1),100);
  return()=>clearInterval(timer);
 },[status.playing]);
 return status.playing?anchor.current.ms+(performance.now()-anchor.current.at):anchor.current.ms;
}

function SyncedLyrics({lyrics,status,seek}:{lyrics:Lyrics,status:Playback,seek(seconds:number):void}){
 const now=usePlaybackMs(status)+LEAD_MS;
 let active=-1;
 for(let i=0;i<lyrics.lines.length;i++){if((lyrics.lines[i].time_ms??0)<=now)active=i;else break;}
 const box=useRef<HTMLElement>(null);
 const manualAt=useRef(0);
 useEffect(()=>{
  const el=box.current;if(!el||active<0||performance.now()-manualAt.current<MANUAL_SCROLL_MS)return;
  const line=el.children[active] as HTMLElement|undefined;
  // Keep the current line in the upper third, where the eye expects it.
  if(line)el.scrollTo({top:line.offsetTop-el.clientHeight*0.3,behavior:'smooth'});
 },[active]);
 const manual=()=>{manualAt.current=performance.now();};
 return <section className="np-lyrics" ref={box} aria-label="Lyrics" onWheel={manual} onTouchStart={manual}>
  {lyrics.lines.map((l,i)=><button key={i} className={i===active?'np-line active':i<active?'np-line past':'np-line'}
   aria-current={i===active?'true':undefined} onClick={()=>{manualAt.current=0;seek(Math.floor((l.time_ms??0)/1000));}}>
   {l.text||<span className="np-line-gap" aria-label="Instrumental">• • •</span>}
  </button>)}
 </section>;
}

function LyricsEditor({initial,error,onSave,onCancel}:{initial:string,error:string,onSave(text:string):void,onCancel():void}){
 const [text,setText]=useState(initial);
 return <section className="np-lyrics-editor">
  <label htmlFor="np-lyrics-text">Lyrics</label>
  <textarea id="np-lyrics-text" autoFocus value={text} onChange={e=>setText(e.target.value)} spellCheck={false}
   placeholder={'Paste the words, one line per line.\n\nFor lyrics that follow along, use LRC timing:\n[00:12.50]First line\n[00:16.00]Second line'}/>
  {error&&<p className="np-lyrics-error" role="alert">{error}</p>}
  <div className="np-editor-buttons"><button onClick={onCancel}>Cancel</button><button className="np-pill" disabled={!text.trim()} onClick={()=>onSave(text)}>Save</button></div>
 </section>;
}
