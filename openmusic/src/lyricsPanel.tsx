import React, {useEffect, useRef, useState} from 'react';
import type {Lyrics, Playback, Track} from './backend';
import type {LrclibCandidate, LrclibLookup} from './lrclib';
import {Search} from 'lucide-react';

type Request=<T>(name:string,args?:Record<string,unknown>)=>Promise<T>;
type Props={track:Track,status:Playback,request:Request,seek(seconds:number):void};

// Lead time so a line lights up just as it is sung rather than a beat late.
const LEAD_MS=150;
// After the user scrolls the lyrics themselves, stop following playback for a while.
const MANUAL_SCROLL_MS=4000;
// Lookups already made this session, so reopening the view doesn't hit LRCLIB again for the same song.
const looked=new Map<number,LrclibLookup>();

type View={kind:'loading'}|{kind:'lyrics',lyrics:Lyrics}|{kind:'searching'}|{kind:'results',lookup:LrclibLookup}
 |{kind:'failed',message:string}|{kind:'editing',initial:string};

const clock=(s:number|null)=>s==null?'':`${Math.floor(s/60)}:${String(Math.round(s%60)).padStart(2,'0')}`;

/**
 * Lyrics for the Now Playing sheet. Saved or .lrc lyrics show straight away; otherwise LRCLIB is searched
 * automatically and a confident match is saved. Timed lyrics follow playback; tap a line to jump there.
 */
