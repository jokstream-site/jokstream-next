import { useEffect, useMemo, useState } from 'react'
import { CalendarDays, Clock3, Trophy, Film, RefreshCw, Radio, Star } from 'lucide-react'
import EventsSpotlight from '../components/EventsSpotlight'

const API = (import.meta.env.VITE_API_BASE_URL as string | undefined)?.replace(/\/$/, '') || ''
type Fixture = { id:string; title:string; competition?:string; start_time:string; image?:string|null; source?:string }
type TrendingMovie = { id:string; title:string; overview?:string; releaseYear?:string; rating?:number|null; poster?:string|null; backdrop?:string|null; source?:string }
type Feed = { updatedAt:string; events:Fixture[]; trendingMovies:TrendingMovie[]; note?:string }

function formatDate(value:string) {
 const date = new Date(value)
 if (Number.isNaN(date.getTime())) return 'Time TBA'
 return new Intl.DateTimeFormat(undefined,{weekday:'short',day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'}).format(date)
}

export default function EventsPage() {
 const [feed,setFeed] = useState<Feed|null>(null)
 const [tab,setTab] = useState<'sports'|'movies'>('sports')
 const [loading,setLoading] = useState(true)
 const [error,setError] = useState('')

 async function load() {
  setLoading(true); setError('')
  try {
   const response = await fetch(API + '/api/hero-events')
   if (!response.ok) throw new Error('The highlights feed is temporarily unavailable.')
   const data = await response.json() as Feed
   setFeed(data)
  } catch (e) {
   setError(e instanceof Error ? e.message : 'Unable to load highlights.')
  } finally { setLoading(false) }
 }
 useEffect(() => { void load() }, [])

 const sports = useMemo(() => [...(feed?.events || [])].sort((a,b)=>Date.parse(a.start_time)-Date.parse(b.start_time)),[feed])
 const movies = feed?.trendingMovies || []

 return <section className="min-h-[70vh] space-y-7">
  <EventsSpotlight/>
  <header className="flex flex-wrap items-end justify-between gap-4">
   <div><span className="text-xs font-bold tracking-[.24em] text-brand">JOKSTREAM · DISCOVERY</span><h1 className="mt-2 text-4xl font-extrabold">Events & Highlights</h1><p className="mt-2 text-sm text-white/45">Upcoming fixtures and trending movies, presented with verified source data.</p></div>
   <button onClick={()=>void load()} disabled={loading} className="inline-flex items-center gap-2 rounded-xl border border-white/10 bg-card px-4 py-3 text-sm disabled:opacity-50"><RefreshCw size={15} className={loading?'animate-spin':''}/> Refresh</button>
  </header>
  <div className="flex gap-2 rounded-xl border border-white/10 bg-card p-1">
   <button onClick={()=>setTab('sports')} className={'flex flex-1 items-center justify-center gap-2 rounded-lg px-3 py-3 text-sm font-semibold '+(tab==='sports'?'bg-brand text-white':'text-white/55')}><Trophy size={16}/> Sports fixtures</button>
   <button onClick={()=>setTab('movies')} className={'flex flex-1 items-center justify-center gap-2 rounded-lg px-3 py-3 text-sm font-semibold '+(tab==='movies'?'bg-brand text-white':'text-white/55')}><Film size={16}/> Trending movies</button>
  </div>
  {loading ? <div className="grid min-h-48 place-items-center text-sm text-white/45">Loading highlights…</div> : error ? <div className="rounded-2xl border border-white/10 bg-card p-6 text-center"><p className="text-sm text-red-200">{error}</p><button onClick={()=>void load()} className="mt-4 rounded-lg bg-brand px-4 py-2 text-sm font-bold">Try again</button></div> : tab==='sports' ? (
   sports.length ? <div className="grid gap-3 md:grid-cols-2">{sports.map(event=><article key={event.id} className="overflow-hidden rounded-2xl border border-white/10 bg-card">{event.image && <img src={event.image} alt="" loading="lazy" className="h-40 w-full object-cover"/>}<div className="p-5"><div className="flex items-center justify-between gap-3"><span className="rounded-full bg-white/5 px-3 py-1 text-[11px] text-white/55">Football</span><span className="flex items-center gap-1 text-xs text-white/45"><Clock3 size={13}/>{formatDate(event.start_time)}</span></div><h2 className="mt-4 text-lg font-bold">{event.title}</h2><p className="mt-1 text-xs text-white/45">{event.competition || 'Competition not listed'}</p><div className="mt-4 flex items-center gap-2 border-t border-white/5 pt-3 text-[11px] text-white/35"><Radio size={13}/> Fixture data · {event.source || 'External schedule'}</div></div></article>)}</div> : <div className="rounded-2xl border border-white/10 bg-card p-8 text-center"><CalendarDays className="mx-auto text-white/30"/><h2 className="mt-3 font-bold">No upcoming fixtures found</h2><p className="mt-1 text-sm text-white/45">Refresh later to check for new fixtures.</p></div>
  ) : (
   movies.length ? <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">{movies.map(movie=><article key={movie.id} className="overflow-hidden rounded-2xl border border-white/10 bg-card">{(movie.backdrop || movie.poster) ? <img src={movie.backdrop || movie.poster || ''} alt="" loading="lazy" className="aspect-video w-full object-cover"/> : <div className="aspect-video bg-white/5"/>}<div className="p-4"><div className="flex items-center justify-between gap-2"><span className="text-[11px] text-white/45">{movie.releaseYear || 'Release year unavailable'}</span>{typeof movie.rating==='number' && <span className="inline-flex items-center gap-1 text-xs text-amber-200"><Star size={13} fill="currentColor"/>{movie.rating.toFixed(1)}</span>}</div><h2 className="mt-2 font-bold">{movie.title}</h2>{movie.overview && <p className="mt-2 line-clamp-3 text-xs leading-5 text-white/45">{movie.overview}</p>}<p className="mt-3 text-[10px] text-white/30">Artwork & metadata · {movie.source || 'TMDB'}</p></div></article>)}</div> : <div className="rounded-2xl border border-white/10 bg-card p-8 text-center"><Film className="mx-auto text-white/30"/><h2 className="mt-3 font-bold">No trending titles available</h2><p className="mt-1 text-sm text-white/45">Movie highlights appear when the metadata feed is configured.</p></div>
  )}
  {feed?.note && <p className="text-xs leading-5 text-white/35">{feed.note}</p>}
 </section>
}
