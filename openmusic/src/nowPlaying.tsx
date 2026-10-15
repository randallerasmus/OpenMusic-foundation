import React, {useRef, useState} from 'react';
import type {Playback, QueueView, Track} from './backend';
import {Airplay, Ellipsis, GripHorizontal, Infinity as Autoplay, ListMusic, MessageSquareQuote, Music2, Pause, Play, Repeat, Repeat1, Shuffle, SkipBack, SkipForward, Star, Volume1, Volume2, Blend, X} from 'lucide-react';

// Full-screen player sheet in its "Up Next" arrangement. Playback, queue, shuffle and repeat go through the
// shared command surface; autoplay, crossfade, favourites, lyrics and output selection are not implemented
// in the core yet, so they render disabled and say so.

type Run=(name:string,args?:Record<string,unknown>)=>void;
type Props={track:Track,status:Playback,queue:QueueView|null,run:Run,onClose():void,togglePlay():void,seek(seconds:number):void,setVolume(v:number):void,addToPlaylist(t:Track):void};

// No artwork is extracted yet, so each song gets a stable colour from its title instead of an invented cover.
function hueOf(s:string){let h=0;for(const c of s)h=(h*31+c.charCodeAt(0))%360;return h;}
function time(s:number|null|undefined){if(s==null||!isFinite(s))return '–:––';s=Math.max(0,Math.floor(s));return `${Math.floor(s/60)}:${String(s%60).padStart(2,'0')}`;}
const NEXT_REPEAT={off:'all',all:'one',one:'off'} as const;

export function NowPlaying({track,status,queue,run,onClose,togglePlay,seek,setVolume,addToPlaylist}:Props){
 const [drag,setDrag]=useState(0);
 const start=useRef<number|null>(null);
 const hue=hueOf(track.title+track.artist);
 const duration=status.duration_seconds;
 const pct=(v:number,max:number)=>({'--pct':`${max>0?Math.min(100,v/max*100):0}%`} as React.CSSProperties);
 // Drag the top area down to dismiss, like a native sheet.
 const grab={
  onPointerDown:(e:React.PointerEvent)=>{start.current=e.clientY;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);},
  onPointerMove:(e:React.PointerEvent)=>{if(start.current!==null)setDrag(Math.max(0,e.clientY-start.current));},
  onPointerUp:()=>{if(drag>110)onClose();start.current=null;setDrag(0);},
  onPointerCancel:()=>{start.current=null;setDrag(0);},
 };
 const planned=(label:string)=>({disabled:true,title:`${label} (planned)`,'aria-label':`${label} (planned)`});
 const toggle=(label:string,on:boolean)=>({className:on?'on':undefined,title:label,'aria-label':label,'aria-pressed':on});
 const repeatLabel={off:'Repeat: off',all:'Repeat: all',one:'Repeat: this song'}[status.repeat];
 return <div className="np" role="dialog" aria-modal="true" aria-label="Now Playing"
  style={{'--hue':hue,transform:drag?`translateY(${drag}px)`:undefined,transition:drag?'none':undefined} as React.CSSProperties}>
  <div className="np-grab-area" {...grab}><button className="np-grabber" aria-label="Close Now Playing" onClick={onClose}/></div>

  <header className="np-head">
   <span className="np-art"><Music2/></span>
   <span className="np-titles"><b>{track.title}</b><small>{track.artist}</small></span>
   <button className="np-round" {...planned('Favourite')}><Star size={20}/></button>
   <button className="np-round" title="Add to playlist" aria-label="Add to playlist" onClick={()=>addToPlaylist(track)}><Ellipsis size={22}/></button>
  </header>

  <div className="np-modes">
   <button {...toggle(status.shuffle?'Shuffle: on':'Shuffle: off',status.shuffle)} onClick={()=>run('music.shuffle.set',{enabled:!status.shuffle})}><Shuffle size={20}/></button>
   <button {...toggle(repeatLabel,status.repeat!=='off')} onClick={()=>run('music.repeat.set',{mode:NEXT_REPEAT[status.repeat]})}>{status.repeat==='one'?<Repeat1 size={20}/>:<Repeat size={20}/>}</button>
   <button {...planned('Autoplay')}><Autoplay size={22}/></button>
   <button {...planned('Crossfade')}><Blend size={20}/></button>
  </div>

  <UpNext queue={queue} repeat={status.repeat} run={run}/>

  <div className="np-bottom">
   <input className="np-bar" type="range" aria-label="Seek" min="0" max={duration??Math.max(status.position_seconds,1)} step="1"
    value={status.position_seconds} style={pct(status.position_seconds,duration??0)} disabled={duration==null&&status.position_seconds===0}
    onChange={e=>seek(Number(e.target.value))}/>
   <div className="np-times"><span>{time(status.position_seconds)}</span><span>{duration==null?'–:––':'−'+time(duration-status.position_seconds)}</span></div>

   <div className="np-transport">
    <button title="Previous" aria-label="Previous" onClick={()=>run('music.previous')}><SkipBack size={38} fill="currentColor"/></button>
    <button className="np-play" title={status.playing?'Pause':'Play'} aria-label={status.playing?'Pause':'Play'} onClick={togglePlay}>{status.playing?<Pause size={46} fill="currentColor"/>:<Play size={46} fill="currentColor"/>}</button>
    <button title="Next" aria-label="Next" disabled={!status.has_next} onClick={()=>run('music.next')}><SkipForward size={38} fill="currentColor"/></button>
   </div>

   <div className="np-volume"><Volume1 size={18}/>
    <input className="np-bar" type="range" aria-label="Volume" min="0" max="1" step="0.01" value={status.volume} style={pct(status.volume,1)} onChange={e=>setVolume(Number(e.target.value))}/>
    <Volume2 size={18}/></div>

   <div className="np-tools">
    <button {...planned('Lyrics')}><MessageSquareQuote size={24}/></button>
    <button {...planned('Audio output')}><Airplay size={24}/></button>
    <button className="active" aria-pressed="true" title="Up Next" aria-label="Up Next"><ListMusic size={22}/></button>
   </div>
  </div>
 </div>;
}

