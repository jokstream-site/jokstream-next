import { useEffect, useMemo, useRef, useState } from 'react'
import { supabase } from './lib/supabase'
import type HlsType from 'hls.js'
import { Search, Tv, Film, Clapperboard, Trophy, MessageCircle, Send, Maximize2, Minimize2, Eye, EyeOff, Play, Radio, Menu, Sparkles, Volume2, Settings2, Globe, Star, Flame, CalendarDays, Clock } from 'lucide-react'

type Episode = { id: string; title: string; season: string; episode_num?: number; container_extension?: string }
type ChatMessage = { id: number; channel_id: string; display_name: string; message: string; created_at: string }
type Channel = { id: string; name: string; category: string; detail: string; color: string; kind: 'live'|'movie'|'series' }
type CatalogCategory = { name: string; count: number }
const API = (import.meta.env.VITE_API_BASE_URL as string | undefined)?.replace(/\/$/, '') || ''
const emptySelection: Channel = { id: '', name: 'Choose something to watch', category: 'JokStream', detail: 'Library', color: 'blue', kind: 'live' }
const sections = [{ id: 'home', label: 'Discover', icon: Sparkles }, { id: 'live', label: 'Live TV', icon: Radio }, { id: 'movies', label: 'Movies', icon: Film }, { id: 'series', label: 'Series', icon: Clapperboard }, { id: 'sports', label: 'Sports', icon: Trophy }]

