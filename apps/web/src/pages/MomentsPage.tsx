import { useEffect, useState } from 'react'
import { Bookmark, Trash2 } from 'lucide-react'
import { deleteMoment, listSavedMoments, type SavedMoment } from '../lib/moments'
function time(value:number){return Math.floor(value/60)+':'+Math.floor(value%60).toString().padStart(2,'0')}
export default function MomentsPage(){
 const [items,setItems]=useState<SavedMoment[]>([])
 useEffect(()=>setItems(listSavedMoments()),[])
 const remove=(id:string)=>{deleteMoment(id);setItems(listSavedMoments())}
 return <section><div className="flex items-center gap-3"><Bookmark className="text-[#e50914]" size={28}/><div><h1 className="text-3xl font-black">My Moments</h1><p className="mt-1 text-sm text-white/50">Saved playback positions on this device</p></div></div>
 {!items.length?<div className="mt-8 rounded-xl border border-white/10 bg-[#13151f] p-8 text-center text-white/50">No saved moments yet. Use the bookmark button in the player.</div>:<div className="mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">{items.map(item=><article key={item.id} className="rounded-xl border border-white/10 bg-[#13151f] p-4"><div className="flex justify-between gap-3"><div className="min-w-0"><h2 className="truncate font-bold">{item.title}</h2><p className="mt-1 text-xs text-white/45">{item.streamType.toUpperCase()} · {item.live?'Live position':'Playback position'}</p></div><button onClick={()=>remove(item.id)} aria-label="Delete moment" className="p-2 text-white/50"><Trash2 size={16}/></button></div><p className="mt-4 font-semibold text-[#e50914]">{time(item.position)}</p><p className="mt-1 text-[11px] text-white/35">{new Date(item.savedAt).toLocaleString()}</p></article>)}</div>}</section>
}