export function LyricsPanel({track,status,request,seek}:Props){
 const [view,setView]=useState<View>({kind:'loading'});
 const [error,setError]=useState('');
 const duration=status.track_id===track.id?status.duration_seconds:null;
 const fail=(e:unknown)=>e instanceof Error?e.message:String(e);

 async function search(query:string|null,auto:boolean){
  setView({kind:'searching'});setError('');
  try{
   const lookup=await request<LrclibLookup>('music.lyrics.lookup',{track_id:track.id,query,duration_seconds:duration});
   looked.set(track.id,lookup);
   if(auto&&lookup.confident)await choose(lookup.candidates[0]);
   else setView({kind:'results',lookup});
  }catch(e){setView({kind:'failed',message:fail(e)});}
 }
 async function choose(c:LrclibCandidate){
  try{setView({kind:'lyrics',lyrics:await request<Lyrics>('music.lyrics.set',{track_id:track.id,text:c.lyrics,source:'lrclib'})});}
  catch(e){setView({kind:'failed',message:fail(e)});}
 }
 useEffect(()=>{
  let live=true;setView({kind:'loading'});setError('');
  request<Lyrics|null>('music.lyrics.get',{track_id:track.id}).then(l=>{
   if(!live)return;
   if(l)setView({kind:'lyrics',lyrics:l});
   else{const prev=looked.get(track.id);if(prev)setView({kind:'results',lookup:prev});else void search(null,true);}
  }).catch(e=>{if(live)setView({kind:'failed',message:fail(e)});});
  return()=>{live=false};
 },[track.id]);

 async function save(text:string){
  try{setError('');setView({kind:'lyrics',lyrics:await request<Lyrics>('music.lyrics.set',{track_id:track.id,text})});}
  catch(e){setError(fail(e));}
 }
 async function remove(){
  try{
   setError('');await request('music.lyrics.clear',{track_id:track.id});
   const l=await request<Lyrics|null>('music.lyrics.get',{track_id:track.id});
   // After removing, don't immediately fetch the same lyrics again: offer search instead.
   setView(l?{kind:'lyrics',lyrics:l}:{kind:'results',lookup:{candidates:[],confident:false,query:''}});
  }catch(e){setError(fail(e));}
 }
 const manual=(initial='')=>setView({kind:'editing',initial});

 switch(view.kind){
  case 'loading':return <section className="np-lyrics np-lyrics-empty"><p>Loading lyrics…</p></section>;
  case 'searching':return <section className="np-lyrics np-lyrics-empty" role="status"><span className="np-spinner" aria-hidden="true"/><p>Searching for lyrics…</p></section>;
  case 'editing':return <LyricsEditor initial={view.initial} error={error} onSave={save} onCancel={()=>{setError('');setView({kind:'loading'});void request<Lyrics|null>('music.lyrics.get',{track_id:track.id}).then(l=>setView(l?{kind:'lyrics',lyrics:l}:{kind:'results',lookup:looked.get(track.id)??{candidates:[],confident:false,query:''}}));}}/>;
  case 'failed':return <LyricsSearch track={track} lookup={looked.get(track.id)??{candidates:[],confident:false,query:''}} error={view.message} onSearch={q=>void search(q,false)} onPick={c=>void choose(c)} onManual={()=>manual()}/>;
  case 'results':return <LyricsSearch track={track} lookup={view.lookup} onSearch={q=>void search(q,false)} onPick={c=>void choose(c)} onManual={()=>manual()}/>;
  case 'lyrics':{
   const lyrics=view.lyrics;
   return <>
    {lyrics.synced?<SyncedLyrics lyrics={lyrics} status={status} seek={seek}/>:
     <section className="np-lyrics" aria-label="Lyrics">{lyrics.lines.map((l,i)=><p key={i} className="np-line plain">{l.text||'\u00a0'}</p>)}
      <p className="np-lyrics-note">These lyrics aren't time-synced.</p></section>}
    <div className="np-lyrics-actions">
     {lyrics.source==='lrclib'
      ?<span>Lyrics from <a href="https://lrclib.net" target="_blank" rel="noopener noreferrer">LRCLIB</a></span>
      :<span>{lyrics.source==='file'?'From a .lrc file next to the song':'Saved in your library'}</span>}
     {lyrics.source==='lrclib'?<button onClick={()=>void search(null,false)}>Wrong lyrics?</button>
      :<button onClick={()=>manual(lyrics.source==='saved'?lyrics.text:'')}>{lyrics.source==='file'?'Replace':'Edit'}</button>}
     {lyrics.source!=='file'&&<button onClick={()=>void remove()}>Remove</button>}
    </div>
    {error&&<p className="np-lyrics-error" role="alert">{error}</p>}
   </>;
  }
 }
}

/** Search box plus LRCLIB results: shown when no sure match was found, or when the user asks to search again. */
function LyricsSearch({track,lookup,error,onSearch,onPick,onManual}:{track:Track,lookup:LrclibLookup,error?:string,onSearch(q:string):void,onPick(c:LrclibCandidate):void,onManual():void}){
 const [query,setQuery]=useState(lookup.query||track.title);
 const none=lookup.candidates.length===0;
 return <section className="np-lyrics np-lyrics-search" aria-label="Find lyrics">
  <h2>{error?'Couldn\'t search for lyrics':none?(lookup.query?'No lyrics found':'Find lyrics'):'Pick the right lyrics'}</h2>
  {error?<p className="np-lyrics-error" role="alert">{error} You can search again below.</p>:<p>{none?(lookup.query?<>Nothing on LRCLIB for “{lookup.query}”. Try the song's exact title, maybe with the artist.</>:'Search LRCLIB by title and artist.'):'These might match. Timed lyrics follow along as the song plays.'}</p>}
  <form className="np-search" role="search" onSubmit={e=>{e.preventDefault();if(query.trim())onSearch(query.trim());}}>
   <Search size={17}/><input type="search" enterKeyHint="search" value={query} onChange={e=>setQuery(e.target.value)} aria-label="Search lyrics by title and artist" placeholder="Title and artist"/>
   <button type="submit" disabled={!query.trim()}>Search</button>
  </form>
  <ul className="np-results">{lookup.candidates.map(c=><li key={c.id}><button onClick={()=>onPick(c)}>
   <b>{c.track}</b><small>{[c.artist,clock(c.duration_seconds)].filter(Boolean).join(' · ')}</small>
   <span className={c.synced?'np-badge synced':'np-badge'}>{c.synced?'Timed':'Plain'}</span>
  </button></li>)}</ul>
  <button className="np-manual" onClick={onManual}>Type or paste lyrics yourself</button>
  <p className="np-lyrics-note">Search results come from <a href="https://lrclib.net" target="_blank" rel="noopener noreferrer">LRCLIB</a>, a community lyrics database. Only the search text is sent.</p>
 </section>;
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
