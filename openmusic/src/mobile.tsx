import React, {useEffect, useMemo, useState, useSyncExternalStore} from 'react';
import type {ExtractedAudio, ImportResult, Playback, Playlist, QueueView, Track} from './backend';
import {ExtractSheet} from './extractSheet';
import {buildLabel} from './buildInfo';
import {getCachedChannel, getSettings} from './youtube';
import {useYouTube, VideoList, YouTubeScreen, type YouTubeState} from './youtubeScreen';
import {AudioLines, ChevronLeft, CirclePlay, ChevronRight, Clock, Disc3, Ellipsis, FolderPlus, House, Library, ListEnd, ListMusic, ListPlus, ListStart, Mic2, Music2, Pause, Play, Plus, Search, SkipForward, X} from 'lucide-react';
import {NowPlaying, type SheetMode} from './nowPlaying';
import './mobile.css';

// Phone layout: large-title screens, an inset-divider navigation list, and a floating glass mini player and tab bar.
// It only presents data; every action goes through the callbacks App passes in, which call the shared command surface.

export type MobileProps={
 web:boolean,tracks:Track[],playlists:Playlist[],status:Playback,playing:Track|undefined,queue:QueueView|null,error:string,notice:string,
 clearError():void,clearNotice():void,togglePlay():void,seek(seconds:number):void,setVolume(v:number):void,
 /** Runs a command through the shared surface, reporting failures in the error banner. */
 run(name:string,args?:Record<string,unknown>):void,
 /** Like run, but hands back the result (and still throws), for views that show what a command returns. */
 request<T>(name:string,args?:Record<string,unknown>):Promise<T>,
 importMusic():void,makePlaylist():void,addToPlaylist(t:Track):void,playlistTracks(id:number):Promise<Track[]>,
 /** Present only where the backend supports it (web for now). */
 extractAudio?(video:File):Promise<ExtractedAudio>,addAudioFile?(file:File):Promise<ImportResult>,
};
/** What the screens get: MobileProps plus actions that also drive the sheet and the song menu. */
type ViewProps=MobileProps&{playList(tracks:Track[],index:number,source:string):void,trackMenu(t:Track):void,openExtract?():void,yt:YouTubeState};
type Tab='home'|'library'|'search';
type Screen={name:Tab|'playlists'|'artists'|'albums'|'songs'|'recent'|'youtube'}|{name:'playlist',id:number,title:string}|{name:'artist',artist:string}|{name:'album',album:string};

const PHONE='(max-width:600px)';
export function useIsPhone(){
 return useSyncExternalStore(cb=>{const m=matchMedia(PHONE);m.addEventListener('change',cb);return()=>m.removeEventListener('change',cb);},()=>matchMedia(PHONE).matches);
}

function groupBy(tracks:Track[],key:(t:Track)=>string){
 const groups=new Map<string,Track[]>();
 for(const t of tracks){const k=key(t);groups.set(k,[...(groups.get(k)??[]),t]);}
 return [...groups].sort(([a],[b])=>a.localeCompare(b,undefined,{sensitivity:'base'}));
}
const plural=(n:number,word:string)=>`${n} ${word}${n===1?'':'s'}`;
const recentFirst=(tracks:Track[])=>[...tracks].sort((a,b)=>b.id-a.id);
// Case- and accent-insensitive, so "beyonce" finds "Beyoncé".
const fold=(s:string)=>s.normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase();

