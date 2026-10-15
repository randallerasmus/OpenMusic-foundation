// Browser port of crates/openmusic-core/src/lrclib.rs (LRCLIB lyrics lookup). Keep the two in step.
// LRCLIB lyrics are community-contributed and not publisher-licensed; using it is a recorded owner decision
// (AGENTS.md rule 11). Only the song's title/artist are sent, and only when lyrics are looked up.
import type {Track} from './backend';

export type LrclibCandidate={id:number,track:string,artist:string,album:string,duration_seconds:number|null,synced:boolean,lyrics:string,score:number};
export type LrclibLookup={candidates:LrclibCandidate[],confident:boolean,query:string};
type ApiRecord={id:number,trackName?:string,artistName?:string,albumName?:string,duration?:number|null,instrumental?:boolean,plainLyrics?:string|null,syncedLyrics?:string|null};

const API='https://lrclib.net/api/search';
const UNKNOWN_ARTIST='Unknown Artist';
const JUNK=new Set(['official','video','audio','lyric','lyrics','visualizer','visualiser','hd','4k']);

export function cleanTitle(raw:string):string{
  let s=raw.replace(/_/g,' ').trim();
  // A leading track number: "01 Song", "01 - Song", "3. Song", "3) Song". A bare "7 Rings" or "1999" is left alone.
  const digits=/^\d*/.exec(s)![0].length,after=s[digits];
  const numbered=digits>0&&digits<=3&&(after==='.'||after===')'||after==='-'||(after===' '&&(digits===2||s.slice(digits).trimStart().startsWith('-'))));
  if(numbered){const rest=s.slice(digits).replace(/^[ .\-)]+/,'');if(rest)s=rest;}
  // Bracketed tags like "(Official Video)", "[Lyrics]", "(HD)"; musical ones like "(Live)" stay.
  s=s.replace(/[([]([^)\]]*)[)\]]/g,(whole,inner:string)=>inner.toLowerCase().split(/[^\p{L}\p{N}]+/u).some(w=>JUNK.has(w))?'':whole);
  return s.split(/\s+/).filter(Boolean).join(' ');
}

function norm(s:string):string{
  const out=s.replace(/[([][^)\]]*[)\]]/g,'').toLowerCase().replace(/[^\p{L}\p{N}]/gu,'');
  return out.endsWith('live')&&out.length>4?out.slice(0,-4):out;
}

export function queries(track:Track,userQuery?:string|null):Record<string,string>[]{
  const q=userQuery?.trim();
  if(q)return [{q}];
  const title=cleanTitle(track.title),artist=track.artist.trim();
  if(!artist||artist===UNKNOWN_ARTIST)return [{q:title}];
  return [{track_name:title,artist_name:artist},{q:`${title} ${artist}`}];
}

export function rank(track:Track,duration:number|null,records:ApiRecord[]):{candidates:LrclibCandidate[],confident:boolean}{
  const want=norm(cleanTitle(track.title));
  const artist=track.artist!==UNKNOWN_ARTIST&&norm(track.artist)?norm(track.artist):null;
  const scored=records.flatMap(r=>{
    const synced=!!r.syncedLyrics?.trim();
    const lyrics=synced?r.syncedLyrics!:r.plainLyrics?.trim()?r.plainLyrics!:null;
    if(!lyrics||r.instrumental)return [];
    const title=norm(r.trackName??'');
    const titleScore=want&&title===want?4:want&&title&&(title.includes(want)||want.includes(title))?2:0;
    const b=norm(r.artistName??'');
    const artistHit=!!artist&&!!b&&(b.includes(artist)||artist.includes(b));
    const diff=duration!=null&&r.duration!=null?Math.abs(duration-r.duration):null;
    const durationScore=diff==null?0:diff<=2?4:diff<=5?2:diff>20?-4:0;
    const score=titleScore+(artistHit?3:0)+durationScore+(synced?1:0);
    return [{c:{id:r.id,track:r.trackName??'',artist:r.artistName??'',album:r.albumName??'',duration_seconds:r.duration??null,synced,lyrics,score},titleOk:titleScore>0&&(artistHit||diff!=null),diff}];
  }).sort((a,b)=>b.c.score-a.c.score);
  const top=scored[0];
  const confident=!!top&&top.titleOk&&(top.diff!=null?top.diff<=5:duration==null&&!!artist);
  return {candidates:scored.slice(0,20).map(x=>x.c),confident};
}

export async function lookup(track:Track,userQuery:string|null,duration:number|null):Promise<LrclibLookup>{
  let query='';
  for(const params of queries(track,userQuery)){
    query=Object.values(params).join(' ');
    const url=new URL(API);for(const [k,v] of Object.entries(params))url.searchParams.set(k,v);
    let res!:Response;
    // A plain GET: custom headers would need a CORS preflight. Browsers send their own User-Agent.
    // LRCLIB occasionally answers 5xx under load; one retry after a short pause usually succeeds.
    for(let attempt=0;attempt<2;attempt++){
      try{res=await fetch(url);}catch{throw new Error('Couldn\'t reach LRCLIB. Check your internet connection.');}
      if(res.status<500)break;
      if(attempt===0)await new Promise(r=>setTimeout(r,1200));
    }
    if(res.status===429)throw new Error('LRCLIB is busy right now; try again in a minute.');
    if(!res.ok)throw new Error(`LRCLIB returned an error (${res.status}).`);
    const records=await res.json() as ApiRecord[];
    if(records.length)return {...rank(track,duration,records),query};
  }
  return {candidates:[],confident:false,query};
}
