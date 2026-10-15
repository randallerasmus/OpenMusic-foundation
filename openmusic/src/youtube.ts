// Lists the user's own YouTube uploads through the official YouTube Data API v3, using their own API key.
// Read-only metadata (titles, dates, thumbnails); no media is downloaded. Getting a video file is done by the
// channel owner in YouTube Studio, which this module only links to.
//
// Quota (10,000 units/day free): channels.list and playlistItems.list cost 1 unit, so listing your uploads is cheap
// and filtered locally. Searching all of YouTube uses search.list at 100 units a call (~100 searches a day), so
// it only runs when the user submits a search, and results are cached for the session.
// Results from search are only ever played in YouTube's own embedded player, as the API terms require.

export type YouTubeSettings={apiKey:string,channel:string};
export type YouTubeVideo={id:string,title:string,publishedAt:string,thumbnail:string|null};
export type YouTubeChannel={id:string,title:string,videos:YouTubeVideo[],fetchedAt:number};

const SETTINGS_KEY='openmusic.youtube.settings';
const CACHE_KEY='openmusic.youtube.channel';
const API='https://www.googleapis.com/youtube/v3';
/** Upper bound on uploads listed (10 calls), to keep quota use and wait time small. */
const MAX_VIDEOS=500;

// Per-device storage: the key is the user's own and never leaves this browser except in calls to Google.
function load<T>(key:string):T|null{try{return JSON.parse(localStorage.getItem(key)??'null') as T|null;}catch{return null;}}
function store(key:string,value:unknown){try{if(value===null)localStorage.removeItem(key);else localStorage.setItem(key,JSON.stringify(value));}catch{/* storage unavailable */}}

export const getSettings=()=>load<YouTubeSettings>(SETTINGS_KEY);
export const getCachedChannel=()=>load<YouTubeChannel>(CACHE_KEY);
export function saveSettings(s:YouTubeSettings|null){store(SETTINGS_KEY,s);store(CACHE_KEY,null);}

export const studioUrl=(id:string)=>`https://studio.youtube.com/video/${encodeURIComponent(id)}/edit`;
export const watchUrl=(id:string)=>`https://www.youtube.com/watch?v=${encodeURIComponent(id)}`;

type ApiError={error?:{code?:number,message?:string,errors?:{reason?:string}[]}};

async function call<T>(path:string,params:Record<string,string>,key:string):Promise<T>{
  const url=new URL(`${API}/${path}`);
  for(const [k,v] of Object.entries({...params,key}))url.searchParams.set(k,v);
  let res:Response;
  try{res=await fetch(url,{headers:{Accept:'application/json'}});}
  catch{throw new Error('Couldn\'t reach YouTube. Check your internet connection.');}
  const body=await res.json().catch(()=>({})) as T&ApiError;
  if(!res.ok||body.error){
    const reason=body.error?.errors?.[0]?.reason??'';
    if(reason==='keyInvalid'||/API key not valid/i.test(body.error?.message??''))throw new Error('YouTube rejected the API key. Check it was copied correctly.');
    if(reason==='accessNotConfigured'||/has not been used|is disabled/i.test(body.error?.message??''))throw new Error('The YouTube Data API v3 isn\'t enabled for this key\'s Google Cloud project yet. Enable it, wait a minute, then try again.');
    if(reason==='quotaExceeded'||reason==='dailyLimitExceeded')throw new Error('This API key has used its YouTube quota for today. It resets at midnight Pacific time.');
    if(reason==='ipRefererBlocked'||reason==='forbidden')throw new Error('The API key\'s restrictions block this site. Allow this site\'s address in the key\'s settings in Google Cloud.');
    throw new Error(`YouTube error ${res.status}: ${body.error?.message??res.statusText}`);
  }
  return body;
}

type ChannelsResponse={items?:{id:string,snippet?:{title?:string},contentDetails?:{relatedPlaylists?:{uploads?:string}}}[]};
type PlaylistItemsResponse={nextPageToken?:string,items?:{snippet?:{title?:string,publishedAt?:string,thumbnails?:Record<string,{url?:string}>,resourceId?:{videoId?:string}},contentDetails?:{videoId?:string,videoPublishedAt?:string}}[]};

