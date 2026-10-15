// Browser port of crates/openmusic-core/src/lyrics.rs, used by webBackend.ts. Keep the two in step.

export type LyricLine={time_ms:number|null,text:string};
export type Lyrics={text:string,synced:boolean,lines:LyricLine[],source:'saved'|'file'};

export const MAX_LYRICS_BYTES=256*1024;

export function makeLyrics(text:string,source:Lyrics['source']):Lyrics{
  const timed=parseLrc(text);
  if(timed)return {text,synced:true,lines:timed,source};
  return {text,synced:false,lines:text.trim().split(/\r?\n/).map(l=>({time_ms:null,text:l.trim()})),source};
}

/** Parses LRC (`[01:02.50]words`, several timestamps per line, `[offset:±ms]`). Null when there are no timestamps. */
export function parseLrc(text:string):LyricLine[]|null{
  let offset=0;
  const timed:[number,string][]=[];
  for(const raw of text.split(/\r?\n/)){
    let rest=raw.trim();
    const times:number[]=[];
    // Leading timestamps; a non-time bracket after them (e.g. "[Chorus]") stays part of the text.
    for(let m;(m=/^\[([^\]]*)\]/.exec(rest));){
      const t=parseTimestamp(m[1]);
      if(t===null)break;
      times.push(t);rest=rest.slice(m[0].length).trimStart();
    }
    if(!times.length){
      const o=/^\[offset:([^\]]*)\]$/.exec(rest);
      if(o){const v=Number(o[1].trim());offset=Number.isInteger(v)?v:0;}
      continue;
    }
    for(const t of times)timed.push([t,rest.trimEnd()]);
  }
  if(!timed.length)return null;
  timed.sort((a,b)=>a[0]-b[0]);
  return timed.map(([t,text])=>({time_ms:Math.max(0,t-offset),text}));
}

function parseTimestamp(tag:string):number|null{
  const m=/^(\d+):(\d{1,2})(?:[.:](\d{1,3}))?$/.exec(tag);
  if(!m)return null;
  const seconds=Number(m[2]);
  if(seconds>=60)return null;
  const frac=m[3]?Number(m[3])*10**(3-m[3].length):0;
  return Number(m[1])*60_000+seconds*1000+frac;
}
