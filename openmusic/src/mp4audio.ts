// Extracts the audio track of an MP4/MOV/M4V video into an .m4a file without re-encoding: the AAC (or ALAC)
// samples are copied byte for byte and given a new audio-only MP4 container. Only the small `moov` index is
// read into memory; the output Blob references slices of the original file, so large videos are fine on phones.

export type ExtractedAudio={blob:Blob,codec:'AAC'|'ALAC',durationSeconds:number|null,bytes:number};

export class ExtractError extends Error{}

type Box={type:string,start:number,end:number,header:number,children?:Box[]};
// Boxes whose payload is only other boxes, on the path to the sample tables.
const CONTAINERS=new Set(['moov','trak','mdia','minf','stbl','edts','dinf']);
const SUPPORTED:Record<string,ExtractedAudio['codec']>={mp4a:'AAC',alac:'ALAC'};
const U32=2**32;

async function bytes(blob:Blob,start:number,length:number){return new Uint8Array(await blob.slice(start,start+length).arrayBuffer());}
const u16=(b:Uint8Array,o:number)=>(b[o]<<8)+b[o+1];
const u32=(b:Uint8Array,o:number)=>((b[o]<<24)>>>0)+(b[o+1]<<16)+(b[o+2]<<8)+b[o+3];
const u64=(b:Uint8Array,o:number)=>u32(b,o)*U32+u32(b,o+4);
const fourcc=(b:Uint8Array,o:number)=>String.fromCharCode(b[o],b[o+1],b[o+2],b[o+3]);

function parse(b:Uint8Array,start:number,end:number):Box[]{
  const boxes:Box[]=[];
  for(let pos=start;pos+8<=end;){
    let size=u32(b,pos),header=8;
    if(size===1){size=u64(b,pos+8);header=16;}else if(size===0)size=end-pos;
    if(size<header||pos+size>end)throw new ExtractError('The video file is damaged (bad box size).');
    const box:Box={type:fourcc(b,pos+4),start:pos,end:pos+size,header};
    if(CONTAINERS.has(box.type))box.children=parse(b,pos+header,pos+size);
    boxes.push(box);pos+=size;
  }
  return boxes;
}
const child=(box:Box|undefined,...path:string[])=>path.reduce<Box|undefined>((b,t)=>b?.children?.find(c=>c.type===t),box);

/** Finds the top-level `moov` (the index) by reading only box headers. */
async function readMoov(file:Blob):Promise<Uint8Array>{
  for(let pos=0;pos+8<=file.size;){
    const h=await bytes(file,pos,16);
    let size=u32(h,0),header=8;
    if(size===1){size=u64(h,8);header=16;}else if(size===0)size=file.size-pos;
    if(size<header)throw new ExtractError('This isn\'t a video file OpenMusic can read (expected MP4, MOV or M4V).');
    const type=fourcc(h,4);
    if(pos===0&&type!=='ftyp'&&type!=='moov'&&type!=='wide'&&type!=='mdat'&&type!=='free')throw new ExtractError('This isn\'t an MP4, MOV or M4V video.');
    if(type==='moov'){
      if(size>64*1024*1024)throw new ExtractError('The video index is unexpectedly large; the file may be damaged.');
      return bytes(file,pos,size);
    }
    pos+=size;
  }
  throw new ExtractError('The video has no index (moov box); it may be incomplete or damaged.');
}

function box(type:string,...parts:Uint8Array[]){
  const size=8+parts.reduce((n,p)=>n+p.length,0);
  const out=new Uint8Array(size),v=new DataView(out.buffer);
  v.setUint32(0,size);for(let i=0;i<4;i++)out[4+i]=type.charCodeAt(i);
  let o=8;for(const p of parts){out.set(p,o);o+=p.length;}
  return out;
}
function chunkOffsetBox(offsets:number[],wide:boolean){
  const body=new Uint8Array(8+offsets.length*(wide?8:4)),v=new DataView(body.buffer);
  v.setUint32(4,offsets.length);
  offsets.forEach((off,i)=>{if(wide){v.setUint32(8+i*8,Math.floor(off/U32));v.setUint32(12+i*8,off%U32);}else v.setUint32(8+i*4,off);});
  return box(wide?'co64':'stco',body);
}
function fullBox(type:string,body:Uint8Array){return box(type,new Uint8Array(4),body);}

