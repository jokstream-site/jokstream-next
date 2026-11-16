import { useEffect, useMemo, useState } from 'react'
import { ArrowLeft, ArrowRight, CalendarDays, Flame, Film, Trophy } from 'lucide-react'
import { Link } from 'react-router-dom'

const API = (import.meta.env.VITE_API_BASE_URL as string | undefined)?.replace(/\/$/, '') || ''
type Fixture = { id: string; title: string; competition?: string; start_time: string; image?: string | null; source?: string }
type TrendingMovie = { id: string; title: string; overview?: string; releaseYear?: string; rating?: number | null; poster?: string | null; backdrop?: string | null; source?: string }
type Feed = { updatedAt: string; events: Fixture[]; trendingMovies: TrendingMovie[]; note?: string }
type Item = { id: string; kind: 'fixture' | 'movie'; title: string; subtitle: string; date?: string; image?: string | null; source?: string; rating?: number | null }

function dateLabel(value?: string) {
  if (!value) return 'Trending now'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return 'Time to be confirmed'
  return new Intl.DateTimeFormat(undefined, { weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' }).format(date)
}
function countdown(value: string, now: number) {
  const delta = Date.parse(value) - now
  if (!Number.isFinite(delta)) return 'Time TBA'
  if (delta <= 0) return 'Starting / live'
  const days = Math.floor(delta / 86400000)
  const hours = Math.floor((delta % 86400000) / 3600000)
  const minutes = Math.floor((delta % 3600000) / 60000)
  return days ? `Starts in ${days}d ${hours}h` : hours ? `Starts in ${hours}h ${minutes}m` : `Starts in ${Math.max(1, minutes)}m`
}

export default function EventsSpotlight() {
  const [feed, setFeed] = useState<Feed | null>(null)
  const [index, setIndex] = useState(0)
  const [now, setNow] = useState(Date.now())
  const [paused, setPaused] = useState(false)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let active = true
    const refresh = () => fetch(API + '/api/hero-events')
      .then(response => response.ok ? response.json() as Promise<Feed> : Promise.reject(new Error('feed unavailable')))
      .then(async data => {
        if (data.events?.length || data.trendingMovies?.length) return data
        const discoveryResponse = await fetch(API + '/api/home-discovery')
        if (!discoveryResponse.ok) return data
        const discovery = await discoveryResponse.json() as { latestMovies?: Array<{id:number;title:string;overview?:string;year?:string;rating?:number;poster?:string|null;backdrop?:string|null}> }
        return { ...data, trendingMovies: (discovery.latestMovies || []).slice(0, 10).map(movie => ({ id: String(movie.id), title: movie.title, overview: movie.overview, releaseYear: movie.year, rating: movie.rating, poster: movie.poster, backdrop: movie.backdrop, source: 'TMDB' })) }
      })
      .then(data => { if (active) { setFeed(data); setFailed(false) } })
      .catch(() => { if (active) setFailed(true) })
    void refresh()
    const clock = window.setInterval(() => setNow(Date.now()), 30000)
    const feedTimer = window.setInterval(() => void refresh(), 5 * 60 * 1000)
    return () => { active = false; window.clearInterval(clock); window.clearInterval(feedTimer) }
  }, [])

  const items = useMemo<Item[]>(() => {
    const fixtures = (feed?.events || []).map(event => ({
      id: 'fixture:' + event.id, kind: 'fixture' as const, title: event.title,
      subtitle: event.competition || 'Upcoming fixture', date: event.start_time,
      image: event.image, source: event.source,
    }))
    const movies = (feed?.trendingMovies || []).map(movie => ({
      id: 'movie:' + movie.id, kind: 'movie' as const, title: movie.title,
      subtitle: [movie.releaseYear, movie.overview].filter(Boolean).join(' · '),
      image: movie.backdrop || movie.poster, source: movie.source, rating: movie.rating,
    }))
    return [...fixtures, ...movies]
  }, [feed])

  useEffect(() => { if (index >= items.length) setIndex(0) }, [index, items.length])
  useEffect(() => {
    if (paused || items.length < 2) return
    const timer = window.setInterval(() => setIndex(current => (current + 1) % items.length), 7000)
    return () => window.clearInterval(timer)
  }, [paused, items.length])

  if (!feed && !failed) return <section className="h-[250px] animate-pulse rounded-3xl border border-white/10 bg-[#13151f] sm:h-[310px]" aria-label="Loading highlights" />
  if (!items.length) return <section className="rounded-3xl border border-white/10 bg-[radial-gradient(ellipse_at_80%_20%,#641526_0%,transparent_45%),#13151f] p-7 sm:p-10"><div className="flex items-center gap-2 text-xs font-bold uppercase tracking-[.2em] text-[#ff737b]"><Flame size={15}/> JokStream spotlight</div><h2 className="mt-3 text-2xl font-black sm:text-3xl">Your next big moment starts here</h2><p className="mt-2 max-w-xl text-sm text-white/55">{failed ? 'The highlights feed is temporarily unavailable. Please try again shortly.' : 'No fixtures or trending titles are available right now.'}</p><Link to="/events" className="mt-5 inline-flex items-center gap-2 rounded-xl bg-[#e50914] px-4 py-3 text-sm font-bold">Explore highlights <ArrowRight size={16}/></Link></section>

  const item = items[index]
  const image = item.image && /^https:\/\//i.test(item.image) ? item.image : null
  const started = item.date ? Date.parse(item.date) <= now : false
  return <section className="relative isolate overflow-hidden rounded-3xl border border-white/10 bg-[#11131c]" onMouseEnter={() => setPaused(true)} onMouseLeave={() => setPaused(false)} aria-label="JokStream featured events and titles">
    {image && <img key={image} src={image} alt="" className="absolute inset-0 -z-20 h-full w-full object-cover opacity-35 transition-opacity duration-700" loading="lazy"/>}
    <div className="absolute inset-0 -z-10 bg-gradient-to-r from-[#090a0f] via-[#090a0f]/90 to-[#090a0f]/35"/>
    <div className="absolute inset-0 -z-10 bg-gradient-to-t from-[#090a0f]/80 via-transparent to-transparent"/>
    <div className="flex min-h-[280px] flex-col justify-between gap-8 p-6 sm:min-h-[340px] sm:p-10 lg:p-12">
      <div className="flex items-center justify-between gap-3">
        <span className="inline-flex items-center gap-2 text-[11px] font-extrabold uppercase tracking-[.22em] text-[#ff737b]"><Flame size={15}/> JokStream · Spotlight</span>
        <span className="rounded-full border border-white/15 bg-black/30 px-3 py-1.5 text-[11px] text-white/70">{index + 1} / {items.length}</span>
      </div>
      <div className="max-w-3xl">
        <div className="flex flex-wrap items-center gap-2 text-xs font-semibold">
          <span className="inline-flex items-center gap-1.5 rounded-full bg-[#e50914] px-3 py-1.5 text-white">{item.kind === 'fixture' ? <Trophy size={13}/> : <Film size={13}/>} {item.kind === 'fixture' ? (started ? 'Scheduled start' : 'Upcoming event') : 'Trending movie'}</span>
          {item.date && <span className="rounded-full border border-white/15 bg-black/25 px-3 py-1.5 text-white/75">{countdown(item.date, now)}</span>}
          {typeof item.rating === 'number' && <span className="rounded-full border border-white/15 bg-black/25 px-3 py-1.5 text-white/75">★ {item.rating.toFixed(1)} / 10</span>}
        </div>
        <h2 className="mt-4 text-3xl font-black leading-tight sm:text-5xl">{item.title}</h2>
        <p className="mt-2 line-clamp-2 text-sm font-medium text-white/70 sm:text-base">{item.subtitle}</p>
        <p className="mt-3 flex items-center gap-2 text-xs text-white/55"><CalendarDays size={14}/>{dateLabel(item.date)}</p>
        <div className="mt-6 flex flex-wrap items-center gap-3">
          <Link to={item.kind === 'fixture' ? '/events' : '/movies'} className="inline-flex items-center gap-2 rounded-xl bg-[#e50914] px-5 py-3 text-sm font-bold transition hover:bg-[#c90812]">{item.kind === 'fixture' ? 'View event schedule' : 'Browse movies'} <ArrowRight size={16}/></Link>
          <span className="text-[11px] text-white/40">Data: {item.source || 'JokStream feed'}</span>
        </div>
      </div>
      <div className="flex items-center justify-between gap-3">
        <div className="flex max-w-[70%] gap-1.5 overflow-hidden">{items.slice(0, 12).map((entry, dot) => <button key={entry.id} onClick={() => setIndex(dot)} aria-label={'Show highlight ' + (dot + 1)} className={'h-1.5 rounded-full transition-all ' + (dot === index % 12 ? 'w-8 bg-[#e50914]' : 'w-3 bg-white/30 hover:bg-white/60')}/>)}</div>
        <div className="flex gap-2"><button onClick={() => setIndex(current => (current - 1 + items.length) % items.length)} aria-label="Previous highlight" className="grid h-10 w-10 place-items-center rounded-full border border-white/15 bg-black/30 hover:bg-white/10"><ArrowLeft size={17}/></button><button onClick={() => setIndex(current => (current + 1) % items.length)} aria-label="Next highlight" className="grid h-10 w-10 place-items-center rounded-full border border-white/15 bg-black/30 hover:bg-white/10"><ArrowRight size={17}/></button></div>
      </div>
    </div>
  </section>
}
