import { useEffect, useMemo, useRef, useState } from 'react'
import { supabase } from './lib/supabase'
import { Search, Tv, Film, Clapperboard, Trophy, MessageCircle, Send, Maximize2, Minimize2, Eye, EyeOff, Play, Radio, Menu, Sparkles, Volume2, Settings2 } from 'lucide-react'

type ChatMessage = { id: number; channel_id: string; display_name: string; message: string; created_at: string }
type Channel = { id: string; name: string; category: string; detail: string; color: string; kind: 'live'|'movie'|'series' }
const API = (import.meta.env.VITE_API_BASE_URL as string | undefined)?.replace(/\/$/, '') || ''
const sections = [{ id: 'home', label: 'الرئيسية', icon: Sparkles }, { id: 'live', label: 'البث المباشر', icon: Radio }, { id: 'movies', label: 'الأفلام', icon: Film }, { id: 'series', label: 'المسلسلات', icon: Clapperboard }, { id: 'sports', label: 'الرياضة', icon: Trophy }]

export default function App() {
  const [activeSection, setActiveSection] = useState('home')
  const [selected, setSelected] = useState<Channel>({ id: '', name: 'اختر محتواك للبدء', category: 'JokStream', detail: 'المكتبة', color: 'blue', kind: 'live' })
  const [chatVisible, setChatVisible] = useState(true)
  const [expanded, setExpanded] = useState(false)
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [channels, setChannels] = useState<Channel[]>([])
  const [draft, setDraft] = useState('')
  const [nickname, setNickname] = useState(() => localStorage.getItem('jokstream-nickname') || '')
  const [nameInput, setNameInput] = useState('')
  const [search, setSearch] = useState('')
  const [chatError, setChatError] = useState('')
  const [apiStatus, setApiStatus] = useState<'loading'|'ready'|'offline'>('loading')
  const [providerConfigured, setProviderConfigured] = useState(false)
  const bottomRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let alive = true
    Promise.all([fetch(API + '/api/catalog'), fetch(API + '/api/status')]).then(async ([catalogRes, statusRes]) => {
      if (!catalogRes.ok || !statusRes.ok) throw new Error('api unavailable')
      const catalogData = await catalogRes.json() as { items?: Array<{id:string;name:string;category:string;kind:'live'|'movie'|'series'}> }
      const statusData = await statusRes.json() as { providerConfigured?: boolean }
      if (!alive) return
      const items = (catalogData.items || []).map(item => ({...item, detail: item.category, color: item.kind === 'live' ? 'blue' : item.kind === 'movie' ? 'rose' : 'violet'}))
      setProviderConfigured(Boolean(statusData.providerConfigured)); setApiStatus('ready')
      setChannels(items)
      setSelected(current => items.find(item => item.id === current.id) || items[0] || current)
    }).catch(() => { if (alive) setApiStatus('offline') })
    return () => { alive = false }
  }, [])

  useEffect(() => {
    if (!supabase || !selected.id) { setMessages([]); return }
    let alive = true
    supabase.from('chat_messages').select('id,channel_id,display_name,message,created_at').eq('channel_id', selected.id).order('created_at', { ascending: true }).limit(100)
      .then(({ data, error }) => { if (alive && !error) setMessages((data || []) as ChatMessage[]) })
    const channel = supabase.channel('jokstream-chat-' + selected.id)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'chat_messages', filter: 'channel_id=eq.' + selected.id }, payload => {
        const incoming = payload.new as ChatMessage
        setMessages(prev => prev.some(m => m.id === incoming.id) ? prev : [...prev, incoming].slice(-150))
      }).subscribe()
    return () => { alive = false; void supabase.removeChannel(channel) }
  }, [selected.id])

  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: 'smooth' }) }, [messages])
  const filteredChannels = useMemo(() => channels.filter(c => (!search.trim() || (c.name + c.category).toLocaleLowerCase().includes(search.trim().toLocaleLowerCase())) && (activeSection === 'home' || (activeSection === 'live' && c.kind === 'live') || (activeSection === 'movies' && c.kind === 'movie') || (activeSection === 'series' && c.kind === 'series') || (activeSection === 'sports' && /رياضة|sport/i.test(c.name + c.category)))), [channels, search, activeSection])

  async function sendMessage(e: React.FormEvent) {
    e.preventDefault()
    const message = draft.trim()
    if (!message || !nickname.trim() || !supabase) return
    setChatError('')
    const { error } = await supabase.from('chat_messages').insert({ channel_id: selected.id, display_name: nickname.trim().slice(0, 40), message: message.slice(0, 1000) })
    if (error) setChatError('تعذر إرسال الرسالة الآن. حاول مجدداً.')
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
      <button className="mobile-menu icon-button" aria-label="القائمة"><Menu /></button>
      <a className="brand" href="#" onClick={e => {e.preventDefault();setActiveSection('home')}}><span className="brand-mark"><Play fill="currentColor" size={17}/></span><span>JOK<span className="gold">STREAM</span><small>YOUR WORLD. YOUR PLAY.</small></span></a>
      <nav className="main-nav">{sections.map(item => <button key={item.id} className={activeSection === item.id ? 'nav-link active' : 'nav-link'} onClick={() => setActiveSection(item.id)}><item.icon size={16}/>{item.label}</button>)}</nav>
      <div className="top-actions"><label className="searchbox"><Search size={17}/><input value={search} onChange={e => setSearch(e.target.value)} placeholder="ابحث عن قناة أو محتوى"/></label><button className="profile-button" title="الملف الشخصي">{nickname ? nickname.slice(0,1).toUpperCase() : 'ز'}</button></div>
    </header>

    <main className="page">
      <section className="welcome-row"><div><div className="eyebrow"><span className="live-dot"/> تجربة مشاهدة مختلفة</div><h1>كل ما تحب، <span>في مكان واحد.</span></h1><p>اكتشف عالمك الترفيهي واستمتع بالمشاهدة بطريقتك.</p></div><div className="welcome-art"><div className="orbit orbit-one"/><div className="orbit orbit-two"/><div className="art-play"><Play fill="currentColor" size={30}/></div><span className="art-star">✦</span></div></section>

      <section className={expanded ? 'watch-layout expanded' : 'watch-layout'}>
        <div className="watch-main">
          <div className="section-heading"><div><span className="eyebrow">LIVE EXPERIENCE</span><h2>شاهد الآن</h2></div><span className="quality-pill"><span className="live-dot"/> مباشر</span></div>
          <div className="player-frame">
            <div className="player-glow"/><div className="player-content"><div className="player-emblem"><Play fill="currentColor" size={28}/></div><span className="player-overline">JOKSTREAM PLAYER</span><h3>{selected.name}</h3><p>سيظهر البث بعد ربط وسيط البث المعتمد.</p><span className="setup-note"><Settings2 size={14}/> المشغل جاهز للربط بالوسيط</span></div>
            <div className="player-topline"><span className="player-live"><i/> LIVE</span><span className="player-watermark">JOKSTREAM</span></div>
            <div className="player-controls"><div className="now-playing"><span className="mini-channel"><Tv size={16}/></span><span><b>{selected.name}</b><small>{selected.detail}</small></span></div><div className="control-actions"><button className="player-control" title="الصوت"><Volume2 size={18}/></button><button className="player-control" title={expanded ? 'تصغير المشغل' : 'تكبير المشغل'} onClick={() => setExpanded(!expanded)}>{expanded ? <Minimize2 size={18}/> : <Maximize2 size={18}/>}</button></div></div>
          </div>
          <div className="below-player"><div><span className="eyebrow">NOW SELECTED</span><h3>{selected.name}</h3></div><div className="player-tools"><button className="soft-button" onClick={() => setChatVisible(!chatVisible)}>{chatVisible ? <EyeOff size={16}/> : <Eye size={16}/>} {chatVisible ? 'إخفاء الدردشة' : 'إظهار الدردشة'}</button><button className="soft-button" onClick={() => setExpanded(!expanded)}>{expanded ? <Minimize2 size={16}/> : <Maximize2 size={16}/>} {expanded ? 'تصغير المشغل' : 'تكبير المشغل'}</button></div></div>
          <div className="section-heading channel-heading"><div><span className="eyebrow">PICK YOUR CHANNEL</span><h2>القنوات</h2></div><button className="text-link" onClick={() => setActiveSection('live')}>عرض الكل <span>←</span></button></div>
          {apiStatus === 'offline' && <p className="catalog-notice">تعذر الاتصال بخدمة الكتالوج. تحقق من عنوان API.</p>}{apiStatus === 'ready' && !providerConfigured && <p className="catalog-notice">الخدمة متصلة، لكن بيانات Xtream لم تُضف بعد إلى أسرار الخادم.</p>}{filteredChannels.length === 0 && <div className="catalog-empty"><b>{apiStatus === 'loading' ? 'جارٍ تحميل المكتبة…' : 'مكتبتك بانتظار الربط'}</b><p>ستظهر القنوات والأفلام والمسلسلات الحقيقية بعد إعداد بيانات المزود ومزامنة الكتالوج.</p></div>}<div className="channel-grid">{filteredChannels.map((channel, i) => <button key={channel.id} className={selected.id === channel.id ? 'channel-card chosen' : 'channel-card'} onClick={() => setSelected(channel)}><span className={'channel-art '+channel.color}><span className="channel-number">0{i+1}</span><span className="channel-icon"><Tv size={25}/></span><span className="channel-play"><Play fill="currentColor" size={14}/></span></span><span className="channel-meta"><b>{channel.name}</b><small>{channel.category}</small></span></button>)}</div>
        </div>

        {chatVisible && <aside className="chat-panel"><div className="chat-header"><div className="chat-title"><span className="chat-icon"><MessageCircle size={17}/></span><span><b>دردشة القناة</b><small>تفاعل مع المشاهدين</small></span></div><button className="icon-button" onClick={() => setChatVisible(false)} title="إخفاء الدردشة"><EyeOff size={17}/></button></div><div className="chat-channel"><span className="live-dot"/><b>{selected.name}</b><span>محادثة عامة</span></div><div className="chat-messages">{!supabase && <div className="chat-empty"><MessageCircle size={25}/><b>الدردشة غير متصلة</b><p>أضف إعدادات Supabase في ملف البيئة لتفعيل الدردشة.</p></div>}{supabase && messages.length === 0 && <div className="chat-empty"><Sparkles size={25}/><b>ابدأ التفاعل</b><p>كن أول من يشارك في دردشة هذه القناة.</p></div>}{messages.map(m => <div className="message" key={m.id}><span className="avatar">{m.display_name.slice(0,1)}</span><div><div className="message-head"><b>{m.display_name}</b><time>{new Date(m.created_at).toLocaleTimeString('ar', {hour:'2-digit',minute:'2-digit'})}</time></div><p>{m.message}</p></div></div>)}<div ref={bottomRef}/></div>
          {!nickname ? <form className="nickname-form" onSubmit={saveName}><label>اختر اسماً للمشاركة</label><input value={nameInput} onChange={e => setNameInput(e.target.value)} maxLength={40} placeholder="اسم العرض"/><button className="gold-button" disabled={!nameInput.trim()}>دخول الدردشة</button></form> : <form className="chat-compose" onSubmit={sendMessage}><input value={draft} onChange={e => setDraft(e.target.value)} maxLength={1000} placeholder={'اكتب رسالة باسم '+nickname}/><button aria-label="إرسال" disabled={!draft.trim() || !supabase}><Send size={17}/></button></form>}
          {chatError && <p className="chat-error">{chatError}</p>}<div className="chat-foot">كن لطيفاً واستمتع بالمشاهدة <span>✦</span></div></aside>}
      </section>

      <section className="discover-strip"><div className="discover-icon"><Trophy size={23}/></div><div><span className="eyebrow">COMING TO YOUR HOME</span><h3>ليلتك تستحق مشاهدة استثنائية</h3><p>سنضيف الفعاليات والمحتوى المتاح فور ربط مكتبة مزود الخدمة.</p></div><span className="discover-spark">✧</span></section>
      <footer><a className="footer-brand" href="#">JOK<span>STREAM</span></a><span>© {new Date().getFullYear()} JokStream. جميع الحقوق محفوظة.</span><span className="footer-status"><i/> {apiStatus === 'ready' ? 'API متصل' : apiStatus === 'offline' ? 'API غير متصل' : 'جارٍ الاتصال'}</span></footer>
    </main>
  </div>
}
