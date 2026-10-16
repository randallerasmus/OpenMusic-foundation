import React, {useRef, useState} from 'react';
import type {ExtractedAudio, ImportResult} from './backend';
import {Check, Download, FileVideo, ListPlus, X} from 'lucide-react';

type Props={extract(video:File):Promise<ExtractedAudio>,add(file:File):Promise<ImportResult>,onClose():void};
type Format='mp3'|'m4a';
type Bitrate=128|192|256|320;
type Done={step:'done',file:File,label:string,durationSeconds:number|null,added:boolean};
type State={step:'pick'}|{step:'working',name:string,stage:'copying'|'loading'|'converting',progress:number|null}|Done
 |{step:'error',message:string,retryAsMp3?:File};

// MP3 goes through ffmpeg, which reads almost anything; M4A is a byte-exact copy of AAC/ALAC from MP4-family files.
const ACCEPT:Record<Format,string>={
 mp3:'video/*,audio/*,.mp4,.mov,.m4v,.mkv,.webm,.avi,.wmv,.flv,.3gp,.ts,.mts,.m4a,.aac,.wav,.flac,.ogg,.opus,.wma,.mp3',
 m4a:'video/mp4,video/quicktime,video/x-m4v,.mp4,.mov,.m4v',
};
const mb=(n:number)=>`${(n/1024/1024).toFixed(n<10*1024*1024?1:0)} MB`;
const clock=(s:number|null)=>s==null?'unknown length':`${Math.floor(s/60)}:${String(s%60).padStart(2,'0')}`;
const base=(name:string)=>name.replace(/\.[^.]+$/,'')||'Extracted audio';

