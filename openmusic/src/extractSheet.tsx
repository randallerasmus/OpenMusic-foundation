import React, {useRef, useState} from 'react';
import type {ExtractedAudio, ImportResult} from './backend';
import {Check, Download, FileVideo, ListPlus, X} from 'lucide-react';

type Props={extract(video:File):Promise<ExtractedAudio>,add(file:File):Promise<ImportResult>,onClose():void};
type State={step:'pick'}|{step:'working',name:string}|{step:'done',file:File,result:ExtractedAudio,added:boolean}|{step:'error',message:string};

const VIDEO_TYPES='video/mp4,video/quicktime,video/x-m4v,.mp4,.mov,.m4v';
const mb=(n:number)=>`${(n/1024/1024).toFixed(n<10*1024*1024?1:0)} MB`;
const clock=(s:number|null)=>s==null?'unknown length':`${Math.floor(s/60)}:${String(s%60).padStart(2,'0')}`;

/** Bottom sheet: choose a video you own, copy its audio into an .m4a, then add it to the library and/or save the file. */
export function ExtractSheet({extract,add,onClose}:Props){
 const [state,setState]=useState<State>({step:'pick'});
 const input=useRef<HTMLInputElement>(null);
 async function choose(video:File|undefined){
  if(!video)return;
  setState({step:'working',name:video.name});
  try{
   const result=await extract(video);
   const name=(video.name.replace(/\.[^.]+$/,'')||'Extracted audio')+'.m4a';
   setState({step:'done',file:new File([result.blob],name,{type:'audio/mp4',lastModified:video.lastModified}),result,added:false});
  }catch(e){setState({step:'error',message:e instanceof Error?e.message:String(e)});}
 }
 async function addToLibrary(s:Extract<State,{step:'done'}>){
  try{await add(s.file);setState({...s,added:true});}
  catch(e){setState({step:'error',message:e instanceof Error?e.message:String(e)});}
 }
 return <div className="m-sheet-backdrop" onClick={onClose}>
  <div className="m-glass m-action-sheet m-extract" role="dialog" aria-modal="true" aria-labelledby="extract-title" onClick={e=>e.stopPropagation()}>
   <header><h2 id="extract-title">Extract Audio</h2><button className="m-extract-close" aria-label="Close" onClick={onClose}><X size={18}/></button></header>
   <input ref={input} type="file" accept={VIDEO_TYPES} hidden onChange={e=>{void choose(e.target.files?.[0]);e.target.value='';}}/>
   {state.step==='pick'&&<>
    <p>Choose a video you own, such as one downloaded from <b>YouTube Studio</b> (Content → ⋮ → Download). Its audio is copied into an <b>.m4a</b> file without re-encoding, so the quality is identical. Nothing is uploaded.</p>
    <button className="m-primary m-extract-main" onClick={()=>input.current?.click()}><FileVideo size={19}/>Choose Video</button>
    <small className="m-extract-hint">MP4, MOV or M4V with AAC or ALAC audio.</small>
   </>}
   {state.step==='working'&&<div className="m-extract-working" role="status"><span className="m-spinner" aria-hidden="true"/>Extracting audio from “{state.name}”…</div>}
   {state.step==='done'&&<>
    <div className="m-extract-result"><span className="m-art m-art-xs"><Check size={18}/></span>
     <span className="m-track-text"><b>{state.file.name}</b><small>{state.result.codec} · {clock(state.result.durationSeconds)} · {mb(state.result.bytes)}</small></span></div>
    <button className="m-action" disabled={state.added} onClick={()=>void addToLibrary(state)}><span>{state.added?'Added to Library':'Add to Library'}</span>{state.added?<Check/>:<ListPlus/>}</button>
    <button className="m-action" onClick={()=>void saveFile(state.file)}><span>Save .m4a File</span><Download/></button>
    <button className="m-action m-action-cancel" onClick={()=>setState({step:'pick'})}>Extract Another</button>
   </>}
   {state.step==='error'&&<>
    <p className="m-extract-error" role="alert">{state.message}</p>
    <button className="m-primary m-extract-main" onClick={()=>input.current?.click()}><FileVideo size={19}/>Choose Another Video</button>
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
