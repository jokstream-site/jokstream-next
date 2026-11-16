import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { Play, Tv, Film, Clapperboard, ArrowRight, LoaderCircle, Star } from 'lucide-react'
import WatchChannelModal from '../components/WatchChannelModal'
import EventsSpotlight from '../components/EventsSpotlight'
import AdSlot from '../components/AdSlot'

const API = (import.meta.env.VITE_API_BASE_URL as string | undefined)?.replace(/\/$/, '') || ''
type Channel = { id: string; item_id?: string; name: string }
type DiscoveryTitle = { id: number; title: string; overview?: string; releaseDate?: string; year?: string; rating?: number; poster?: string | null; backdrop?: string | null }
type Discovery = { latestMovies: DiscoveryTitle[]; latestSeries: DiscoveryTitle[]; topMovies: DiscoveryTitle[]; topSeries: DiscoveryTitle[]; updatedAt: string }
function imageSrc(value?: string | null) { return value && /^https?:\/\//i.test(value) ? value : '' }

function DiscoveryRail({ title, items, kind, subtitle }: { title: string; items: DiscoveryTitle[]; kind: 'movie' | 'series'; subtitle: string }) {
  return <section>
    <div className="mb-4 flex items-end justify-between gap-3"><div><h2 className="text-xl font-extrabold sm:text-2xl">{title}</h2><p className="mt-1 text-xs text-white/40">{subtitle}</p></div><Link to={kind === 'movie' ? '/movies' : '/series'} className="shrink-0 text-xs font-bold text-[#ff737b] hover:text-white">Explore all <ArrowRight className="ml-1 inline" size={14}/></Link></div>
    {items.length ? <div className="flex snap-x gap-3 overflow-x-auto pb-3">{items.map(item => <Link key={item.id} to={kind === 'movie' ? '/movies' : '/series'} className="group w-[142px] shrink-0 snap-start sm:w-[170px]"><div className="relative aspect-[2/3] overflow-hidden rounded-xl border border-white/10 bg-[#171923] shadow-lg">{imageSrc(item.poster) ? <img src={item.poster!} alt={item.title} loading="lazy" referrerPolicy="no-referrer" className="h-full w-full object-cover transition duration-500 group-hover:scale-105"/> : <div className="grid h-full place-items-center text-white/25">{kind === 'movie' ? <Film size={30}/> : <Clapperboard size={30}/>}</div>}<div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/90 to-transparent p-2 pt-8"><span className="flex items-center gap-1 text-xs font-bold text-amber-200"><Star size={12} fill="currentColor"/>{typeof item.rating === 'number' ? item.rating.toFixed(1) : '—'}</span></div></div><b className="mt-2 block truncate text-sm">{item.title}</b><span className="text-xs text-white/45">{item.year || 'Year unavailable'}</span></Link>)}</div> : <div className="rounded-xl border border-white/10 bg-white/[.03] p-5 text-sm text-white/45">Discovery titles are temporarily unavailable.</div>}
  </section>
}

export default function HomePage() {
  const [heroChannel, setHeroChannel] = useState<Channel | null>(null)
  const [watching, setWatching] = useState<{ id: string; name: string; streamUrl: string } | null>(null)
  const [opening, setOpening] = useState(false)
  const [playError, setPlayError] = useState('')
  const [discovery, setDiscovery] = useState<Discovery | null>(null)

  useEffect(() => {
    let active = true
    fetch(API + '/api/live?page=1&limit=1').then(response => response.ok ? response.json() : Promise.reject())
      .then(data => { if (active && data.items?.[0]) setHeroChannel(data.items[0] as Channel) }).catch(() => { if (active) setHeroChannel(null) })
    fetch(API + '/api/home-discovery').then(response => response.ok ? response.json() : Promise.reject())
      .then(data => { if (active) setDiscovery(data as Discovery) }).catch(() => { if (active) setDiscovery(null) })
    return () => { active = false }
  }, [])

  async function openHeroChannel() {
    if (!heroChannel || opening) return
    setOpening(true); setPlayError('')
    try {
      const response = await fetch(API + '/api/playback', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kind: 'live', id: String(heroChannel.item_id || heroChannel.id) }) })
      const data = await response.json()
      if (!response.ok || !data.url) throw new Error(data.error || 'Playback unavailable')
      setWatching({ id: String(heroChannel.item_id || heroChannel.id), name: heroChannel.name, streamUrl: data.url })
    } catch (error) { setPlayError(error instanceof Error ? error.message : 'Playback unavailable') }
    finally { setOpening(false) }
  }

  const heroImage = discovery?.latestMovies?.[0]?.backdrop || discovery?.latestSeries?.[0]?.backdrop || discovery?.topMovies?.[0]?.backdrop
  return <div className="space-y-12">
    <section className="relative isolate flex min-h-[430px] items-end overflow-hidden rounded-3xl border border-white/10 bg-[radial-gradient(ellipse_at_75%_25%,#8c1b35_0%,transparent_45%),linear-gradient(120deg,#171a28,#090a0f)] p-7 sm:min-h-[500px] sm:p-12">
      {imageSrc(heroImage) && <img src={heroImage!} alt="" className="absolute inset-0 -z-20 h-full w-full object-cover opacity-45" loading="lazy"/>}
      <div className="absolute inset-0 -z-10 bg-gradient-to-r from-[#090a0f] via-[#090a0f]/85 to-[#090a0f]/20"/>
      <div className="absolute inset-0 -z-10 bg-gradient-to-t from-[#090a0f]/90 via-transparent to-[#090a0f]/10"/>
      <div className="max-w-2xl">
        <span className="text-xs font-bold tracking-[.25em] text-[#ff737b]">WELCOME TO JOKSTREAM</span>
        <h1 className="mt-5 text-5xl font-black leading-tight sm:text-7xl">Watch More.<br/><span className="text-[#e50914]">Feel More.</span></h1>
        <p className="mt-5 max-w-lg text-sm leading-7 text-white/75">Your subscribed live channels, movies and series — together in one place.</p>
        <div className="mt-7 flex flex-wrap gap-3">
          <Link to="/live" className="inline-flex items-center gap-2 rounded-xl bg-[#e50914] px-5 py-3 text-sm font-bold"><Play size={16}/> Explore Live TV</Link>
          <Link to="/movies" className="rounded-xl border border-white/20 bg-black/30 px-5 py-3 text-sm font-semibold">Browse Movies</Link>
          {heroChannel && <button onClick={() => void openHeroChannel()} disabled={opening} className="inline-flex items-center gap-2 rounded-xl border border-white/20 bg-black/30 px-5 py-3 text-sm font-semibold disabled:opacity-50">{opening ? <LoaderCircle size={16} className="animate-spin"/> : <Tv size={16}/>} {opening ? 'Opening…' : 'Watch ' + heroChannel.name}</button>}
        </div>
        {playError && <p className="mt-3 text-xs text-red-300">{playError}</p>}
      </div>
    </section>
    <EventsSpotlight/>
    <AdSlot placement="section-banner" className="my-2 min-h-0"/>
    <DiscoveryRail title="أحدث الأفلام" items={discovery?.latestMovies || []} kind="movie" subtitle="Latest movie releases · TMDB"/>
    <DiscoveryRail title="أحدث المسلسلات" items={discovery?.latestSeries || []} kind="series" subtitle="Latest TV releases · TMDB"/>
    <DiscoveryRail title="أفضل الأفلام تقييماً" items={discovery?.topMovies || []} kind="movie" subtitle="Highest-rated movies · TMDB"/>
    <DiscoveryRail title="أفضل المسلسلات تقييماً" items={discovery?.topSeries || []} kind="series" subtitle="Highest-rated TV · TMDB"/>
    <section><h2 className="mb-4 text-xl font-bold">Explore JokStream</h2><div className="grid grid-cols-2 gap-3 md:grid-cols-3">{[[Tv,'Live TV','/live'],[Film,'Movies','/movies'],[Clapperboard,'Series','/series']].map(([Icon,label,to]:any)=><Link key={label} to={to} className="flex min-h-32 flex-col justify-between rounded-2xl border border-white/10 bg-[#171923] p-5 transition hover:border-[#e50914]/60"><Icon size={27} className="text-[#e50914]"/><span className="flex items-center justify-between font-bold">{label}<ArrowRight size={16}/></span></Link>)}</div></section>
    {watching && <WatchChannelModal channel={watching} onClose={() => setWatching(null)}/>}
  </div>
}