/** Bottom sheet: choose a video or audio file you own and get its audio as MP3 (ffmpeg) or M4A (exact copy). */
export function ExtractSheet({extract,add,onClose}:Props){
 const [state,setState]=useState<State>({step:'pick'});
 const [format,setFormat]=useState<Format>('mp3');
 const [bitrate,setBitrate]=useState<Bitrate>(192);
 const input=useRef<HTMLInputElement>(null);
 const fail=(e:unknown)=>e instanceof Error?e.message:String(e);

 async function toMp3(file:File){
  setState({step:'working',name:file.name,stage:'converting',progress:null});
  try{
   // Loaded on demand so the converter's code is only fetched by people who use it.
   const {convertToMp3}=await import('./ffmpegAudio');
   const r=await convertToMp3(file,{bitrate,
    onStage:stage=>setState(s=>s.step==='working'?{...s,stage,progress:null}:s),
    onProgress:p=>setState(s=>s.step==='working'?{...s,stage:'converting',progress:p}:s)});
   setState({step:'done',file:new File([r.blob],base(file.name)+'.mp3',{type:'audio/mpeg',lastModified:file.lastModified}),label:`MP3 ${bitrate} kbps`,durationSeconds:r.durationSeconds,added:false});
  }catch(e){setState({step:'error',message:fail(e)});}
 }
 async function toM4a(file:File){
  setState({step:'working',name:file.name,stage:'copying',progress:null});
  try{
   const r=await extract(file);
   setState({step:'done',file:new File([r.blob],base(file.name)+'.m4a',{type:'audio/mp4',lastModified:file.lastModified}),label:r.codec,durationSeconds:r.durationSeconds,added:false});
  }catch(e){setState({step:'error',message:fail(e),retryAsMp3:file});}
 }
 const choose=(file:File|undefined)=>{if(file)void(format==='mp3'?toMp3(file):toM4a(file));};
 async function addToLibrary(s:Done){
  try{await add(s.file);setState({...s,added:true});}
  catch(e){setState({step:'error',message:fail(e)});}
 }
 const working=state.step==='working'?state:null;

 return <div className="m-sheet-backdrop" onClick={working?undefined:onClose}>
  <div className="m-glass m-action-sheet m-extract" role="dialog" aria-modal="true" aria-labelledby="extract-title" onClick={e=>e.stopPropagation()}>
   <header><h2 id="extract-title">Extract Audio</h2>{!working&&<button className="m-extract-close" aria-label="Close" onClick={onClose}><X size={18}/></button>}</header>
   <input ref={input} type="file" accept={ACCEPT[format]} hidden onChange={e=>{choose(e.target.files?.[0]);e.target.value='';}}/>
   {state.step==='pick'&&<>
    <div className="m-seg" role="radiogroup" aria-label="Format">
     <button role="radio" aria-checked={format==='mp3'} className={format==='mp3'?'on':''} onClick={()=>setFormat('mp3')}>MP3<small>any video or audio</small></button>
     <button role="radio" aria-checked={format==='m4a'} className={format==='m4a'?'on':''} onClick={()=>setFormat('m4a')}>M4A<small>exact copy, instant</small></button>
    </div>
    {format==='mp3'
     ?<><p>Choose a video or audio file you own, such as one downloaded from <b>YouTube Studio</b>. ffmpeg converts its audio to MP3 on this device. Nothing is uploaded.</p>
       <label className="m-bitrate">Quality<select value={bitrate} onChange={e=>setBitrate(Number(e.target.value) as Bitrate)}>
        <option value={128}>128 kbps (smaller)</option><option value={192}>192 kbps (recommended)</option><option value={256}>256 kbps</option><option value={320}>320 kbps (best)</option></select></label></>
     :<p>Copies the audio of an MP4, MOV or M4V into an <b>.m4a</b> without re-encoding, so the quality is identical. Works when the audio is AAC or ALAC.</p>}
    <button className="m-primary m-extract-main" onClick={()=>input.current?.click()}><FileVideo size={19}/>Choose File</button>
    {format==='mp3'&&<small className="m-extract-hint">The first conversion downloads the converter (about 7 MB, once).</small>}
   </>}
   {working&&<div className="m-extract-working" role="status">
    <span className="m-spinner" aria-hidden="true"/>
    <span className="m-extract-stage">
     {working.stage==='copying'?<>Extracting audio from “{working.name}”…</>
      :working.stage==='loading'?<>Downloading the audio converter (first time only)…</>
      :<>Converting “{working.name}” to MP3{working.progress!=null?` · ${Math.round(working.progress*100)}%`:'…'}</>}
     {working.stage==='converting'&&<span className="m-progress"><span style={{width:`${Math.round((working.progress??0)*100)}%`}}/></span>}
    </span>
   </div>}
   {state.step==='done'&&<>
    <div className="m-extract-result"><span className="m-art m-art-xs"><Check size={18}/></span>
     <span className="m-track-text"><b>{state.file.name}</b><small>{state.label} · {clock(state.durationSeconds)} · {mb(state.file.size)}</small></span></div>
    <button className="m-action" disabled={state.added} onClick={()=>void addToLibrary(state)}><span>{state.added?'Added to Library':'Add to Library'}</span>{state.added?<Check/>:<ListPlus/>}</button>
    <button className="m-action" onClick={()=>void saveFile(state.file)}><span>Save {state.file.name.endsWith('.mp3')?'.mp3':'.m4a'} File</span><Download/></button>
    <button className="m-action m-action-cancel" onClick={()=>setState({step:'pick'})}>Extract Another</button>
   </>}
   {state.step==='error'&&<>
    <p className="m-extract-error" role="alert">{state.message}</p>
    {state.retryAsMp3&&<button className="m-primary m-extract-main" onClick={()=>{const f=state.retryAsMp3!;setFormat('mp3');void toMp3(f);}}>Convert to MP3 Instead</button>}
    <button className={state.retryAsMp3?'m-action m-action-cancel':'m-primary m-extract-main'} onClick={()=>setState({step:'pick'})}><FileVideo size={19}/>Choose Another File</button>
   </>}
  </div>
 </div>;
}

/** Phones get the share sheet (Save to Files, AirDrop…); elsewhere the file downloads. */
async function saveFile(file:File){
 const touch=matchMedia('(pointer:coarse)').matches;
 if(touch&&navigator.canShare?.({files:[file]})){
  try{await navigator.share({files:[file],title:file.name});return;}
  catch(e){if(e instanceof DOMException&&e.name==='AbortError')return;}
 }
 const url=URL.createObjectURL(file);
 const a=document.createElement('a');a.href=url;a.download=file.name;document.body.append(a);a.click();a.remove();
 setTimeout(()=>URL.revokeObjectURL(url),60_000);
}