export function MobileApp(p:MobileProps){
 const [stack,setStack]=useState<Screen[]>([{name:'library'}]);
 const screen=stack[stack.length-1];
 const push=(s:Screen)=>setStack([...stack,s]);
 const back=()=>setStack(stack.slice(0,-1));
 // Search remembers the tab it was opened from, which the collapsed tab button returns to.
 const [lastTab,setLastTab]=useState<'home'|'library'>('library');
 const [query,setQuery]=useState('');
 const [typing,setTyping]=useState(false);
 const tab=(name:Tab)=>{if(name!=='search')setLastTab(name);setStack([{name}]);};
 const root=stack[0].name as Tab;
 // Typing while inside something opened from Search goes back to the results.
 const search=(q:string)=>{setQuery(q);if(stack.length>1)setStack([{name:'search'}]);};
 useKeyboardOffset();
 // Id of the song the sheet was opened for, so it can show before the next status poll reports it as playing.
 const [sheet,setSheet]=useState<number|null>(null);
 const sheetTrack=sheet===null?undefined:p.playing??p.tracks.find(t=>t.id===sheet);
 useEffect(()=>{if(p.error)setSheet(null);},[p.error]);
 const [menu,setMenu]=useState<Track|null>(null);
 // Lyrics or Up Next; kept here so the sheet reopens the way it was left.
 const [sheetMode,setSheetMode]=useState<SheetMode>('queue');
 const [extracting,setExtracting]=useState(false);
 const yt=useYouTube(getSettings(),getCachedChannel());
 const app:ViewProps={...p,yt,trackMenu:setMenu,openExtract:p.extractAudio&&(()=>setExtracting(true)),playList:(tracks,index,source)=>{
  p.run('music.queue.set',{track_ids:tracks.map(t=>t.id),start_index:index,source});setSheet(tracks[index].id);
 }};
 return <div className={typing?'m-app m-typing':'m-app'}>
  <div className="m-scroll" key={stack.length+JSON.stringify(screen)}>
   {p.error&&<div className="m-banner m-error" role="alert">{p.error}<button onClick={p.clearError}>Dismiss</button></div>}
   {p.notice&&<div className="m-banner m-notice">{p.notice}<button aria-label="Dismiss" onClick={p.clearNotice}>×</button></div>}
   <ScreenView p={app} screen={screen} query={query} push={push} back={stack.length>1?{label:titleOf(stack[stack.length-2]),go:back}:null}/>
  </div>
  <MiniPlayer p={p} open={()=>p.playing&&setSheet(p.playing.id)}/>
  <GlassTabBar active={root} lastTab={lastTab} onTab={tab} query={query} onQuery={search} onTyping={setTyping}/>
  {sheetTrack&&<NowPlaying track={sheetTrack} status={p.status} queue={p.queue} run={p.run} request={p.request} mode={sheetMode} setMode={setSheetMode} onClose={()=>setSheet(null)} togglePlay={p.togglePlay} seek={p.seek} setVolume={p.setVolume} addToPlaylist={p.addToPlaylist}/>}
  {extracting&&p.extractAudio&&p.addAudioFile&&<ExtractSheet extract={p.extractAudio} add={p.addAudioFile} onClose={()=>setExtracting(false)}/>}
  {menu&&<TrackMenu track={menu} onClose={()=>setMenu(null)} actions={[
   {icon:<ListStart/>,label:'Play Next',onClick:()=>p.run('music.queue.add',{track_ids:[menu.id],position:'next'})},
   {icon:<ListEnd/>,label:'Add to Queue',onClick:()=>p.run('music.queue.add',{track_ids:[menu.id],position:'last'})},
   {icon:<ListPlus/>,label:'Add to Playlist…',onClick:()=>p.addToPlaylist(menu)},
  ]}/>}
 </div>;
}

function titleOf(s:Screen){
 switch(s.name){case 'playlist':return s.title;case 'artist':return s.artist;case 'album':return s.album;
  default:return {home:'Home',library:'Library',playlists:'Playlists',artists:'Artists',albums:'Albums',songs:'Songs',recent:'Recently Added',youtube:'My YouTube Channel',search:'Search'}[s.name];}
}

