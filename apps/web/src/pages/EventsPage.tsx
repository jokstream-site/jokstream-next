import { useEffect, useMemo, useState } from 'react'
import { CalendarDays, Clock3, Trophy, Tv, RefreshCw, Radio } from 'lucide-react'
import EventsSpotlight from '../components/EventsSpotlight'

const API = (import.meta.env.VITE_API_BASE_URL as string | undefined)?.replace(/\/$/, '') || ''
type SportEvent = { id:string; sport:string; title:string; startsAt:string; competition?:string; status?:string; source?:string }
type TVEpisode = { id:string; title:string; show:string; season?:number; episode?:number; startsAt:string; image?:string|null; summary?:string; source?:string }
type Feed = { updatedAt:string; sports:SportEvent[]; episodes:TVEpisode[]; sources?:string[]; broadcasterVerification?:string }

function formatDate(value:string) {
 const date = new Date(value)
 if (Number.isNaN(date.getTime())) return 'Time TBA'
 return new Intl.DateTimeFormat(undefined,{weekday:'short',day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'}).format(date)
}

export default function EventsPage() {
 const [feed,setFeed] = useState<Feed|null>(null)
 const [tab,setTab] = useState<'sports'|'episodes'>('sports')
 const [sport,setSport] = useState('all')
 const [loading,setLoading] = useState(true)
 const [error,setError] = useState('')

 async function load() {
  setLoading(true); setError('')
  try {
   const response = await fetch(API + '/api/discovery')
   if (!response.ok) throw new Error('The events feed is temporarily unavailable.')
   const data = await response.json() as Feed
   setFeed(data)
  } catch (e) {
   setError(e instanceof Error ? e.message : 'Unable to load events.')
  } finally { setLoading(false) }
 }
 useEffect(() => { void load() }, [])

 const sports = useMemo(() => (feed?.sports || []).filter(event => sport === 'all' || event.sport === sport),[feed,sport])
 const sportNames = useMemo(() => Array.from(new Set((feed?.sports || []).map(e=>e.sport))).sort(),[feed])

 return <section className="min-h-[70vh] space-y-7">
  <EventsSpotlight/>
  <header className="flex flex-wrap items-end justify-between gap-4">
   <div><span className="text-xs font-bold tracking-[.24em] text-brand">JOKSTREAM · DISCOVERY</span><h1 className="mt-2 text-4xl font-extrabold">Events</h1><p className="mt-2 text-sm text-white/45">Upcoming sports fixtures and TV premieres, ordered by start time.</p></div>
   <button onClick={()=>void load()} disabled={loading} className="inline-flex items-center gap-2 rounded-xl border border-white/10 bg-card px-4 py-3 text-sm disabled:opacity-50"><RefreshCw size={15} className={loading?'animate-spin':''}/> Refresh</button>
  </header>
  <div className="flex gap-2 rounded-xl border border-white/10 bg-card p-1">
   <button onClick={()=>setTab('sports')} className={'flex flex-1 items-center justify-center gap-2 rounded-lg px-3 py-3 text-sm font-semibold '+(tab==='sports'?'bg-brand text-white':'text-white/55')}><Trophy size={16}/> Sports fixtures</button>
   <button onClick={()=>setTab('episodes')} className={'flex flex-1 items-center justify-center gap-2 rounded-lg px-3 py-3 text-sm font-semibold '+(tab==='episodes'?'bg-brand text-white':'text-white/55')}><Tv size={16}/> TV premieres</button>
  </div>
  {tab==='sports' && <div className="flex gap-2 overflow-x-auto pb-1"><button onClick={()=>setSport('all')} className={'shrink-0 rounded-full border px-4 py-2 text-xs '+(sport==='all'?'border-brand bg-brand/15':'border-white/10 text-white/55')}>All sports</button>{sportNames.map(name=><button key={name} onClick={()=>setSport(name)} className={'shrink-0 rounded-full border px-4 py-2 text-xs capitalize '+(sport===name?'border-brand bg-brand/15':'border-white/10 text-white/55')}>{name}</button>)}</div>}
  {loading ? <div className="grid min-h-48 place-items-center text-sm text-white/45">Loading events…</div> : error ? <div className="rounded-2xl border border-white/10 bg-card p-6 text-center"><p className="text-sm text-red-200">{error}</p><button onClick={()=>void load()} className="mt-4 rounded-lg bg-brand px-4 py-2 text-sm font-bold">Try again</button></div> : tab==='sports' ? (
   sports.length ? <div className="grid gap-3 md:grid-cols-2">{sports.map(event=><article key={event.id} className="rounded-2xl border border-white/10 bg-card p-5"><div className="flex items-center justify-between gap-3"><span className="rounded-full bg-white/5 px-3 py-1 text-[11px] capitalize text-white/55">{event.sport}</span><span className="flex items-center gap-1 text-xs text-white/45"><Clock3 size={13}/>{formatDate(event.startsAt)}</span></div><h2 className="mt-4 text-lg font-bold">{event.title}</h2><p className="mt-1 text-xs text-white/45">{event.competition || 'Competition not listed'}</p><div className="mt-4 flex items-center gap-2 border-t border-white/5 pt-3 text-[11px] text-white/35"><Radio size={13}/> Fixture data · {event.source || 'External schedule'}</div></article>)}</div> : <div className="rounded-2xl border border-white/10 bg-card p-8 text-center"><CalendarDays className="mx-auto text-white/30"/><h2 className="mt-3 font-bold">No upcoming fixtures found</h2><p className="mt-1 text-sm text-white/45">Try another sport or refresh later.</p></div>
  ) : (
   (feed?.episodes || []).length ? <div className="grid gap-3 md:grid-cols-2">{feed!.episodes.map(ep=><article key={ep.id} className="flex gap-4 rounded-2xl border border-white/10 bg-card p-4">{ep.image ? <img src={ep.image} alt="" loading="lazy" className="h-28 w-20 rounded-lg object-cover"/> : <div className="grid h-28 w-20 shrink-0 place-items-center rounded-lg bg-white/5 text-white/30"><Tv/></div>}<div className="min-w-0"><p className="text-xs text-white/45">{formatDate(ep.startsAt)}</p><h2 className="mt-1 truncate font-bold">{ep.show}</h2><p className="mt-1 text-sm text-white/70">{ep.title}</p><p className="mt-1 text-xs text-white/40">{ep.season ? 'Season '+ep.season : ''}{ep.episode ? ' · Episode '+ep.episode : ''}</p>{ep.summary&&<p className="mt-2 line-clamp-2 text-xs leading-5 text-white/45">{ep.summary}</p>}</div></article>)}</div> : <div className="rounded-2xl border border-white/10 bg-card p-8 text-center"><Tv className="mx-auto text-white/30"/><h2 className="mt-3 font-bold">No scheduled premieres found</h2><p className="mt-1 text-sm text-white/45">The TV schedule feed has no upcoming entries right now.</p></div>
  )}
  <p className="text-xs leading-5 text-white/35">Schedules are informational and come from the listed fixture and TV schedule providers. A broadcast channel is never guessed: channel availability must be verified separately before a watch action can be shown.</p>
 </section>
}
