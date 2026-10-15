// Browser port of crates/openmusic-core/src/queue.rs, used by webBackend.ts. Keep the two in step:
// same operations, same edge cases (repeat-one still skips on Next, shuffle keeps the current track first,
// the current slot cannot be removed).
import type {Track} from './backend';

export type RepeatMode='off'|'all'|'one';
export type QueueItem={entry:number,track:Track};
export type QueueView={items:QueueItem[],index:number|null,repeat:RepeatMode,shuffle:boolean,source:string|null,revision:number};
export type SavedQueue={items:number[],unshuffled:number[],index:number|null,repeat:RepeatMode,shuffle:boolean,source:string|null};

export class Queue{
  private items:QueueItem[]=[];
  private unshuffled:QueueItem[]=[];
  index:number|null=null;
  repeat:RepeatMode='off';
  shuffle=false;
  private source:string|null=null;
  private nextEntry=1;
  /** Bumped whenever the current slot changes. */
  cursor=0;
  /** Bumped on every change. */
  revision=0;

  get length(){return this.items.length;}
  current():Track|null{return this.index===null?null:this.items[this.index]?.track??null;}
  view():QueueView{return {items:this.items.map(i=>({...i})),index:this.index,repeat:this.repeat,shuffle:this.shuffle,source:this.source,revision:this.revision};}

  replace(tracks:Track[],start:number,source:string|null):Track|null{
    const items=tracks.map(t=>this.item(t));
    this.unshuffled=[...items];this.items=items;this.source=source;
    this.index=items.length?Math.min(start,items.length-1):null;
    if(this.shuffle)this.shuffleUpcoming();
    return this.moved();
  }
  peekNext():Track|null{
    const next=this.index===null?0:this.index+1;
    if(next<this.items.length)return this.items[next].track;
    return this.repeat!=='off'?this.items[0]?.track??null:null;
  }
  next():Track|null{
    const next=this.index===null?0:this.index+1;
    if(next<this.items.length)this.index=next;
    else if(this.repeat!=='off'&&this.items.length)this.index=0;
    else return null;
    return this.moved();
  }
  onTrackEnd():Track|null{
    if(this.repeat==='one'&&this.index!==null)return this.moved();
    return this.next();
  }
  previous():Track|null{
    if(this.index!==null&&this.index>0)this.index--;
    else if(this.index!==null&&this.repeat==='all')this.index=this.items.length-1;
    else return null;
    return this.moved();
  }
  jump(index:number):Track|null{
    if(index<0||index>=this.items.length)return null;
    this.index=index;return this.moved();
  }
  add(tracks:Track[],playNext:boolean){
    const items=tracks.map(t=>this.item(t));
    const at=playNext?(this.index===null?0:this.index+1):this.items.length;
    this.items.splice(at,0,...items);
    if(this.shuffle){
      const cur=this.currentEntry();
      const pos=cur===null?-1:this.unshuffled.findIndex(x=>x.entry===cur);
      this.unshuffled.splice(playNext?pos+1:this.unshuffled.length,0,...items);
    }else this.unshuffled=[...this.items];
    this.revision++;
  }
  remove(index:number){
    if(index<0||index>=this.items.length)throw new Error(`Invalid request: Queue has no item at index ${index}`);
    if(index===this.index)throw new Error('Invalid request: The current track cannot be removed from the queue');
    const [{entry}]=this.items.splice(index,1);
    this.unshuffled=this.unshuffled.filter(x=>x.entry!==entry);
    if(this.index!==null&&index<this.index)this.index--;
    this.revision++;
  }
  move(from:number,to:number){
    const len=this.items.length;
    if(from<0||to<0||from>=len||to>=len)throw new Error(`Invalid request: Queue indices must be below ${len}`);
    const cur=this.currentEntry();
    const [item]=this.items.splice(from,1);this.items.splice(to,0,item);
    this.index=this.positionOf(cur);
    if(!this.shuffle)this.unshuffled=[...this.items];
    this.revision++;
  }
  clear(){
    const cur=this.index===null?undefined:this.items[this.index];
    this.items=cur?[cur]:[];this.unshuffled=[...this.items];this.index=cur?0:null;
    this.revision++;
  }
  setRepeat(mode:RepeatMode){this.repeat=mode;this.revision++;}
  setShuffle(enabled:boolean){
    if(enabled===this.shuffle)return;
    this.shuffle=enabled;
    if(enabled){this.unshuffled=[...this.items];this.shuffleUpcoming();}
    else{const cur=this.currentEntry();this.items=[...this.unshuffled];this.index=this.positionOf(cur)??(this.items.length?0:null);}
    this.revision++;
  }
  refreshTrack(track:Track){
    let hit=false;
    for(const item of [...this.items,...this.unshuffled])if(item.track.id===track.id){item.track=track;hit=true;}
    if(hit)this.revision++;
  }
  saved():SavedQueue{
    return {items:this.items.map(x=>x.track.id),unshuffled:this.unshuffled.map(x=>x.track.id),index:this.index,repeat:this.repeat,shuffle:this.shuffle,source:this.source};
  }
  restore(saved:SavedQueue,lookup:(id:number)=>Track|undefined){
    const items:QueueItem[]=[];let index:number|null=null;
    saved.items.forEach((id,i)=>{const t=lookup(id);if(t){if(saved.index===i)index=items.length;items.push(this.item(t));}});
    const pool=[...items],unshuffled:QueueItem[]=[];
    for(const id of saved.unshuffled){const p=pool.findIndex(x=>x.track.id===id);if(p>=0)unshuffled.push(...pool.splice(p,1));}
    unshuffled.push(...pool);
    this.items=items;this.unshuffled=saved.shuffle?unshuffled:[...items];this.index=index;
    this.repeat=saved.repeat;this.shuffle=saved.shuffle;this.source=saved.source;
    this.revision++;
  }

  private item(track:Track):QueueItem{return {entry:this.nextEntry++,track};}
  private currentEntry(){return this.index===null?null:this.items[this.index]?.entry??null;}
  private positionOf(entry:number|null){if(entry===null)return null;const i=this.items.findIndex(x=>x.entry===entry);return i<0?null:i;}
  private moved(){this.cursor++;this.revision++;return this.current();}
  private shuffleUpcoming(){
    const shuffle=(a:QueueItem[])=>{for(let i=a.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[a[i],a[j]]=[a[j],a[i]];}return a;};
    if(this.index===null){this.items=shuffle(this.items);return;}
    const [cur]=this.items.splice(this.index,1);
    this.items=[cur,...shuffle(this.items)];this.index=0;
  }
}