function ScreenView({p,screen,query,push,back}:{p:ViewProps,screen:Screen,query:string,push(s:Screen):void,back:{label:string,go():void}|null}){
 const header=(actions=true)=><LibraryHeader title={titleOf(screen)} back={back} actions={actions?{web:p.web,importMusic:p.importMusic,makePlaylist:p.makePlaylist}:null}/>;
 const empty=p.tracks.length===0&&<EmptyLibrary web={p.web} importMusic={p.importMusic}/>;
 switch(screen.name){
  case 'home':{
   const recent=recentFirst(p.tracks).slice(0,12);
   return <>{header()}{empty||<><h2 className="m-section">Recently Added</h2>
    <div className="m-shelf">{recent.map((t,i)=><Tile key={t.id} title={t.title} subtitle={t.artist} onClick={()=>p.playList(recent,i,'Recently Added')}/>)}</div>
    {p.playlists.length>0&&<><h2 className="m-section">Your Playlists</h2>
     <div className="m-shelf">{p.playlists.map(pl=><Tile key={pl.id} title={pl.name} icon={<ListMusic/>} onClick={()=>push({name:'playlist',id:pl.id,title:pl.name})}/>)}</div></>}</>}</>;
  }
  case 'library':{
   const recent=[...p.playlists].sort((a,b)=>b.id-a.id).slice(0,10);
   return <>{header()}
    {recent.length>0&&<div className="m-shelf">{recent.map(pl=><Tile key={pl.id} title={pl.name} icon={<ListMusic/>} onClick={()=>push({name:'playlist',id:pl.id,title:pl.name})}/>)}</div>}
    <NavList rows={[
     {icon:<ListMusic/>,label:'Playlists',onClick:()=>push({name:'playlists'})},
     {icon:<Mic2/>,label:'Artists',onClick:()=>push({name:'artists'})},
     {icon:<Disc3/>,label:'Albums',onClick:()=>push({name:'albums'})},
     {icon:<Music2/>,label:'Songs',onClick:()=>push({name:'songs'})},
    ]}/>
    {empty}
    <p className="m-version">OpenMusic {buildLabel}</p></>;
  }
  case 'playlists':
   return <>{header()}<NavList rows={[
    {icon:<Plus/>,label:'New Playlist…',accent:true,chevron:false,onClick:p.makePlaylist},
    ...p.playlists.map(pl=>({icon:<ListMusic/>,label:pl.name,onClick:()=>push({name:'playlist',id:pl.id,title:pl.name})})),
   ]}/></>;
  case 'artists':
   return <>{header()}{empty||<NavList rows={groupBy(p.tracks,t=>t.artist).map(([artist,ts])=>({icon:<Mic2/>,label:artist,detail:plural(ts.length,'song'),onClick:()=>push({name:'artist',artist})}))}/>}</>;
  case 'albums':
   return <>{header()}{empty||<div className="m-grid">{groupBy(p.tracks,t=>t.album).map(([album,ts])=>{
    const artists=new Set(ts.map(t=>t.artist));
    return <Tile key={album} title={album} subtitle={artists.size===1?ts[0].artist:'Various Artists'} onClick={()=>push({name:'album',album})}/>;
   })}</div>}</>;
  case 'songs':return <>{header()}{empty||<TrackList p={p} tracks={p.tracks} source="Songs"/>}</>;
  case 'recent':return <>{header(false)}{empty||<TrackList p={p} tracks={recentFirst(p.tracks)} source="Recently Added"/>}</>;
  case 'artist':return <>{header(false)}<TrackList p={p} tracks={p.tracks.filter(t=>t.artist===screen.artist)} source={screen.artist}/></>;
  case 'album':return <>{header(false)}<TrackList p={p} tracks={p.tracks.filter(t=>t.album===screen.album)} source={screen.album}/></>;
  case 'playlist':return <>{header(false)}<PlaylistTracks p={p} id={screen.id} source={screen.title}/></>;
  case 'search':return <SearchScreen p={p} query={query} push={push}/>;
  case 'youtube':return <>{header(false)}<YouTubeScreen yt={p.yt} openExtract={p.openExtract}/></>;
 }
}

function LibraryHeader({title,back,actions}:{title:string,back:{label:string,go():void}|null,actions:{web:boolean,importMusic():void,makePlaylist():void}|null}){
 return <header className="m-header">
  {back&&<button className="m-back" onClick={back.go}><ChevronLeft size={24}/>{back.label}</button>}
  <div className="m-title-row"><h1>{title}</h1>
   {actions&&<div className="m-glass m-pill">
    <button title="New playlist" aria-label="New playlist" onClick={actions.makePlaylist}><ListPlus size={21}/></button>
    <button title={actions.web?'Add songs':'Import music'} aria-label={actions.web?'Add songs':'Import music'} onClick={actions.importMusic}><FolderPlus size={21}/></button>
   </div>}
  </div>
 </header>;
}

type Row={icon:React.ReactNode,label:string,detail?:string,accent?:boolean,chevron?:boolean,onClick():void};
function NavList({rows}:{rows:Row[]}){
 return <ul className="m-list">{rows.map((r,i)=><li key={i}><button className={r.accent?'m-row m-row-accent':'m-row'} onClick={r.onClick}>
  <span className="m-row-icon">{r.icon}</span>
  <span className="m-row-body"><span className="m-row-label">{r.label}</span>{r.detail&&<span className="m-row-detail">{r.detail}</span>}{r.chevron!==false&&<ChevronRight className="m-chevron" size={20}/>}</span>
 </button></li>)}</ul>;
}

