// Converts the audio of any video/audio file the user chooses to MP3, on the device, with ffmpeg compiled to
// WebAssembly. The core is OpenMusic's own LGPL, audio-only build (scripts/ffmpeg/build-lgpl.sh), served from
// /ffmpeg/<version>/ and downloaded only the first time it is needed. The MIT @ffmpeg/ffmpeg loader runs it in
// a worker; nothing is uploaded.
import {FFmpeg, FFFSType} from '@ffmpeg/ffmpeg';

/** Bump the folder name whenever the core is rebuilt, so cached copies are replaced. */
export const FFMPEG_BASE='/ffmpeg/0.12.10-lgpl-1';
const IN_DIR='/in';

export type Mp3Options={bitrate:128|192|256|320,onStage?(stage:'loading'|'converting'):void,onProgress?(ratio:number):void};
export type Mp3Result={blob:Blob,durationSeconds:number|null};

let loaded:Promise<FFmpeg>|null=null;
function load(onStage?:Mp3Options['onStage']){
  if(!loaded){
    onStage?.('loading');
    const ff=new FFmpeg();
    loaded=ff.load({coreURL:`${FFMPEG_BASE}/esm/ffmpeg-core.js`,wasmURL:`${FFMPEG_BASE}/esm/ffmpeg-core.wasm`}).then(()=>ff)
      .catch(e=>{loaded=null;throw new Error(`Couldn't load the audio converter (${e instanceof Error?e.message:e}). Check your connection and try again.`);});
  }
  return loaded;
}

/** Turns ffmpeg's log into a message a person can act on. */
function explain(log:string):string{
  if(/matches no streams|does not contain any stream|Output file #0 does not contain/.test(log))return 'This file has no audio track.';
  if(/Invalid data found when processing input|could not find codec parameters|moov atom not found/i.test(log))return 'This file is damaged or isn\'t a format the converter can read.';
  const dec=/Decoder \(codec ([\w-]+)\) not found/.exec(log);
  if(dec)return `The audio uses “${dec[1]}”, which this converter doesn't include.`;
  return 'The conversion failed. The file may be damaged or in an unsupported format.';
}

export async function convertToMp3(file:File,opts:Mp3Options):Promise<Mp3Result>{
  const ff=await load(opts.onStage);
  opts.onStage?.('converting');
  const lines:string[]=[];
  const onLog=({message}:{message:string})=>{lines.push(message);if(lines.length>400)lines.shift();};
  const onProgress=({progress}:{progress:number})=>{if(progress>=0&&progress<=1)opts.onProgress?.(progress);};
  ff.on('log',onLog);ff.on('progress',onProgress);
  const out='out.mp3';
  try{
    // WORKERFS reads the chosen file in place instead of copying it into WebAssembly memory: big videos are fine.
    await ff.createDir(IN_DIR).catch(()=>{});
    await ff.mount(FFFSType.WORKERFS,{files:[file]},IN_DIR);
    const code=await ff.exec(['-hide_banner','-i',`${IN_DIR}/${file.name}`,'-vn','-map','0:a:0','-c:a','libmp3lame','-b:a',`${opts.bitrate}k`,'-id3v2_version','3','-y',out]);
    if(code!==0)throw new Error(explain(lines.join('\n')));
    const data=new Uint8Array(await ff.readFile(out) as Uint8Array); // copy into a plain ArrayBuffer for Blob
    const d=/Duration: (\d+):(\d+):(\d+(?:\.\d+)?)/.exec(lines.join('\n'));
    return {blob:new Blob([data],{type:'audio/mpeg'}),durationSeconds:d?Math.round(+d[1]*3600+ +d[2]*60+ +d[3]):null};
  }finally{
    ff.off('log',onLog);ff.off('progress',onProgress);
    await ff.deleteFile(out).catch(()=>{});
    await ff.unmount(IN_DIR).catch(()=>{});
  }
}