/** Accepts @handle, a channel ID (UC…), or a channel URL containing either. */
export function parseChannel(input:string):{handle:string}|{id:string}|null{
  const s=input.trim();
  const id=/(?:^|\/channel\/)(UC[\w-]{22})(?:[/?#]|$)/.exec(s);if(id)return {id:id[1]};
  const handle=/(?:^|youtube\.com\/)(@[\w.-]{3,30})(?:[/?#]|$)/.exec(s);if(handle)return {handle:handle[1]};
  return null;
}

/** Fetches the channel's public uploads, newest first, and caches them on this device. */
export async function fetchChannel(settings:YouTubeSettings):Promise<YouTubeChannel>{
  const which=parseChannel(settings.channel);
  if(!which)throw new Error('Enter your channel as @handle (e.g. @yourname) or a channel ID starting with UC.');
  const channels=await call<ChannelsResponse>('channels',{part:'snippet,contentDetails',...('id' in which?{id:which.id}:{forHandle:which.handle})},settings.apiKey);
  const ch=channels.items?.[0];
  const uploads=ch?.contentDetails?.relatedPlaylists?.uploads;
  if(!ch||!uploads)throw new Error(`No YouTube channel found for ${'id' in which?which.id:which.handle}.`);
  const videos:YouTubeVideo[]=[];
  let pageToken='';
  do{
    const page=await call<PlaylistItemsResponse>('playlistItems',{part:'snippet,contentDetails',playlistId:uploads,maxResults:'50',...(pageToken?{pageToken}:{})},settings.apiKey);
    for(const item of page.items??[]){
      const id=item.contentDetails?.videoId??item.snippet?.resourceId?.videoId;
      const title=item.snippet?.title??'';
      // An API key only sees public videos; private and deleted ones come back as placeholders.
      if(!id||title==='Private video'||title==='Deleted video')continue;
      const t=item.snippet?.thumbnails;
      videos.push({id,title,publishedAt:item.contentDetails?.videoPublishedAt??item.snippet?.publishedAt??'',thumbnail:t?.medium?.url??t?.default?.url??null});
    }
    pageToken=page.nextPageToken??'';
  }while(pageToken&&videos.length<MAX_VIDEOS);
  videos.sort((a,b)=>b.publishedAt.localeCompare(a.publishedAt));
  const channel={id:ch.id,title:ch.snippet?.title??settings.channel,videos,fetchedAt:Date.now()};
  store(CACHE_KEY,channel);
  return channel;
}

export type YouTubeResult={id:string,title:string,channel:string,publishedAt:string,thumbnail:string|null};
type SearchResponse={items?:{id?:{videoId?:string},snippet?:{title?:string,channelTitle?:string,publishedAt?:string,thumbnails?:Record<string,{url?:string}>}}[]};

// The API returns titles HTML-escaped ("Rock &amp; Roll", "Don&#39;t").
function unescapeHtml(s:string){return new DOMParser().parseFromString(s,'text/html').documentElement.textContent??s;}

const searched=new Map<string,YouTubeResult[]>();
/** Searches all of YouTube for videos (100 quota units per uncached query). */
export async function searchYouTube(settings:YouTubeSettings,query:string):Promise<YouTubeResult[]>{
  const key=query.trim().toLowerCase();
  const hit=searched.get(key);if(hit)return hit;
  const body=await call<SearchResponse>('search',{part:'snippet',type:'video',q:query.trim(),maxResults:'15',safeSearch:'moderate'},settings.apiKey);
  const results=(body.items??[]).flatMap(item=>{
    const id=item.id?.videoId;if(!id)return [];
    const t=item.snippet?.thumbnails;
    return [{id,title:unescapeHtml(item.snippet?.title??''),channel:unescapeHtml(item.snippet?.channelTitle??''),publishedAt:item.snippet?.publishedAt??'',thumbnail:t?.medium?.url??t?.default?.url??null}];
  });
  searched.set(key,results);
  return results;
}

/** Privacy-enhanced embed (no cookies until the viewer plays). Plays inline on iPhone. */
export const embedUrl=(id:string)=>`https://www.youtube-nocookie.com/embed/${encodeURIComponent(id)}?autoplay=1&playsinline=1&rel=0`;
