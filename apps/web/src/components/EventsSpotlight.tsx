import { useEffect, useMemo, useState } from 'react'
import { ArrowLeft, ArrowRight, CalendarDays, Clock3, Flame, Radio, Tv, Trophy } from 'lucide-react'
import { Link } from 'react-router-dom'

const API = (import.meta.env.VITE_API_BASE_URL as string | undefined)?.replace(/\/$/, '') || ''
type SportEvent = { id: string; sport: string; title: string; startsAt: string; competition?: string; status?: string; source?: string }
type TVEpisode = { id: string; title: string; show: string; season?: number; episode?: number; startsAt: string; image?: string | null; summary?: string; source?: string }
type Feed = { updatedAt: string; sports: SportEvent[]; episodes: TVEpisode[]; sources?: string[] }

type SpotlightItem = { id: string; kind: 'sport' | 'episode'; title: string; subtitle: string; startsAt: string; image?: string | null; source?: string; sport?: string }

function dateLabel(value: string) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return 'Schedule to be confirmed'
  return new Intl.DateTimeFormat(undefined, { weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' }).format(date)
}

function countdown(value: string, now: number) {
  const target = Date.parse(value)
  if (!Number.isFinite(target)) return 'Time to be confirmed'
  const delta = target - now
  if (delta <= 0) return 'Starting now'
  const days = Math.floor(delta / 86400000)
  const hours = Math.floor((delta % 86400000) / 3600000)
  const minutes = Math.floor((delta % 3600000) / 60000)
  if (days) return `Starts in ${days}d ${hours}h`
  if (hours) return `Starts in ${hours}h ${minutes}m`
  return `Starts in ${Math.max(1, minutes)}m`
}

export default function EventsSpotlight() {
  const [feed, setFeed] = useState<Feed | null>(null)
  const [index, setIndex] = useState(0)
  const [now, setNow] = useState(Date.now())
  const [paused, setPaused] = useState(false)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let active = true
    fetch(API + '/api/discovery')
      .then(response => response.ok ? response.json() as Promise<Feed> : Promise.reject(new Error('feed unavailable')))
      .then(data => { if (active) setFeed(data) })
      .catch(() => { if (active) setFailed(true) })
    const clock = window.setInterval(() => setNow(Date.now()), 30000)
    return () => { active = false; window.clearInterval(clock) }
  }, [])

  const items = useMemo<SpotlightItem[]>(() => {
    const sports = (feed?.sports || []).map(event => ({
      id: 'sport:' + event.id, kind: 'sport' as const, title: event.title,
      subtitle: event.competition || event.sport, startsAt: event.startsAt, source: event.source, sport: event.sport
    }))
    const episodes = (feed?.episodes || []).map(ep => ({
      id: 'episode:' + ep.id, kind: 'episode' as const, title: ep.show,
      subtitle: [ep.title, ep.season ? 'S' + ep.season : '', ep.episode ? 'E' + ep.episode : ''].filter(Boolean).join(' · '),
      startsAt: ep.startsAt, image: ep.image, source: ep.source
    }))
    return [...sports, ...episodes]
      .filter(item => Number.isFinite(Date.parse(item.startsAt)) && Date.parse(item.startsAt) >= now - 2 * 60 * 60 * 1000)
      .sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt))
  }, [feed, now])

  useEffect(() => { if (index >= items.length) setIndex(0) }, [index, items.length])
  useEffect(() => {
    if (paused || items.length < 2) return
    const timer = window.setInterval(() => setIndex(current => (current + 1) % items.length), 7000)
    return () => window.clearInterval(timer)
  }, [paused, items.length])

  if (!feed && !failed) return <section className="h-[250px] animate-pulse rounded-3xl border border-white/10 bg-[#13151f] sm:h-[310px]" aria-label="Loading upcoming events" />
  if (!items.length) return <section className="rounded-3xl border border-white/10 bg-[radial-gradient(ellipse_at_80%_20%,#641526_0%,transparent_45%),#13151f] p-7 sm:p-10"><div className="flex items-center gap-2 text-xs font-bold uppercase tracking-[.2em] text-[#ff737b]"><Flame size={15}/> JokStream spotlight</div><h2 className="mt-3 text-2xl font-black sm:text-3xl">Your next big moment starts here</h2><p className="mt-2 max-w-xl text-sm text-white/55">{failed ? 'The event schedule is temporarily unavailable. Please try again shortly.' : 'No upcoming fixtures or premieres are listed right now.'}</p><Link to="/events" className="mt-5 inline-flex items-center gap-2 rounded-xl bg-[#e50914] px-4 py-3 text-sm font-bold">Explore events <ArrowRight size={16}/></Link></section>

  const item = items[index]
  const image = item.kind === 'episode' && item.image && /^https:\/\//i.test(item.image) ? item.image : null
  const isLive = Date.parse(item.startsAt) <= now
  return <section className="relative isolate overflow-hidden rounded-3xl border border-white/10 bg-[#11131c]" onMouseEnter={() => setPaused(true)} onMouseLeave={() => setPaused(false)} aria-label="Upcoming events spotlight">
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
          <span className="inline-flex items-center gap-1.5 rounded-full bg-[#e50914] px-3 py-1.5 text-white">{isLive ? <Radio size={13}/> : item.kind === 'sport' ? <Trophy size={13}/> : <Tv size={13}/>} {isLive ? 'Starting now' : item.kind === 'sport' ? (item.sport || 'Sport') : 'TV premiere'}</span>
          <span className="rounded-full border border-white/15 bg-black/25 px-3 py-1.5 text-white/75">{countdown(item.startsAt, now)}</span>
        </div>
        <h2 className="mt-4 text-3xl font-black leading-tight sm:text-5xl">{item.title}</h2>
        <p className="mt-2 text-sm font-medium text-white/70 sm:text-base">{item.subtitle}</p>
        <p className="mt-3 flex items-center gap-2 text-xs text-white/55"><CalendarDays size={14}/>{dateLabel(item.startsAt)}</p>
        <div className="mt-6 flex flex-wrap items-center gap-3">
          <Link to="/events" className="inline-flex items-center gap-2 rounded-xl bg-[#e50914] px-5 py-3 text-sm font-bold transition hover:bg-[#c90812]">View event schedule <ArrowRight size={16}/></Link>
          <span className="text-[11px] text-white/40">Schedule: {item.source || 'Event feed'} · Channel availability is verified separately</span>
        </div>
      </div>
      <div className="flex items-center justify-between gap-3">
        <div className="flex max-w-[70%] gap-1.5 overflow-hidden">{items.slice(0, 12).map((entry, dot) => <button key={entry.id} onClick={() => setIndex(dot)} aria-label={'Show event ' + (dot + 1)} className={'h-1.5 rounded-full transition-all ' + (dot === index ? 'w-8 bg-[#e50914]' : 'w-3 bg-white/30 hover:bg-white/60')}/>)}</div>
        <div className="flex gap-2"><button onClick={() => setIndex(current => (current - 1 + items.length) % items.length)} aria-label="Previous event" className="grid h-10 w-10 place-items-center rounded-full border border-white/15 bg-black/30 hover:bg-white/10"><ArrowLeft size={17}/></button><button onClick={() => setIndex(current => (current + 1) % items.length)} aria-label="Next event" className="grid h-10 w-10 place-items-center rounded-full border border-white/15 bg-black/30 hover:bg-white/10"><ArrowRight size={17}/></button></div>
      </div>
    </div>
  </section>
}