/** A data reference pointing at "this file", as ISO players expect (QuickTime files use `alis` instead). */
function selfDinf(){
  const dref=new Uint8Array(4);new DataView(dref.buffer).setUint32(0,1);
  const url=new Uint8Array(12);new DataView(url.buffer).setUint32(0,12);url.set([0x75,0x72,0x6c,0x20],4);url[11]=1; // 'url ' flags=1: same file
  return box('dinf',fullBox('dref',new Uint8Array([...dref,...url])));
}

/**
 * QuickTime (MOV) writes version 1/2 sound descriptions with the codec config wrapped in a `wave` atom; .m4a players
 * want the plain ISO version 0 entry with the config (`esds` for AAC, `alac` for ALAC) as a direct child.
 * Returns a rebuilt stsd, or null when the entry is already ISO-shaped.
 */
function isoSampleDescription(m:Uint8Array,stsd:Box,format:string):Uint8Array|null{
  const e=stsd.start+stsd.header+8,end=e+u32(m,e+0);
  const version=u16(m,e+16);
  if(version===0)return null;
  let channels:number,bits:number,rate:number,kidsAt:number;
  if(version===1){channels=u16(m,e+24);bits=u16(m,e+26);rate=u32(m,e+32)/65536;kidsAt=e+52;}
  else if(version===2){const v=new DataView(m.buffer,m.byteOffset);rate=v.getFloat64(e+40);channels=u32(m,e+48);bits=u32(m,e+56);kidsAt=e+72;}
  else throw new ExtractError(`Unsupported QuickTime sound description (version ${version}).`);
  const config=format==='mp4a'?'esds':'alac';
  const kids=parse(m,kidsAt,end);
  const wave=kids.find(k=>k.type==='wave');
  const inner=wave?parse(m,wave.start+wave.header,wave.end):[];
  const cfg=kids.find(k=>k.type===config)??inner.find(k=>k.type===config&&k.end-k.start>12);
  if(!cfg)throw new ExtractError('The audio track is missing its codec configuration.');
  const fields=new Uint8Array(28),v=new DataView(fields.buffer);
  fields.set(m.subarray(e+14,e+16),6); // data reference index
  v.setUint16(16,channels);v.setUint16(18,bits||16);
  v.setUint32(24,Math.round(rate)<65536?Math.round(rate)*65536:0); // 16.16 fixed point; 0 when it doesn't fit
  const extras=kids.filter(k=>k.type==='btrt').map(k=>m.subarray(k.start,k.end));
  const entry=box(format,fields,m.subarray(cfg.start,cfg.end),...extras);
  const count=new Uint8Array(4);new DataView(count.buffer).setUint32(0,1);
  return fullBox('stsd',new Uint8Array([...count,...entry]));
}

/** Re-serialises a box, swapping in replacements and re-computing container sizes on the way up. */
function rebuild(b:Uint8Array,node:Box,replace:Map<Box,Uint8Array>):Uint8Array{
  const swapped=replace.get(node);if(swapped)return swapped;
  if(!node.children)return b.subarray(node.start,node.end);
  return box(node.type,...node.children.map(c=>rebuild(b,c,replace)));
}