const ROW=64;
/** Upcoming tracks. Tap a row to jump to it; drag its handle to reorder; × removes it. */
function UpNext({queue,repeat,run}:{queue:QueueView|null,repeat:Playback['repeat'],run:Run}){
 const [drag,setDrag]=useState<{from:number,dy:number}|null>(null);
 const startY=useRef(0);
 if(!queue)return <section className="np-queue"/>;
 const first=(queue.index??-1)+1;
 const upcoming=queue.items.slice(first);
 const target=drag&&Math.max(0,Math.min(upcoming.length-1,drag.from+Math.round(drag.dy/ROW)));
 const handle=(i:number)=>({
  onPointerDown:(e:React.PointerEvent)=>{startY.current=e.clientY;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);setDrag({from:i,dy:0});},
  onPointerMove:(e:React.PointerEvent)=>{if(drag)setDrag({from:drag.from,dy:e.clientY-startY.current});},
  onPointerUp:()=>{if(drag&&target!==null&&target!==drag.from)run('music.queue.move',{from:first+drag.from,to:first+target});setDrag(null);},
  onPointerCancel:()=>setDrag(null),
 });
 // While dragging, rows between the origin and the target shift by one slot to make room.
 const offset=(i:number)=>{
  if(!drag||target===null)return 0;
  if(i===drag.from)return drag.dy;
  if(drag.from<target&&i>drag.from&&i<=target)return -ROW;
  if(drag.from>target&&i<drag.from&&i>=target)return ROW;
  return 0;
 };
 return <section className="np-queue">
  <h2>Continue Playing</h2>
  {queue.source&&<p className="np-source">From {queue.source}</p>}
  {upcoming.length===0?<p className="np-empty">Nothing up next. Use Play Next or Add to Queue on any song.</p>:
  <ol className="np-list">{upcoming.map((item,i)=><li key={item.entry} className={drag?.from===i?'dragging':undefined} style={{transform:`translateY(${offset(i)}px)`}}>
   <button className="np-row" onClick={()=>run('music.queue.jump',{index:first+i})} aria-label={`Play ${item.track.title}`}>
    <span className="np-art np-art-sm"><Music2/></span>
    <span className="np-titles"><b>{item.track.title}</b><small>{item.track.artist}</small></span>
   </button>
   <button className="np-row-btn" title="Remove from queue" aria-label={`Remove ${item.track.title} from queue`} onClick={()=>run('music.queue.remove',{index:first+i})}><X size={18}/></button>
   <span className="np-handle" role="button" tabIndex={-1} aria-label={`Reorder ${item.track.title}`} {...handle(i)}><GripHorizontal size={22}/></span>
  </li>)}</ol>}
  {repeat!=='off'&&<p className="np-repeat">{repeat==='one'?<><Repeat1 size={16}/> Repeating this song</>:<><Repeat size={16}/> Repeating {queue.items.length} {queue.items.length===1?'song':'songs'}</>}</p>}
 </section>;
}
