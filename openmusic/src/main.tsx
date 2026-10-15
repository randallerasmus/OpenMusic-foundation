import React, {useEffect, useMemo, useState} from 'react';
import {createRoot} from 'react-dom/client';
import {loadBackend, type Backend, type Playback, type Playlist, type QueueView, type Track} from './backend';
import {Music2, Library, Search, ListMusic, Play, Pause, SkipBack, SkipForward, FolderPlus, Plus, Volume2, Disc3, ArrowLeft, Shuffle, Repeat, Repeat1} from 'lucide-react';
import {MobileApp, useIsPhone} from './mobile';
import './style.css';

function App({backend}:{backend:Backend}){
 const command=backend.command.bind(backend);
 const web=backend.kind==='web';
 const phone=useIsPhone();
 const [tracks,setTracks]=useState<Track[]>([]),[playlists,setPlaylists]=useState<Playlist[]>([]);
 const [selected,setSelected]=useState('Home'),[query,setQuery]=useState(''),[error,setError]=useState(''),[notice,setNotice]=useState('');
 const [status,setStatus]=useState<Playback>({track_id:null,playing:false,volume:.75,position_seconds:0,duration_seconds:null,position_ms:0,queue_index:null,queue_length:0,queue_revision:-1,repeat:'off',shuffle:false,has_next:false});
 const [queue,setQueue]=useState<QueueView|null>(null);
 const [currentPlaylist,setCurrentPlaylist]=useState<number|null>(null),[listTracks,setListTracks]=useState<Track[]>([]);
 async function refresh(){try{ const [songs,lists]=await Promise.all([command<Track[]>('music.library.list'),command<Playlist[]>('music.playlist.list')]);setTracks(songs);setPlaylists(lists);}catch(e){setError(e instanceof Error?e.message:String(e));}}
 useEffect(()=>{void refresh();const timer=setInterval(()=>{void command<Playback>('music.status').then(setStatus).catch(e=>setError(String(e)))},500);return()=>clearInterval(timer)},[]);
 // The queue can change without a command from this UI (a track ending advances it), so refetch whenever its revision moves.
 useEffect(()=>{if(status.queue_revision>=0)void command<QueueView>('music.queue.get').then(setQueue).catch(e=>setError(String(e)));},[status.queue_revision]);
 useEffect(()=>{ if(currentPlaylist!==null)void command<Track[]>('music.playlist.tracks',{playlist_id:currentPlaylist}).then(setListTracks).catch(e=>setError(String(e)));},[currentPlaylist,playlists]);
 const visible=useMemo(()=>{const source=currentPlaylist!==null?listTracks:tracks;const q=query.toLowerCase().trim();return q?source.filter(t=>`${t.title} ${t.artist} ${t.album}`.toLowerCase().includes(q)):source},[tracks,listTracks,currentPlaylist,query]);
 // Nothing loaded after a restart: show the restored queue's current song, which Play then resumes.
 const playing=tracks.find(t=>t.id===status.track_id)??(status.track_id===null&&queue?.index!=null?queue.items[queue.index]?.track:undefined);
 async function exec(name:string,args:Record<string,unknown>={}){try{setError('');await command(name,args); if(name==='music.playlist.create'||name==='music.playlist.add_track')await refresh(); setStatus(await command<Playback>('music.status'));}catch(e){setError(e instanceof Error?e.message:String(e));}}
 // Playing from a list queues the whole list, starting at the chosen song.
 function playFrom(list:Track[],track:Track,source:string){void exec('music.queue.set',{track_ids:list.map(t=>t.id),start_index:list.indexOf(track),source});}
 async function importMusic(){try{setError('');setNotice(web?'Saving songs to this device…':'Scanning music folder…');const result=await backend.importMusic();if(!result){setNotice('');return;}setNotice(`Imported ${result.imported} new tracks · ${result.already_present} already in library${result.lyrics?` · lyrics for ${result.lyrics} ${result.lyrics===1?'song':'songs'}`:''}`);await refresh();}catch(e){setError(e instanceof Error?e.message:String(e));setNotice('');}}
 async function makePlaylist(){const name=window.prompt('New playlist name');if(name?.trim())await exec('music.playlist.create',{name:name.trim()});}
 async function addToPlaylist(track:Track){if(playlists.length===0){setNotice('Create a playlist first.');return;}const choice=window.prompt(`Add “${track.title}” to which playlist?\n${playlists.map(p=>`${p.id}: ${p.name}`).join('\n')}`);if(choice){const id=Number(choice);if(playlists.some(p=>p.id===id))await exec('music.playlist.add_track',{playlist_id:id,track_id:track.id});else setError('Invalid playlist ID.');}}
 function choose(where:string,pid:number|null=null){setSelected(where);setCurrentPlaylist(pid);setQuery('');}
 function time(s:number|null|undefined){if(s==null)return '—';return `${Math.floor(s/60)}:${String(Math.floor(s%60)).padStart(2,'0')}`;}
 if(phone)return <MobileApp web={web} tracks={tracks} playlists={playlists} status={status} playing={playing} queue={queue} error={error} notice={notice}
  clearError={()=>setError('')} clearNotice={()=>setNotice('')} run={(name,args)=>void exec(name,args)} request={(name,args)=>command(name,args)} togglePlay={()=>void exec(status.playing?'music.pause':'music.resume')}
  seek={seconds=>void exec('music.seek',{seconds})} setVolume={volume=>void exec('music.volume.set',{volume})} importMusic={()=>void importMusic()} makePlaylist={()=>void makePlaylist()} addToPlaylist={t=>void addToPlaylist(t)}
  extractAudio={backend.extractAudio} addAudioFile={backend.addAudioFile&&(async file=>{const r=await backend.addAudioFile!(file);await refresh();return r;})}
  playlistTracks={id=>command<Track[]>('music.playlist.tracks',{playlist_id:id}).catch(e=>{setError(String(e));return [];})}/>;
 return <div className="app">
 <aside className="sidebar"><div className="brand"><div className="logo"><Music2 size={22}/></div><strong>OpenMusic</strong></div><div className="side-label">DISCOVER</div>
 <button className={selected==='Home'?'nav active':'nav'} onClick={()=>choose('Home')}><Disc3 size={18}/>Home</button>
 <button className={selected==='Library'?'nav active':'nav'} onClick={()=>choose('Library')}><Library size={18}/>Library</button>
 <div className="side-label">YOUR COLLECTION</div><div className="side-section"><span>Playlists</span><button title="Create playlist" onClick={makePlaylist}><Plus size={17}/></button></div>
 <div className="playlist-navigation">{playlists.map(p=><button key={p.id} className={currentPlaylist===p.id?'nav active':'nav'} onClick={()=>choose(p.name,p.id)}><ListMusic size={17}/><span className="truncate">{p.name}</span></button>)}</div>
 <div className="sidebar-bottom">Made for your music. <br/>Private. Local. Yours.<small>OpenMusic v0.1 foundation</small></div></aside>
 <main className="main"><header className="toolbar"><div className="breadcrumbs"><button aria-label="Library" onClick={()=>choose('Library')}><ArrowLeft size={17}/></button><span>{selected}</span></div><div className="search"><Search size={17}/><input placeholder="Search your library" aria-label="Search library" value={query} onChange={e=>setQuery(e.target.value)}/></div><button className="import" title={web?"Add songs":"Import music"} aria-label={web?"Add songs":"Import music"} onClick={importMusic}><FolderPlus size={17}/> Import music</button></header>
 <div className="content"><div className="eyebrow">YOUR SOUNDTRACK</div><h1>{currentPlaylist!==null?selected:selected==='Home'?'Music, your way.':'Your library'}</h1><p className="subtitle">{currentPlaylist!==null?'A playlist you control.':selected==='Home'?'A home for the music you own. No subscription required.':'All your tracks in one beautiful place.'}</p>
 {error&&<div className="error" role="alert">{error}<button onClick={()=>setError('')}>Dismiss</button></div>}{notice&&<div className="notice">{notice}<button onClick={()=>setNotice('')}>×</button></div>}
 {tracks.length===0?<div className="empty"><div className="empty-art"><Music2 size={52}/></div><h2>Your next favorite song is already yours.</h2><p>{web?'Choose songs to save on this device. They play offline and never leave it.':'Import a folder of audio files to start listening. Files stay on your computer.'}</p><button className="primary" onClick={importMusic}><FolderPlus size={17}/> {web?'Add songs':'Add music folder'}</button></div>:
 <><section className="stats"><div><small>TRACKS IN LIBRARY</small><strong>{tracks.length.toLocaleString()}</strong></div><div><small>PLAYLISTS</small><strong>{playlists.length}</strong></div><div><small>PLAYING NOW</small><strong>{status.playing?'Listening':'Idle'}</strong></div></section>
 <div className="section-heading"><h2>{query?'Search results':currentPlaylist!==null?'Playlist tracks':'All songs'}</h2><span>{visible.length} songs</span></div>
 <div className="track-table"><div className="track-head"><span>TRACK</span><span>ALBUM</span><span>DURATION</span><span></span></div>{visible.map((t,i)=><div key={t.id} className={`track ${status.track_id===t.id?'is-playing':''}`} onDoubleClick={()=>playFrom(visible,t,(query?'Search':currentPlaylist!==null?selected:'All Songs'))}><div className="track-name"><div className="track-art"><Music2 size={18}/></div><div className="title-lines"><b>{t.title}</b><small>{t.artist}</small></div></div><span className="album truncate">{t.album}</span><span className="duration">{time(t.duration_seconds)}</span><div className="track-actions"><button title="Play" aria-label={`Play ${t.title}`} onClick={()=>playFrom(visible,t,(query?'Search':currentPlaylist!==null?selected:'All Songs'))}><Play size={16} fill="currentColor"/></button><button title="Add to playlist" aria-label={`Add ${t.title} to playlist`} onClick={()=>void addToPlaylist(t)}><Plus size={17}/></button></div></div>)}</div></>}
 </div></main>
 <footer className="player"><div className="now"><div className="cover"><Music2 size={23}/></div><div className="now-text"><b>{playing?.title??'Nothing playing'}</b><small>{playing?.artist??'Choose a song to begin'}</small></div></div><div className="transport"><div className="transport-buttons"><button className={status.shuffle?'mode on':'mode'} title={status.shuffle?'Shuffle: on':'Shuffle: off'} aria-pressed={status.shuffle} onClick={()=>void exec('music.shuffle.set',{enabled:!status.shuffle})}><Shuffle size={17}/></button><button disabled={status.queue_length===0} title="Previous" aria-label="Previous" onClick={()=>void exec('music.previous')}><SkipBack size={19}/></button><button className="play-button" title={status.playing?'Pause':'Resume'} onClick={()=>void exec(status.playing?'music.pause':'music.resume')}><>{status.playing?<Pause size={18} fill="currentColor"/>:<Play size={18} fill="currentColor"/>}</></button><button disabled={!status.has_next} title="Next" aria-label="Next" onClick={()=>void exec('music.next')}><SkipForward size={19}/></button><button className={status.repeat!=='off'?'mode on':'mode'} title={`Repeat: ${status.repeat==='one'?'this song':status.repeat}`} aria-pressed={status.repeat!=='off'} onClick={()=>void exec('music.repeat.set',{mode:{off:'all',all:'one',one:'off'}[status.repeat]})}>{status.repeat==='one'?<Repeat1 size={17}/>:<Repeat size={17}/>}</button></div><div className="progress"><span>{time(status.position_seconds)}</span><input aria-label="Seek" type="range" min="0" max={status.duration_seconds??Math.max(status.position_seconds,1)} value={status.position_seconds} onChange={e=>void exec('music.seek',{seconds:Number(e.target.value)})} disabled={!playing}/><span>{time(status.duration_seconds)}</span></div></div><div className="volume"><Volume2 size={19}/><input aria-label="Volume" type="range" min="0" max="1" step="0.01" value={status.volume} onChange={e=>void exec('music.volume.set',{volume:Number(e.target.value)})}/></div></footer>
 </div>;
}
const root=createRoot(document.getElementById('root')!);
loadBackend().then(backend=>{
 root.render(<React.StrictMode><App backend={backend}/></React.StrictMode>);
 // Offline support for the installed web app; the desktop app bundles its assets already.
 if(backend.kind==='web'&&import.meta.env.PROD&&'serviceWorker' in navigator)void navigator.serviceWorker.register('/sw.js').catch(e=>console.warn('Offline support unavailable:',e));
}).catch(e=>root.render(<div className="error" role="alert">OpenMusic could not start: {e instanceof Error?e.message:String(e)}</div>));