export default function App() {
  const [activeSection, setActiveSection] = useState('home')
  const [selected, setSelected] = useState<Channel>(emptySelection)
  const [chatVisible, setChatVisible] = useState(true)
  const [expanded, setExpanded] = useState(false)
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [channels, setChannels] = useState<Channel[]>([])
  const [catalogCategories, setCatalogCategories] = useState<CatalogCategory[]>([])
  const [draft, setDraft] = useState('')
  const [nickname, setNickname] = useState(() => localStorage.getItem('jokstream-nickname') || '')
  const [nameInput, setNameInput] = useState('')
  const [search, setSearch] = useState('')
  const [chatError, setChatError] = useState('')
  const [apiStatus, setApiStatus] = useState<'loading'|'ready'|'offline'>('loading')
  const [providerConfigured, setProviderConfigured] = useState(false)
  const [mediaProxyConfigured, setMediaProxyConfigured] = useState(false)
  const bottomRef = useRef<HTMLDivElement>(null)
  const videoRef = useRef<HTMLVideoElement>(null)
  const [playbackUrl, setPlaybackUrl] = useState('')
  const [playbackError, setPlaybackError] = useState('')
  const [playbackLoading, setPlaybackLoading] = useState(false)
  const [episodes, setEpisodes] = useState<Episode[]>([])
  const [selectedEpisodeId, setSelectedEpisodeId] = useState('')
  const [playing, setPlaying] = useState(false)
  const [showAdmin, setShowAdmin] = useState(false)
  const [adminToken, setAdminToken] = useState('')
  const [adminMessage, setAdminMessage] = useState('')
  const [syncBusy, setSyncBusy] = useState(false)
  const [catalogTotal, setCatalogTotal] = useState(0)
  const [hasMore, setHasMore] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [catalogReload, setCatalogReload] = useState(0)
  const [activeCategory, setActiveCategory] = useState('All')
  const [discovery, setDiscovery] = useState<any>({sports:[],episodes:[]})
  const [spotlightIndex, setSpotlightIndex] = useState(0)

  useEffect(() => {
    setActiveCategory('All')
    window.scrollTo({ top: 0, behavior: 'instant' })
  }, [activeSection])

  useEffect(() => {
    let alive = true
    const controller = new AbortController()
    const kind = activeSection === 'live' || activeSection === 'sports' ? 'live' : activeSection === 'movies' ? 'movie' : activeSection === 'series' ? 'series' : ''
    const params = new URLSearchParams({ limit: '60', offset: '0' })
    if (activeCategory !== 'All') params.set('category', activeCategory)
    if (kind) params.set('kind', kind)
    if (search.trim()) params.set('q', search.trim())
    setApiStatus('loading')
    setChannels([])
    const categoryParams = new URLSearchParams()
    if (kind) categoryParams.set('kind', kind)
    if (search.trim()) categoryParams.set('q', search.trim())
    fetch(API + '/api/catalog/categories?' + categoryParams.toString(), { signal: controller.signal }).then(async response => {
      if (!response.ok) throw new Error('categories unavailable')
      const data = await response.json() as { categories?: CatalogCategory[] }
      if (alive) setCatalogCategories(data.categories || [])
    }).catch(() => { if (alive) setCatalogCategories([]) })
    fetch(API + '/api/catalog?' + params.toString(), { signal: controller.signal }).then(async catalogRes => {
      if (!catalogRes.ok) throw new Error('catalog unavailable')
      const catalogData = await catalogRes.json() as { items?: Array<{id:string;name:string;category:string;kind:'live'|'movie'|'series'}>; total?: number }
      const statusRes = await fetch(API + '/api/status', { signal: controller.signal })
      if (!statusRes.ok) throw new Error('api unavailable')
      const statusData = await statusRes.json() as { providerConfigured?: boolean; mediaProxyConfigured?: boolean }
      if (!alive) return
      const items = (catalogData.items || []).map(item => ({...item, detail:item.category, color:item.kind === 'live' ? 'blue' : item.kind === 'movie' ? 'rose' : 'violet'}))
      setProviderConfigured(Boolean(statusData.providerConfigured))
      setMediaProxyConfigured(Boolean(statusData.mediaProxyConfigured))
      setApiStatus('ready')
      setChannels(items)
      setCatalogTotal(catalogData.total || 0)
      setHasMore((catalogData.total || 0) > items.length)

    }).catch(error => { if (alive && error.name !== 'AbortError') setApiStatus('offline') })
    return () => { alive = false; controller.abort() }
  }, [activeSection, activeCategory, search, catalogReload])

  async function loadMoreCatalog() {
    if (loadingMore || !hasMore) return
    setLoadingMore(true)
    const kind = activeSection === 'live' || activeSection === 'sports' ? 'live' : activeSection === 'movies' ? 'movie' : activeSection === 'series' ? 'series' : ''
    const params = new URLSearchParams({ limit: '60', offset: String(channels.length) })
    if (kind) params.set('kind', kind)
    if (activeCategory !== 'All') params.set('category', activeCategory)
    if (search.trim()) params.set('q', search.trim())
    try {
      const response = await fetch(API + '/api/catalog?' + params.toString())
      if (!response.ok) throw new Error('catalog_page_failed')
      const data = await response.json() as { items?: Array<{id:string;name:string;category:string;kind:'live'|'movie'|'series'}>; total?: number }
      const items = (data.items || []).map(item => ({...item, detail:item.category, color:item.kind === 'live' ? 'blue' : item.kind === 'movie' ? 'rose' : 'violet'}))
      setChannels(previous => [...previous, ...items.filter(item => !previous.some(old => old.kind === item.kind && old.id === item.id))])
      setCatalogTotal(data.total || 0)
      setHasMore(channels.length + items.length < (data.total || 0))
    } catch { setAdminMessage('Could not load the next catalog page.') }
    finally { setLoadingMore(false) }
  }

  useEffect(() => {
    let alive = true
    const load = async () => {
      try {
        const response = await fetch(API + '/api/discovery')
        if (!response.ok) return
        const data = await response.json()
        if (alive) setDiscovery(data)
      } catch { /* keep previous feed */ }
    }
    void load()
    const id = window.setInterval(load, 600000)
    return () => { alive = false; window.clearInterval(id) }
  }, [])

  useEffect(() => {
    const client = supabase
    if (!client || !selected.id) { setMessages([]); return }
    let alive = true
    client.from('chat_messages').select('id,channel_id,display_name,message,created_at').eq('channel_id', selected.id).order('created_at', { ascending: true }).limit(100)
      .then(({ data, error }) => { if (alive && !error) setMessages((data || []) as ChatMessage[]) })
    const channel = client.channel('jokstream-chat-' + selected.id)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'chat_messages', filter: 'channel_id=eq.' + selected.id }, payload => {
        const incoming = payload.new as ChatMessage
        setMessages(prev => prev.some(m => m.id === incoming.id) ? prev : [...prev, incoming].slice(-150))
      }).subscribe()
    return () => { alive = false; void client.removeChannel(channel) }
  }, [selected.id])

  useEffect(() => {
    setPlaybackUrl(''); setPlaybackError(''); setPlaying(false)
    if (selected.kind !== 'series' || !selected.id) { setEpisodes([]); setSelectedEpisodeId(''); return }
    let alive = true
    fetch(API + '/api/series/' + encodeURIComponent(selected.id)).then(async response => {
      if (!response.ok) throw new Error('series_details_unavailable')
      const info = await response.json() as { episodes?: Record<string, Array<{ id?: string|number; title?: string; episode_num?: number; container_extension?: string }>> }
      const rows = Object.entries(info.episodes || {}).flatMap(([season, list]) => list.map(row => ({ id: String(row.id ?? ''), title: row.title || ('Episode ' + (row.episode_num ?? '')), season, episode_num: row.episode_num, container_extension: row.container_extension })).filter(row => row.id))
      if (alive) { setEpisodes(rows); setSelectedEpisodeId(rows[0]?.id || '') }
    }).catch(() => { if (alive) { setEpisodes([]); setPlaybackError('Could not load series episodes.') } })
    return () => { alive = false }
  }, [selected.id, selected.kind])

  useEffect(() => {
    const video = videoRef.current
    if (!video || !playbackUrl) return
    let cancelled = false
    let hls: HlsType | null = null
    if (playbackUrl.includes('.m3u8')) {
      if (video.canPlayType('application/vnd.apple.mpegurl')) {
        video.src = playbackUrl
      } else {
        void import('hls.js').then(({ default: Hls }) => {
          if (cancelled) return
          if (!Hls.isSupported()) { setPlaybackError('This browser does not support HLS playback. Try a modern browser.'); return }
          hls = new Hls({ enableWorker: true, lowLatencyMode: true })
          hls.loadSource(playbackUrl); hls.attachMedia(video)
          hls.on(Hls.Events.ERROR, (_event, data) => { if (data.fatal) setPlaybackError('A playback error occurred. Please try again.') })
        }).catch(() => setPlaybackError('Could not load the HLS playback engine.'))
      }
    } else video.src = playbackUrl
    return () => { cancelled = true; hls?.destroy(); video.pause(); video.removeAttribute('src'); video.load() }
  }, [playbackUrl])

  async function startPlayback(item: Channel, episodeId?: string) {
    if (!item.id) return
    const targetEpisode = episodeId || (item.kind === 'series' ? selectedEpisodeId : '')
    if (item.kind === 'series' && !targetEpisode) { setPlaybackError('Select an episode first.'); return }
    setSelected(item)
    setPlaybackError('')
    setPlaybackUrl('')
    setPlaybackLoading(true)
    setPlaying(false)
    document.getElementById('jok-player')?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    try {
      const response = await fetch(API + '/api/playback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind: item.kind, id: item.kind === 'series' ? targetEpisode : item.id, ...(item.kind === 'series' ? { seriesId: item.id } : {}) })
      })
      const result = await response.json() as { url?: string; error?: string }
      if (!response.ok || !result.url) throw new Error(result.error || 'playback_unavailable')
      setPlaybackUrl(result.url)
      setPlaying(true)
    } catch (error) {
      const code = error instanceof Error ? error.message : 'playback_unavailable'
      const messages: Record<string,string> = {
        media_proxy_not_configured: 'Secure playback is not configured yet. Please contact the administrator.',
        provider_not_configured: 'The streaming provider is not configured.',
        redistribution_not_authorized: 'Playback is disabled until provider redistribution authorization is confirmed.',
        playback_url_generation_failed: 'The streaming proxy could not create a playback link. Check the provider stream and MediaFlow logs.'
      }
      setPlaybackError(messages[code] || 'Playback could not start. The stream may be unavailable or rejected by the provider.')
    } finally {
      setPlaybackLoading(false)
    }
  }
  async function playSelected() {
    await startPlayback(selected)
  }

  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: 'smooth' }) }, [messages])
  const categoryNames = useMemo(() => ['All', ...catalogCategories.map(category => category.name)], [catalogCategories])
  const filteredChannels = useMemo(() => activeSection === 'sports' ? channels.filter(c => /Sports|sport/i.test(c.name + ' ' + c.category)) : channels, [channels, activeSection])
  const featuredItem = useMemo(() => channels.find(c => c.kind === 'movie') || channels.find(c => c.kind === 'series') || channels[0] || emptySelection, [channels])
  const libraryPicks = useMemo(() => channels.filter(c => c.kind === 'movie' || c.kind === 'series').slice(0, 8), [channels])
  const slides = [...(discovery.sports || []).map((x:any)=>({id:x.id,title:x.title,sub:x.competition || x.sport,kind:'event',date:x.startsAt})), ...(discovery.episodes || []).map((x:any)=>({id:x.id,title:x.show,sub:x.title,kind:'episode',date:x.startsAt}))]
  const slide = slides.length ? slides[spotlightIndex % slides.length] : null
  useEffect(() => {
    if (slides.length < 2) return
    const timer = window.setInterval(() => setSpotlightIndex(i => (i + 1) % slides.length), 5000)
    return () => window.clearInterval(timer)
  }, [slides.length])

  async function syncCatalog(e: React.FormEvent) {
    e.preventDefault()
    if (syncBusy) return
    const token = adminToken.trim()
    const tokenIsAscii = token.length >= 32 && Array.from(token).every(char => {
      const code = char.charCodeAt(0)
      return code >= 33 && code <= 126
    })
    if (!tokenIsAscii) {
      setAdminMessage('Invalid admin token. Use the exact token without spaces or extra characters.')
      return
    }
    setSyncBusy(true)
    setAdminMessage('Catalog sync started in the background. You can continue using the site.')
    try {
      const headers = { Authorization: 'Bearer ' + token }
      const response = await fetch(API + '/api/admin/catalog/sync', { method: 'POST', headers })
      const initial = await response.json() as { status?: string; error?: string }
      if (!response.ok) throw new Error(initial.error || 'sync_start_failed')
      let finished = false
      let syncedTotal = 0
      while (!finished) {
        await new Promise(resolve => window.setTimeout(resolve, 1500))
        const statusResponse = await fetch(API + '/api/admin/catalog/sync/status', { headers })
        const state = await statusResponse.json() as { status?: string; stage?: string; synced?: number; error?: string }
        if (!statusResponse.ok) throw new Error(state.error || 'sync_status_failed')
        const stageLabels: Record<string, string> = {
          starting: 'Preparing sync', account_request: 'Checking provider account', account_json: 'Reading account details',
          live_download: 'Downloading live channels', live_saving: 'Saving live channels', live_completed: 'Live channels complete',
          movie_download: 'Downloading movies', movie_saving: 'Saving movies', movie_completed: 'Movies complete',
          series_download: 'Downloading series', series_saving: 'Saving series', series_completed: 'Series complete',
          completed: 'Sync complete'
        }
        syncedTotal = state.synced || syncedTotal
        setAdminMessage((stageLabels[state.stage || ''] || 'Sync in progress') + ' · ' + syncedTotal.toLocaleString('en-US'))
        if (state.status === 'failed') throw new Error(state.error || 'sync_failed')
        finished = state.status === 'completed'
      }
      setCatalogReload(value => value + 1)
      setAdminMessage('Sync completed successfully: saved  ' + syncedTotal.toLocaleString('ar') + '  items permanently.')
    } catch (error) {
      const code = error instanceof Error ? error.message : ''
      const messages: Record<string, string> = {
        unauthorized: 'Admin token is incorrect or not configured in Gateway.',
        provider_not_configured: 'Xtream credentials are incomplete in Gateway secrets.',
        provider_redistribution_authorization_required: 'Redistribution authorization is not enabled in Gateway.',
        provider_auth_failed: 'Provider credentials were rejected or are invalid.',
        provider_http_403_account: 'Provider rejected the account request (403).',
        provider_http_403_live: 'Provider rejected the live channel request (403).',
        provider_http_403_movie: 'Provider rejected the movie request (403).',
        provider_http_403_series: 'Provider rejected the series request (403).'
      }
      setAdminMessage(messages[code] || ('Sync failed (' + code + '). Check Gateway settings.'))
    } finally {
      setSyncBusy(false)
    }
  }

  async function sendMessage(e: React.FormEvent) {
    e.preventDefault()
    const message = draft.trim()
    if (!message || !nickname.trim() || !supabase || !selected.id) return
    setChatError('')
    const { error } = await supabase.from('chat_messages').insert({ channel_id: selected.id, display_name: nickname.trim().slice(0, 40), message: message.slice(0, 1000) })
    if (error) setChatError('Could not send your message. Please try again.')
    else setDraft('')
  }
  function saveName(e: React.FormEvent) {
    e.preventDefault()
    const value = nameInput.trim().slice(0, 40)
    if (!value) return
    localStorage.setItem('jokstream-nickname', value); setNickname(value)
  }

  return <div className="app-shell">
    <header className="topbar">
      <button className="mobile-menu icon-button" aria-label="Menu"><Menu /></button>
      <a className="brand" href="#" onClick={e => {e.preventDefault();setActiveSection('home')}}><span className="brand-mark"><Play fill="currentColor" size={17}/></span><span>JOK<span className="gold">STREAM</span><small>YOUR WORLD. YOUR PLAY.</small></span></a>
      <nav className="main-nav">{sections.map(item => <button key={item.id} className={activeSection === item.id ? 'nav-link active' : 'nav-link'} onClick={() => setActiveSection(item.id)}><item.icon size={16}/>{item.label}</button>)}</nav>
      <div className="top-actions"><label className="searchbox"><Search size={17}/><input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search channels, movies and series"/></label><button className="profile-button" title="Profile">{nickname ? nickname.slice(0,1).toUpperCase() : 'J'}</button></div>
    </header>

    <main className={`page jok-home section-${activeSection}`}>
      <section className="jok-hero">
        <div className="jok-hero-copy">
          <span className="hero-kicker"><i/> JOKSTREAM ORIGINAL EXPERIENCE</span>
          <span className="hero-live-label">{slide ? (slide.kind === 'event' ? 'UPCOMING EVENT' : 'NEW EPISODE') : 'YOUR LIBRARY · ' + catalogTotal.toLocaleString('en-US') + ' TITLES'}</span>
          <h1>{slide ? slide.title : featuredItem.id ? featuredItem.name : 'Entertainment, all in one place.'}</h1>
          <p>{slide ? slide.sub + ' · ' + new Date(slide.date).toLocaleString('en-US',{dateStyle:'medium',timeStyle:'short'}) : 'Discover live channels, movies and series from your synced library.'}</p>
          <div className="hero-actions">
            <button className="hero-primary" onClick={() => { if (featuredItem.id) { setSelected(featuredItem); setActiveSection(featuredItem.kind === 'movie' ? 'movies' : 'series') } document.getElementById('jok-player')?.scrollIntoView({behavior:'smooth'}) }}><Play size={17} fill="currentColor"/> Explore and watch</button>
            <button className="hero-secondary" onClick={() => {setActiveSection('live');setActiveCategory('All')}}><Radio size={17}/> Browse live TV</button>
          </div>
        </div>
        <div className="jok-hero-art"><div className="hero-orbit"/><div className="hero-play-mark"><Play fill="currentColor" size={44}/></div><span className="hero-floating one">4K</span><span className="hero-floating two">LIVE</span></div>
        <div className="hero-pagination"><i className="active"/><i/><i/><i/></div>
      </section>

      <nav className="jok-shortcuts" aria-label="Library sections">
        <button onClick={() => {setActiveSection('live');setActiveCategory('All')}}><Tv/><b>Live TV</b></button>
        <button onClick={() => {setActiveSection('movies');setActiveCategory('All')}}><Film/><b>Movies</b></button>
        <button onClick={() => {setActiveSection('series');setActiveCategory('All')}}><Clapperboard/><b>Series</b></button>
        <button onClick={() => setActiveSection('sports')}><Trophy/><b>Sports</b></button>
        <button onClick={() => {setActiveSection('home');setActiveCategory('All')}}><Globe/><b>Categories</b></button>
        <button onClick={() => setAdminMessage('Favorites will be available in a future update.')}><Star/><b>Favorites</b></button>
      </nav>

      <section className="jok-section">
        <div className="jok-section-head"><div><span className="eyebrow">DISCOVER YOUR LIBRARY</span><h2><Flame/> Picked for you</h2></div><span className="jok-section-note">Real titles from your synced catalog</span></div>
        <div className="jok-picks-grid">
          {libraryPicks.slice(0,4).map((item,index)=><button key={item.kind+'-'+item.id} className={'jok-pick-card pick-'+index} onClick={()=>{setSelected(item);setActiveSection(item.kind==='movie'?'movies':'series');window.scrollTo({top:0,behavior:'smooth'})}}><span className="pick-art"><span className="pick-art-symbol">{item.kind==='movie'?<Film size={34}/>:<Clapperboard size={34}/>}</span><span className="pick-kind">{item.kind==='movie'?'Movie':'Series'}</span><span className="pick-play"><Play fill="currentColor" size={17}/></span></span><span className="pick-info"><b>{item.name}</b><small>{item.category}</small></span></button>)}
          {libraryPicks.length===0 && <div className="jok-no-picks">Your library titles will appear here when the catalog loads.</div>}
        </div>
      </section>

      <section className="jok-section"><div className="jok-section-head"><div><span className="eyebrow">SPORTS DATA · SPORTScore</span><h2><Trophy/> Upcoming Sports</h2></div><span className="jok-section-note">Football · Basketball · Tennis · Cricket</span></div><div className="event-grid">{(discovery.sports || []).slice(0,8).map((event:any)=><article className="event-card" key={event.id}><span className="event-sport">{event.sport}</span><b>{event.title}</b><small>{event.competition || 'Fixture'}</small><time><Clock size={13}/> {new Date(event.startsAt).toLocaleString('en-US',{dateStyle:'medium',timeStyle:'short'})}</time><span className="event-channel-unverified">Broadcast channel not verified</span></article>)}</div><a className="source-credit" href="https://sportscore.com/" rel="dofollow">Powered by SportScore</a></section>
