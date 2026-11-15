import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { Play, Tv, Film, Clapperboard, ArrowRight, LoaderCircle } from 'lucide-react'
import WatchChannelModal from '../components/WatchChannelModal'

const API = (import.meta.env.VITE_API_BASE_URL as string | undefined)?.replace(/\/$/, '') || ''
type Channel = { id: string; item_id?: string; name: string }

export default function HomePage() {
  const [heroChannel, setHeroChannel] = useState<Channel | null>(null)
  const [watching, setWatching] = useState<{ id: string; name: string; streamUrl: string } | null>(null)
  const [opening, setOpening] = useState(false)
  const [playError, setPlayError] = useState('')

  useEffect(() => {
    let active = true
    fetch(API + '/api/live?page=1&limit=1')
      .then(response => response.ok ? response.json() : Promise.reject(new Error('Live channels unavailable')))
      .then(data => {
        if (active && data.items?.[0]) setHeroChannel(data.items[0] as Channel)
      })
      .catch(() => {
        if (active) setHeroChannel(null)
      })
    return () => { active = false }
  }, [])

  async function openHeroChannel() {
    if (!heroChannel || opening) return
    setOpening(true)
    setPlayError('')
    try {
      const response = await fetch(API + '/api/playback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind: 'live', id: String(heroChannel.item_id || heroChannel.id) }),
      })
      const data = await response.json()
      if (!response.ok || !data.url) throw new Error(data.error || 'Playback unavailable')
      setWatching({
        id: String(heroChannel.item_id || heroChannel.id),
        name: heroChannel.name,
        streamUrl: data.url,
      })
    } catch (error) {
      setPlayError(error instanceof Error ? error.message : 'Playback unavailable')
    } finally {
      setOpening(false)
    }
  }

  return <div className="space-y-10">
    <section className="relative flex min-h-[390px] items-end overflow-hidden rounded-3xl border border-white/10 bg-[radial-gradient(ellipse_at_75%_25%,#7c1426_0%,transparent_42%),linear-gradient(120deg,#13151f,#090a0f)] p-7 sm:p-12">
      <div className="max-w-2xl">
        <span className="text-xs font-bold tracking-[.25em] text-[#ff6971]">WELCOME TO JOKSTREAM</span>
        <h1 className="mt-5 text-5xl font-black leading-tight sm:text-7xl">Watch More.<br/><span className="text-[#e50914]">Feel More.</span></h1>
        <p className="mt-5 max-w-lg text-sm leading-7 text-white/55">Your subscribed live channels, movies and series — together in one place.</p>
        <div className="mt-7 flex flex-wrap gap-3">
          <Link to="/live" className="inline-flex items-center gap-2 rounded-xl bg-[#e50914] px-5 py-3 text-sm font-bold"><Play size={16}/> Explore Live TV</Link>
          <Link to="/movies" className="rounded-xl border border-white/15 bg-white/5 px-5 py-3 text-sm">Browse Movies</Link>
          {heroChannel && <button onClick={() => void openHeroChannel()} disabled={opening} className="inline-flex items-center gap-2 rounded-xl border border-white/15 bg-white/5 px-5 py-3 text-sm font-semibold hover:border-[#e50914]/60 disabled:opacity-50">
            {opening ? <LoaderCircle size={16} className="animate-spin"/> : <Tv size={16}/>}
            {opening ? 'Opening…' : 'Watch ' + heroChannel.name}
          </button>}
        </div>
        {playError && <p className="mt-3 text-xs text-red-300">{playError}</p>}
      </div>
    </section>
    <section>
      <h2 className="mb-4 text-xl font-bold">Explore JokStream</h2>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {[[Tv, 'Live TV', '/live'], [Film, 'Movies', '/movies'], [Clapperboard, 'Series', '/series']].map(([Icon, label, to]: any) =>
          <Link key={label} to={to} className="flex min-h-36 flex-col justify-between rounded-2xl border border-white/10 bg-[#13151f] p-5 transition hover:border-[#e50914]/60">
            <Icon size={27} className="text-[#e50914]"/>
            <span className="flex items-center justify-between font-bold">{label}<ArrowRight size={16}/></span>
          </Link>
        )}
      </div>
    </section>
    {watching && <WatchChannelModal channel={watching} onClose={() => setWatching(null)}/>}
  </div>
}