export async function extractAudio(file:Blob):Promise<ExtractedAudio>{
  const m=await readMoov(file);
  const [moov]=parse(m,0,m.length);
  const traks=moov.children!.filter(c=>c.type==='trak');
  const audio=traks.find(t=>{const h=child(t,'mdia','hdlr');return h&&fourcc(m,h.start+h.header+8)==='soun';});
  if(!audio)throw new ExtractError('This video has no audio track.');
  const stbl=child(audio,'mdia','minf','stbl');
  const stsd=child(stbl,'stsd'),stsc=child(stbl,'stsc'),stsz=child(stbl,'stsz');
  const stco=child(stbl,'stco')??child(stbl,'co64');
  if(!stbl||!stsd||!stsc||!stco)throw new ExtractError('The audio track is missing its sample tables.');
  if(!stsz)throw new ExtractError(child(stbl,'stz2')?'This video uses a compact sample table that isn\'t supported yet.':'The audio track is missing its sample sizes.');

  const format=fourcc(m,stsd.start+stsd.header+12);
  const codec=SUPPORTED[format];
  if(!codec)throw new ExtractError(`The audio in this video is “${format.trim()}”, which can't be saved as M4A without re-encoding. Only AAC and ALAC audio is supported.`);

  // Sample sizes
  const z=stsz.start+stsz.header,uniform=u32(m,z+4),count=u32(m,z+8);
  if(count===0)throw new ExtractError(moov.children!.some(c=>c.type==='mvex')?'This is a streaming (fragmented) MP4, which isn\'t supported yet.':'The audio track is empty.');
  const sizeOf=(i:number)=>uniform||u32(m,z+12+i*4);
  // Chunk offsets in the source
  const c=stco.start+stco.header,chunks=u32(m,c+4),wideIn=stco.type==='co64';
  const srcOffset=(i:number)=>wideIn?u64(m,c+8+i*8):u32(m,c+8+i*4);
  // Samples per chunk: stsc runs of (first_chunk, samples_per_chunk, description)
  const s=stsc.start+stsc.header,runs=u32(m,s+4);
  const perChunk:number[]=[];
  for(let r=0;r<runs;r++){
    const first=u32(m,s+8+r*12)-1,n=u32(m,s+12+r*12),next=r+1<runs?u32(m,s+8+(r+1)*12)-1:chunks;
    for(let k=first;k<next&&k<chunks;k++)perChunk[k]=n;
  }
  // Byte ranges of each chunk's samples in the source file
  const ranges:[number,number][]=[];
  let sample=0;
  for(let k=0;k<chunks;k++){
    let len=0;for(let j=0;j<(perChunk[k]??0)&&sample<count;j++)len+=sizeOf(sample++);
    const off=srcOffset(k);
    if(off+len>file.size)throw new ExtractError('The video file is truncated: audio data is missing from the end.');
    ranges.push([off,len]);
  }
  if(sample<count)throw new ExtractError('The audio track\'s tables are inconsistent; the file may be damaged.');
  const dataSize=ranges.reduce((n,[,len])=>n+len,0);

  // Output: ftyp, moov (mvhd + this track + metadata), mdat. Build moov twice: once to learn its size, once with real offsets.
  const ftyp=box('ftyp',new TextEncoder().encode('M4A \0\0\0\0M4A mp42isom'));
  const keep=moov.children!.filter(b=>b===audio||b.type==='mvhd'||b.type==='udta'||b.type==='meta');
  // Standardise the QuickTime-only parts: sample description, data reference, and the data handler inside minf.
  const minf=child(audio,'mdia','minf')!;
  const fixes=new Map<Box,Uint8Array>();
  const iso=isoSampleDescription(m,stsd,format);if(iso)fixes.set(stsd,iso);
  const dinf=child(minf,'dinf');if(dinf)fixes.set(dinf,selfDinf());
  for(const h of minf.children!.filter(b=>b.type==='hdlr'))fixes.set(h,new Uint8Array(0));
  const moovWith=(offsets:number[],wide:boolean)=>{const r=new Map(fixes);r.set(stco,chunkOffsetBox(offsets,wide));return box('moov',...keep.map(b=>rebuild(m,b,r)));};
  const mdatHeader=8+dataSize>=U32?16:8;
  let wide=false,out=moovWith(ranges.map(()=>0),wide);
  if(ftyp.length+out.length+mdatHeader+dataSize>=U32){wide=true;out=moovWith(ranges.map(()=>0),wide);}
  let pos=ftyp.length+out.length+mdatHeader;
  const offsets=ranges.map(([,len])=>{const o=pos;pos+=len;return o;});
  out=moovWith(offsets,wide);

  const mdat=new Uint8Array(mdatHeader),v=new DataView(mdat.buffer);
  if(mdatHeader===8)v.setUint32(0,8+dataSize);else{v.setUint32(0,1);v.setUint32(8,Math.floor((16+dataSize)/U32));v.setUint32(12,(16+dataSize)%U32);}
  mdat.set([0x6d,0x64,0x61,0x74],4);

  // Duration from the track's media header
  const mdhd=child(audio,'mdia','mdhd');
  let durationSeconds:number|null=null;
  if(mdhd){const o=mdhd.start+mdhd.header,v1=m[o]===1,ts=u32(m,o+(v1?20:12)),d=v1?u64(m,o+24):u32(m,o+16);if(ts)durationSeconds=Math.round(d/ts);}

  const blob=new Blob([ftyp,out,mdat,...ranges.filter(([,len])=>len>0).map(([off,len])=>file.slice(off,off+len))],{type:'audio/mp4'});
  return {blob,codec,durationSeconds,bytes:blob.size};
}