<section className="jok-section"><div className="jok-section-head"><div><span className="eyebrow">TVMAZE · EPISODE SCHEDULE</span><h2><Clapperboard/> New Episodes</h2></div></div><div className="episode-discovery-grid">{(discovery.episodes || []).slice(0,8).map((ep:any)=><article className="episode-discovery-card" key={ep.id}>{ep.image ? <img src={ep.image} alt="" loading="lazy"/> : <div className="episode-placeholder"><Clapperboard/></div>}<div><b>{ep.show}</b><span>{ep.title}</span><small>{new Date(ep.startsAt).toLocaleString('en-US',{dateStyle:'medium',timeStyle:'short'})}</small></div></article>)}</div><a className="source-credit" href="https://www.tvmaze.com/" target="_blank" rel="noreferrer">TV schedule by TVmaze · CC BY-SA</a></section><section className="jok-sports-banner">
        <div className="sports-emblem"><Trophy size={35}/></div><div><span className="eyebrow">SPORTS CENTER</span><h3>Sports Center</h3><p>Upcoming events will appear here from connected sports data sources.</p></div><span className="sports-status">Waiting for event data</span>
      </section>

      <section className="welcome-row"><div><div className="eyebrow"><span className="live-dot"/> A better way to watch</div><h1>Everything you love, <span>in one place.</span></h1><p>Explore your entertainment world and watch your way.</p></div><div className="welcome-art"><div className="orbit orbit-one"/><div className="orbit orbit-two"/><div className="art-play"><Play fill="currentColor" size={30}/></div><span className="art-star">✦</span></div></section>

      <section id="jok-player" className={expanded ? 'watch-layout expanded' : 'watch-layout'}>
        <div className="watch-main">
          <div className="section-heading"><div><span className="eyebrow">LIVE EXPERIENCE</span><h2>Watch Now</h2></div><span className="quality-pill"><span className="live-dot"/> LIVE</span></div>
          <div className="player-frame">
            <div className="player-glow"/><video ref={videoRef} className="video-player" controls playsInline style={{ display: playbackUrl ? 'block' : 'none' }} /><div className="player-content" style={{ display: playbackUrl ? 'none' : 'flex' }}><div className="player-emblem"><Play fill="currentColor" size={28}/></div><span className="player-overline">JOKSTREAM PLAYER</span><h3>{selected.name}</h3><p>Select a title and press Play Now to start its stream. The player stays visible here.</p><span className="setup-note"><Settings2 size={14}/> Secure player ready</span></div>
            <div className="player-topline"><span className="player-live"><i/> LIVE</span><span className="player-watermark">JOKSTREAM</span></div>
            <div className="player-controls"><div className="now-playing"><span className="mini-channel"><Tv size={16}/></span><span><b>{selected.name}</b><small>{selected.detail}</small></span></div><div className="control-actions"><button className="player-control" title="Volume"><Volume2 size={18}/></button><button className="player-control" title={expanded ? 'Exit fullscreen' : 'Fullscreen'} onClick={() => setExpanded(!expanded)}>{expanded ? <Minimize2 size={18}/> : <Maximize2 size={18}/>}</button></div></div>
          </div>
          <div className="below-player"><div><span className="eyebrow">NOW SELECTED</span><h3>{selected.name}</h3></div><div className="player-tools"><button className="gold-button play-button" onClick={() => void playSelected()} disabled={!selected.id || playbackLoading || (selected.kind === 'series' && !selectedEpisodeId)}><Play size={15} fill="currentColor"/> {playbackLoading ? 'Starting stream…' : playing ? 'Play Again' : 'Play Now'}</button><button className="soft-button" onClick={() => setChatVisible(!chatVisible)}>{chatVisible ? <EyeOff size={16}/> : <Eye size={16}/>} {chatVisible ? 'Hide Chat' : 'Show Chat'}</button><button className="soft-button" onClick={() => setExpanded(!expanded)}>{expanded ? <Minimize2 size={16}/> : <Maximize2 size={16}/>} {expanded ? 'Exit fullscreen' : 'Fullscreen'}</button></div></div>
          {selected.kind === 'series' && <div className="episode-list"><b>Series episodes</b>{episodes.length ? episodes.map(ep => <button key={ep.id} className={selectedEpisodeId === ep.id ? 'episode-chip active' : 'episode-chip'} onClick={() => { setSelectedEpisodeId(ep.id); setPlaybackUrl(''); setPlaying(false) }}>Season {ep.season} · {ep.title}</button>) : <span>Loading episodes or no episodes are available.</span>}</div>}{playbackLoading && <p className="playback-status">Connecting to secure stream…</p>}{playbackError && <p className="playback-error">{playbackError}</p>}
          <div className="section-heading channel-heading"><div><span className="eyebrow">BROWSE THE CATALOG</span><h2>Catalog & Categories</h2></div><button className="text-link" onClick={() => {setActiveSection('live');setActiveCategory('All')}}>All Channels <span>←</span></button></div>
          <div className="catalog-category-row" aria-label="Catalog folders">{categoryNames.map(category=><button type="button" key={category} aria-pressed={activeCategory===category} className={activeCategory===category?'category-chip active':'category-chip'} onClick={()=>setActiveCategory(category)}>{category==='All'?'All categories':category}{category!=='All' ? <small className="category-count">{catalogCategories.find(row=>row.name===category)?.count.toLocaleString('en-US') || ''}</small> : null}</button>)}</div>
          <div id="catalog-items" className="catalog-items-heading"><span className="eyebrow">FOLDER CONTENTS</span><h3>{activeCategory==='All'?'All catalog items':activeCategory}</h3><span>{(activeCategory==='All' ? catalogTotal : catalogCategories.find(row=>row.name===activeCategory)?.count || catalogTotal).toLocaleString('en-US')} items</span></div>
          {apiStatus === 'offline' && <p className="catalog-notice">Could not connect to the catalog service. Check the API URL.</p>}{apiStatus === 'ready' && !providerConfigured && <p className="catalog-notice">Service connected, but Xtream credentials are missing from server secrets.</p>}{apiStatus === 'ready' && providerConfigured && !mediaProxyConfigured && <p className="catalog-notice">Catalog connected. Configure MediaFlow in Gateway secrets to enable secure playback.</p>}{filteredChannels.length === 0 && <div className="catalog-empty"><b>{apiStatus === 'loading' ? 'Loading library…' : 'This category is empty'}</b><p>No items found in this folder. Choose another category or clear your search.</p></div>}<div className="channel-grid">{filteredChannels.map((channel, i) => <button type="button" key={channel.id} className={selected.id === channel.id ? 'channel-card chosen' : 'channel-card'} onClick={() => { setSelected(channel); setPlaybackUrl(''); setPlaybackError(''); setPlaying(false); window.scrollTo({top:0,behavior:'smooth'}) }}><span className={'channel-art '+channel.color}><span className="channel-number">{String(i+1).padStart(2,'0')}</span><span className="channel-icon"><Tv size={25}/></span><span className="channel-play"><Play fill="currentColor" size={14}/></span></span><span className="channel-meta"><b>{channel.name}</b><small>{channel.category}</small></span></button>)}</div>{hasMore && <button className="soft-button" onClick={() => void loadMoreCatalog()} disabled={loadingMore}>{loadingMore ? 'Loading…' : 'Load 60 more items'} · {(Math.max(0, catalogTotal - channels.length)).toLocaleString('en-US')} remaining</button>}
        </div>

        {chatVisible && <aside className="chat-panel"><div className="chat-header"><div className="chat-title"><span className="chat-icon"><MessageCircle size={17}/></span><span><b>Live Chat</b><small>Chat with viewers</small></span></div><button className="icon-button" onClick={() => setChatVisible(false)} title="Hide Chat"><EyeOff size={17}/></button></div><div className="chat-channel"><span className="live-dot"/><b>{selected.name}</b><span>Public chat</span></div><div className="chat-messages">{!supabase && <div className="chat-empty"><MessageCircle size={25}/><b>Chat is offline</b><p>Configure Supabase to enable chat.</p></div>}{supabase && messages.length === 0 && <div className="chat-empty"><Sparkles size={25}/><b>Start chatting</b><p>Be the first to join this channel chat.</p></div>}{messages.map(m => <div className="message" key={m.id}><span className="avatar">{m.display_name.slice(0,1)}</span><div><div className="message-head"><b>{m.display_name}</b><time>{new Date(m.created_at).toLocaleTimeString('en-US', {hour:'2-digit',minute:'2-digit'})}</time></div><p>{m.message}</p></div></div>)}<div ref={bottomRef}/></div>
          {!nickname ? <form className="nickname-form" onSubmit={saveName}><label>Choose a display name</label><input value={nameInput} onChange={e => setNameInput(e.target.value)} maxLength={40} placeholder="Display name"/><button className="gold-button" disabled={!nameInput.trim()}>Join Chat</button></form> : <form className="chat-compose" onSubmit={sendMessage}><input value={draft} onChange={e => setDraft(e.target.value)} maxLength={1000} placeholder={'Message as  '+nickname}/><button aria-label="Send" disabled={!draft.trim() || !supabase || !selected.id}><Send size={17}/></button></form>}
          {chatError && <p className="chat-error">{chatError}</p>}<div className="chat-foot">Be kind and enjoy watching. <span>✦</span></div></aside>}
      </section>

      <section className="discover-strip"><div className="discover-icon"><CalendarDays size={23}/></div><div><span className="eyebrow">SMART SPORTS & EDITORIAL</span><h3>Smart events and new releases</h3><p>Live events and new episodes are sourced from connected free feeds.</p></div><span className="discover-spark">✧</span></section>
      <footer><a className="footer-brand" href="#">JOK<span>STREAM</span></a><button className="admin-link" onClick={() => setShowAdmin(true)}>Admin Dashboard</button><span>© {new Date().getFullYear()} JokStream. All rights reserved.</span><span className="footer-status"><i/> {apiStatus === 'ready' ? 'API online' : apiStatus === 'offline' ? 'API offline' : 'Connecting'}</span></footer>
      {showAdmin && <div className="admin-backdrop" role="presentation" onClick={e => { if (e.target === e.currentTarget) setShowAdmin(false) }}><section className="admin-panel" role="dialog" aria-modal="true" aria-label="JokStream Admin"><div className="admin-panel-head"><div><span className="eyebrow">JOKSTREAM CONTROL</span><h2>Admin Dashboard</h2></div><button className="icon-button" onClick={() => setShowAdmin(false)}>×</button></div><p>Enter the admin token stored in Gateway secrets to sync your Xtream library. It is not saved in your browser.</p><form onSubmit={syncCatalog}><label>Admin Token</label><input type="password" value={adminToken} onChange={e => setAdminToken(e.target.value)} autoComplete="off" placeholder="ADMIN_API_TOKEN"/><button className="gold-button" disabled={adminToken.length < 32 || syncBusy}>{syncBusy ? "Syncing…" : "Sync Catalog"}</button></form>{adminMessage && <div className="admin-message" aria-live="polite">{adminMessage}</div>}<div className="admin-hint">Provider credentials are configured in Render Environment. Do not enter them here.</div></section></div>}
    </main>
  </div>
}