// No artwork is extracted yet, so tiles and rows show a neutral placeholder rather than invented covers.
function Tile({title,subtitle,icon,onClick}:{title:string,subtitle?:string,icon?:React.ReactNode,onClick():void}){
 return <button className="m-tile" onClick={onClick}><span className="m-art">{icon??<Music2/>}</span><span className="m-tile-title">{title}</span>{subtitle&&<span className="m-tile-sub">{subtitle}</span>}</button>;
}

function TrackList({p,tracks,source}:{p:ViewProps,tracks:Track[],source:string}){
 if(tracks.length===0)return <p className="m-hint">No songs here yet.</p>;
 return <ul className="m-tracks">{tracks.map((t,i)=><li key={t.id} className={p.status.track_id===t.id?'m-track is-playing':'m-track'}>
  <button className="m-track-main" onClick={()=>p.playList(tracks,i,source)} aria-label={`Play ${t.title}`}>
   <span className="m-art m-art-sm"><Music2 size={20}/></span>
   <span className="m-track-text"><b>{t.title}</b><small>{t.artist}</small></span>
  </button>
  <button className="m-track-add" title="More" aria-label={`More actions for ${t.title}`} onClick={()=>p.trackMenu(t)}><Ellipsis size={20}/></button>
 </li>)}</ul>;
}

function PlaylistTracks({p,id,source}:{p:ViewProps,id:number,source:string}){
 const [tracks,setTracks]=useState<Track[]|null>(null);
 useEffect(()=>{let live=true;void p.playlistTracks(id).then(t=>{if(live)setTracks(t);});return()=>{live=false};},[id,p.playlists]);
 return tracks===null?<p className="m-hint">Loading…</p>:<TrackList p={p} tracks={tracks} source={source}/>;
}

/** Bottom action sheet for one song. */
function TrackMenu({track,actions,onClose}:{track:Track,actions:{icon:React.ReactNode,label:string,onClick():void}[],onClose():void}){
 return <div className="m-sheet-backdrop" onClick={onClose}>
  <div className="m-glass m-action-sheet" role="dialog" aria-modal="true" aria-label={`Actions for ${track.title}`} onClick={e=>e.stopPropagation()}>
   <div className="m-action-head"><span className="m-art m-art-xs"><Music2 size={18}/></span><span className="m-track-text"><b>{track.title}</b><small>{track.artist}</small></span></div>
   {actions.map(a=><button key={a.label} className="m-action" onClick={()=>{onClose();a.onClick();}}><span>{a.label}</span>{a.icon}</button>)}
   <button className="m-action m-action-cancel" onClick={onClose}>Cancel</button>
  </div>
 </div>;
}

