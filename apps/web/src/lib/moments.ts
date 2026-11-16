export type SavedMoment = { id:string; mediaKey:string; title:string; streamType:'live'|'movie'|'series'; position:number; live:boolean; savedAt:number }
const KEY = 'jokstream.saved-moments.v1'
function read(): SavedMoment[] {
  try { const value: unknown = JSON.parse(localStorage.getItem(KEY) || '[]'); return Array.isArray(value) ? value.filter(x => x && typeof x.id === 'string' && typeof x.title === 'string' && typeof x.position === 'number') as SavedMoment[] : [] } catch { return [] }
}
export function listSavedMoments(): SavedMoment[] { return read().sort((a,b) => b.savedAt-a.savedAt) }
export function saveMoment(value: Omit<SavedMoment,'id'|'savedAt'>): SavedMoment {
  const item = {...value, id: crypto.randomUUID(), savedAt: Date.now()}
  localStorage.setItem(KEY, JSON.stringify([item,...read()].slice(0,250)))
  return item
}
export function deleteMoment(id:string):void { localStorage.setItem(KEY,JSON.stringify(read().filter(x=>x.id!==id))) }