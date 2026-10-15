import React, {useEffect, useState} from 'react';
import {AudioLines, ExternalLink, RefreshCw, Search} from 'lucide-react';
import {fetchChannel, parseChannel, saveSettings, studioUrl, type YouTubeChannel, type YouTubeSettings, type YouTubeVideo} from './youtube';

/** Shared by the YouTube screen and Search results, owned by MobileApp so both see the same list. */
export type YouTubeState={
 settings:YouTubeSettings|null,channel:YouTubeChannel|null,loading:boolean,error:string,
 refresh():void,save(s:YouTubeSettings|null):void,
};

export function useYouTube(initialSettings:YouTubeSettings|null,initialChannel:YouTubeChannel|null):YouTubeState{
 const [settings,setSettings]=useState(initialSettings);
 const [channel,setChannel]=useState(initialChannel);
 const [loading,setLoading]=useState(false);
 const [error,setError]=useState('');
 async function load(s:YouTubeSettings){
  setLoading(true);setError('');
  try{setChannel(await fetchChannel(s));}catch(e){setError(e instanceof Error?e.message:String(e));}
  finally{setLoading(false);}
 }
 return {settings,channel,loading,error,
  refresh:()=>{if(settings)void load(settings);},
  save:s=>{saveSettings(s);setSettings(s);setChannel(null);setError('');if(s)void load(s);},
 };
}

const STALE_MS=60*60*1000;
const date=(iso:string)=>{const d=new Date(iso);return isNaN(d.getTime())?'':d.toLocaleDateString(undefined,{year:'numeric',month:'short',day:'numeric'});};

export function YouTubeScreen({yt,openExtract}:{yt:YouTubeState,openExtract?():void}){
 const [filter,setFilter]=useState('');
 const [editing,setEditing]=useState(false);
 // Refresh on open when the cached list is over an hour old.
 useEffect(()=>{if(yt.settings&&!yt.loading&&(!yt.channel||Date.now()-yt.channel.fetchedAt>STALE_MS))yt.refresh();},[]);
 if(!yt.settings||editing)return <Setup initial={yt.settings} onSave={s=>{yt.save(s);setEditing(false);}} onCancel={yt.settings?()=>setEditing(false):undefined}/>;
 const q=filter.trim().toLowerCase();
 const videos=(yt.channel?.videos??[]).filter(v=>!q||v.title.toLowerCase().includes(q));
 return <>
  <div className="yt-bar">
   <span className="yt-channel">{yt.channel?.title??yt.settings.channel}{yt.channel&&<small> · {yt.channel.videos.length} public {yt.channel.videos.length===1?'video':'videos'}</small>}</span>
   <button className="yt-icon-btn" title="Refresh" aria-label="Refresh video list" disabled={yt.loading} onClick={yt.refresh}><RefreshCw size={18} className={yt.loading?'m-spin':undefined}/></button>
   <button className="yt-link-btn" onClick={()=>setEditing(true)}>Settings</button>
  </div>
  <label className="yt-filter"><Search size={17}/><input type="search" placeholder="Filter your videos" aria-label="Filter your videos" value={filter} onChange={e=>setFilter(e.target.value)}/></label>
  {yt.error&&<div className="m-banner m-error" role="alert">{yt.error}</div>}
  {yt.loading&&!yt.channel&&<p className="m-hint">Loading your videos…</p>}
  {yt.channel&&videos.length===0&&<p className="m-hint">{q?`No videos match “${filter.trim()}”.`:'No public videos on this channel.'}</p>}
  <VideoList videos={videos} openExtract={openExtract}/>
  <p className="yt-note">Only public videos are listed. To get a video's audio: <b>Download from Studio</b> saves the MP4 (you'll be asked to sign in as the channel owner), then <b>Extract Audio</b> turns it into an .m4a.</p>
 </>;
}

export function VideoList({videos,openExtract}:{videos:YouTubeVideo[],openExtract?():void}){
 return <ul className="yt-list">{videos.map(v=><li key={v.id} className="yt-video">
  {v.thumbnail?<img src={v.thumbnail} alt="" loading="lazy" referrerPolicy="no-referrer"/>:<span className="yt-thumb-empty"/>}
  <div className="yt-video-text">
   <b>{v.title}</b><small>{date(v.publishedAt)}</small>
   <div className="yt-actions">
    <a className="yt-action" href={studioUrl(v.id)} target="_blank" rel="noopener noreferrer"><ExternalLink size={14}/>Download from Studio</a>
    {openExtract&&<button className="yt-action" onClick={openExtract}><AudioLines size={14}/>Extract Audio</button>}
   </div>
  </div>
 </li>)}</ul>;
}

function Setup({initial,onSave,onCancel}:{initial:YouTubeSettings|null,onSave(s:YouTubeSettings|null):void,onCancel?():void}){
 const [apiKey,setApiKey]=useState(initial?.apiKey??'');
 const [channel,setChannel]=useState(initial?.channel??'');
 const validChannel=parseChannel(channel)!==null;
 return <form className="yt-setup" onSubmit={e=>{e.preventDefault();if(apiKey.trim()&&validChannel)onSave({apiKey:apiKey.trim(),channel:channel.trim()});}}>
  <p>Connect your channel to see your videos here. This uses YouTube's official API with your own free API key, which stays on this device.</p>
  <ol>
   <li>In Google Cloud, <a href="https://console.cloud.google.com/apis/library/youtube.googleapis.com" target="_blank" rel="noopener noreferrer">enable the YouTube Data API v3</a> (create a project if asked).</li>
   <li>Under <a href="https://console.cloud.google.com/apis/credentials" target="_blank" rel="noopener noreferrer">Credentials</a>, create an API key. Restrict it to the YouTube Data API v3 and to this site's address.</li>
   <li>Paste the key and your channel's @handle below.</li>
  </ol>
  <label>API key<input value={apiKey} onChange={e=>setApiKey(e.target.value)} autoComplete="off" autoCapitalize="off" spellCheck={false} placeholder="AIza…"/></label>
  <label>Channel<input value={channel} onChange={e=>setChannel(e.target.value)} autoComplete="off" autoCapitalize="off" spellCheck={false} placeholder="@yourchannel"/></label>
  {channel.trim()&&!validChannel&&<small className="yt-invalid">Use your @handle, a channel ID (UC…), or your channel's URL.</small>}
  <div className="yt-setup-buttons">
   {initial&&<button type="button" className="yt-link-btn danger" onClick={()=>onSave(null)}>Disconnect</button>}
   {onCancel&&<button type="button" className="yt-link-btn" onClick={onCancel}>Cancel</button>}
   <button type="submit" className="m-primary" disabled={!apiKey.trim()||!validChannel}>Save</button>
  </div>
 </form>;
}