function SearchScreen({p,query,push}:{p:ViewProps,query:string,push(s:Screen):void}){
 const q=fold(query.trim());
 const title=<header className="m-header"><div className="m-title-row"><h1>Search</h1></div></header>;
 const tools=<div className="m-cards m-tools">
  {p.openExtract&&<button className="m-card m-card-wide" style={{'--hue':350} as React.CSSProperties} onClick={p.openExtract}>
   <span className="m-card-icon" aria-hidden="true"><AudioLines/></span><span className="m-card-label">Extract Audio from a Video<small>Your own videos, e.g. from YouTube Studio</small></span></button>}
  <button className="m-card m-card-wide" style={{'--hue':28} as React.CSSProperties} onClick={()=>push({name:'youtube'})}>
   <span className="m-card-icon" aria-hidden="true"><CirclePlay/></span><span className="m-card-label">My YouTube Channel<small>{p.yt.channel?`${p.yt.channel.title} · ${plural(p.yt.channel.videos.length,'video')}`:'Find your videos and get their audio'}</small></span></button>
 </div>;
 if(p.tracks.length===0&&!q)return <>{title}{tools}<EmptyLibrary web={p.web} importMusic={p.importMusic}/></>;
 if(!q)return <>{title}{tools}<BrowseGrid p={p} push={push}/></>;
 const songs=p.tracks.filter(t=>fold(`${t.title} ${t.artist} ${t.album}`).includes(q));
 const artists=groupBy(p.tracks,t=>t.artist).filter(([name])=>fold(name).includes(q));
 const albums=groupBy(p.tracks,t=>t.album).filter(([name])=>fold(name).includes(q));
 const playlists=p.playlists.filter(pl=>fold(pl.name).includes(q));
 const videos=(p.yt.channel?.videos??[]).filter(v=>fold(v.title).includes(q));
 if(!songs.length&&!artists.length&&!albums.length&&!playlists.length&&!videos.length)return <>{title}<p className="m-hint">No results for “{query.trim()}” in your library.</p></>;
 return <>{title}
  {songs.length>0&&<><h2 className="m-section">Songs</h2><TrackList p={p} tracks={songs} source={`Search: ${query.trim()}`}/></>}
  {artists.length>0&&<><h2 className="m-section m-section-gap">Artists</h2><NavList rows={artists.map(([artist,ts])=>({icon:<Mic2/>,label:artist,detail:plural(ts.length,'song'),onClick:()=>push({name:'artist',artist})}))}/></>}
  {albums.length>0&&<><h2 className="m-section m-section-gap">Albums</h2><div className="m-shelf">{albums.map(([album,ts])=><Tile key={album} title={album} subtitle={plural(ts.length,'song')} onClick={()=>push({name:'album',album})}/>)}</div></>}
  {videos.length>0&&<><h2 className="m-section m-section-gap">On Your YouTube Channel</h2><VideoList videos={videos.slice(0,20)} openExtract={p.openExtract}/>
   {videos.length>20&&<button className="yt-link-btn" onClick={()=>push({name:'youtube'})}>See all {videos.length} matching videos</button>}</>}
  {playlists.length>0&&<><h2 className="m-section m-section-gap">Playlists</h2><NavList rows={playlists.map(pl=>({icon:<ListMusic/>,label:pl.name,onClick:()=>push({name:'playlist',id:pl.id,title:pl.name})}))}/></>}
 </>;
}

// Ten well-separated OKLCH hues (pink, red, amber, lime, green, teal, blue, indigo, purple, magenta). Picking from a
// palette by an FNV-1a hash of the name keeps each card's colour stable while spreading similar names apart.
const CARD_HUES=[355,28,62,128,152,195,238,268,300,330];
function cardHue(name:string){let h=0x811c9dc5;for(const c of name){h^=c.codePointAt(0)!;h=Math.imul(h,0x01000193);}return CARD_HUES[(h>>>0)%CARD_HUES.length];}

/** Search's empty state: colour cards for ways into your own library. Each card's colour comes from its name, so it never changes. */
function BrowseGrid({p,push}:{p:ViewProps,push(s:Screen):void}){
 const card=(key:string,label:string,icon:React.ReactNode,onClick:()=>void)=><button key={key} className="m-card" style={{'--hue':cardHue(label)} as React.CSSProperties} onClick={onClick}>
  <span className="m-card-icon" aria-hidden="true">{icon}</span><span className="m-card-label">{label}</span></button>;
 const topArtists=groupBy(p.tracks,t=>t.artist).sort((a,b)=>b[1].length-a[1].length).slice(0,6);
 const albums=groupBy(p.tracks,t=>t.album).slice(0,6);
 return <>
  <div className="m-cards">
   {card('recent','Recently Added',<Clock/>,()=>push({name:'recent'}))}
   {card('songs','Songs',<Music2/>,()=>push({name:'songs'}))}
   {card('artists','Artists',<Mic2/>,()=>push({name:'artists'}))}
   {card('albums','Albums',<Disc3/>,()=>push({name:'albums'}))}
  </div>
  {p.playlists.length>0&&<><h2 className="m-section m-section-gap">Your Playlists</h2>
   <div className="m-cards">{p.playlists.slice(0,8).map(pl=>card(`p${pl.id}`,pl.name,<ListMusic/>,()=>push({name:'playlist',id:pl.id,title:pl.name})))}</div></>}
  <h2 className="m-section m-section-gap">Artists</h2>
  <div className="m-cards">{topArtists.map(([artist])=>card(`a${artist}`,artist,<Mic2/>,()=>push({name:'artist',artist})))}</div>
  <h2 className="m-section m-section-gap">Albums</h2>
  <div className="m-cards">{albums.map(([album])=>card(`l${album}`,album,<Disc3/>,()=>push({name:'album',album})))}</div>
 </>;
}

/** Keeps the bottom search field above the on-screen keyboard (fixed elements otherwise sit behind it on iOS). */
function useKeyboardOffset(){
 useEffect(()=>{
  const vv=window.visualViewport;if(!vv)return;
  const update=()=>document.documentElement.style.setProperty('--kb',`${Math.max(0,window.innerHeight-vv.height-vv.offsetTop)}px`);
  vv.addEventListener('resize',update);vv.addEventListener('scroll',update);update();
  return()=>{vv.removeEventListener('resize',update);vv.removeEventListener('scroll',update);document.documentElement.style.removeProperty('--kb');};
 },[]);
}

function EmptyLibrary({web,importMusic}:{web:boolean,importMusic():void}){
 return <div className="m-empty"><span className="m-art"><Music2/></span><h2>Your library is empty</h2>
  <p>{web?'Choose songs to save on this device. They play offline and never leave it.':'Import a folder of audio files. Files stay on your computer.'}</p>
  <button className="m-primary" onClick={importMusic}><FolderPlus size={18}/>{web?'Add songs':'Add music folder'}</button></div>;
}

function MiniPlayer({p,open}:{p:MobileProps,open():void}){
 const {status,playing}=p;
 return <div className="m-glass m-mini">
  <div className="m-mini-row">
   <button className="m-mini-info" onClick={open} disabled={!playing} aria-label={playing?`Open Now Playing: ${playing.title}`:'Not Playing'}>
    <span className="m-art m-art-xs"><Music2 size={18}/></span>
    <span className="m-track-text"><b>{playing?.title??'Not Playing'}</b>{playing&&<small>{playing.artist}</small>}</span>
   </button>
   <button className="m-mini-btn" disabled={!playing} title={status.playing?'Pause':'Play'} aria-label={status.playing?'Pause':'Play'} onClick={p.togglePlay}>{status.playing?<Pause size={24} fill="currentColor"/>:<Play size={24} fill="currentColor"/>}</button>
   <button className="m-mini-btn" disabled={!status.has_next} title="Next" aria-label="Next" onClick={()=>p.run('music.next')}><SkipForward size={24} fill="currentColor"/></button>
  </div>
 </div>;
}

const TABS={home:{label:'Home',icon:<House size={24}/>},library:{label:'Library',icon:<Library size={24}/>}} as const;
/** Floating tab bar. On Search it collapses to one button for the previous tab, and the search circle widens into the field. */
function GlassTabBar({active,lastTab,onTab,query,onQuery,onTyping}:{active:Tab,lastTab:'home'|'library',onTab(name:Tab):void,query:string,onQuery(q:string):void,onTyping(on:boolean):void}){
 if(active==='search')return <nav className="m-tabs m-tabs-search" aria-label="Main">
  <button className="m-glass m-search-btn" aria-label={`Show tabs (back to ${TABS[lastTab].label})`} onClick={()=>onTab(lastTab)}>{TABS[lastTab].icon}</button>
  <form className="m-glass m-search-field" role="search" onSubmit={e=>{e.preventDefault();(document.activeElement as HTMLElement|null)?.blur();}}>
   <Search size={20}/>
   <input type="search" enterKeyHint="search" placeholder="Songs, Artists, Albums and More" aria-label="Search your library" value={query}
    onChange={e=>onQuery(e.target.value)} onFocus={()=>onTyping(true)} onBlur={()=>onTyping(false)}/>
   {query&&<button type="button" className="m-search-clear" aria-label="Clear search" onClick={()=>onQuery('')}><X size={16}/></button>}
  </form>
 </nav>;
 return <nav className="m-tabs" aria-label="Main">
  <div className="m-glass m-tabbar">{(['home','library'] as const).map(name=><button key={name} className={active===name?'m-tab active':'m-tab'} aria-current={active===name?'page':undefined} onClick={()=>onTab(name)}>{TABS[name].icon}<span>{TABS[name].label}</span></button>)}</div>
  <button className="m-glass m-search-btn" aria-label="Search" onClick={()=>onTab('search')}><Search size={24}/></button>
 </nav>;
}
