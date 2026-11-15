import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { X, Send, Users, MessageCircle, UserRound, LoaderCircle } from 'lucide-react'
import VideoPlayer from './VideoPlayer'
import { supabase } from '../lib/supabase'

type Channel = {
  id: string | number
  name: string
  streamUrl: string
}

type ChatMessage = {
  id: string
  channel_id: string
  nickname: string
  content: string
  created_at: string
}

type WatchChannelModalProps = {
  channel: Channel
  onClose: () => void
}

const NICKNAME_KEY = 'jokstream_chat_nickname'
const MAX_MESSAGE_LENGTH = 500

function getSessionNickname() {
  try {
    return window.sessionStorage.getItem(NICKNAME_KEY) || ''
  } catch {
    return ''
  }
}

function saveSessionNickname(value: string) {
  try {
    window.sessionStorage.setItem(NICKNAME_KEY, value)
  } catch {
    // Private browsing policies may disable sessionStorage; nickname still works in memory.
  }
}

function formatMessageTime(value: string) {
  return new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

export default function WatchChannelModal({ channel, onClose }: WatchChannelModalProps) {
  const channelId = String(channel.id)
  const [nickname, setNickname] = useState(getSessionNickname)
  const [nicknameDraft, setNicknameDraft] = useState(getSessionNickname)
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [messageDraft, setMessageDraft] = useState('')
  const [viewerCount, setViewerCount] = useState(0)
  const [chatLoading, setChatLoading] = useState(true)
  const [chatError, setChatError] = useState('')
  const [sending, setSending] = useState(false)
  const [presenceReady, setPresenceReady] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)
  const visitorKey = useMemo(() => {
    try {
      return window.crypto?.randomUUID?.() || 'guest-' + Math.random().toString(36).slice(2)
    } catch {
      return 'guest-' + Math.random().toString(36).slice(2)
    }
  }, [])

  const close = useCallback(() => onClose(), [onClose])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close()
    }
    window.addEventListener('keydown', onKeyDown)
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      document.body.style.overflow = previousOverflow
    }
  }, [close])

  // Presence is scoped to the exact channel ID. A tracked client is counted once
  // even if the same browser has multiple presence payloads in the room.
  useEffect(() => {
    if (!supabase) return
    let active = true
    const room = supabase.channel('room:' + channelId, {
      config: { presence: { key: visitorKey } },
    })

    const updateCount = () => {
      const presence = room.presenceState<Record<string, unknown>>()
      const count = Object.values(presence).reduce((sum, entries) => sum + entries.length, 0)
      if (active) setViewerCount(count)
    }

    room
      .on('presence', { event: 'sync' }, updateCount)
      .subscribe(async status => {
        if (status !== 'SUBSCRIBED' || !active) return
        const result = await room.track({
          visitor: visitorKey,
          joined_at: new Date().toISOString(),
        })
        if (!active) return
        if (result === 'ok') {
          setPresenceReady(true)
          updateCount()
        }
      })

    return () => {
      active = false
      setPresenceReady(false)
      // untrack before removal so other viewers receive the leave event promptly.
      void room.untrack().finally(() => {
        void supabase.removeChannel(room)
      })
    }
  }, [channelId, visitorKey])

  // Load the most recent 50 messages, then listen for new messages in this room.
  useEffect(() => {
    if (!supabase) {
      setChatError('Chat is not configured. Add the Supabase URL and publishable key.')
      setChatLoading(false)
      return
    }

    let active = true
    setMessages([])
    setChatLoading(true)
    setChatError('')
    const room = supabase
      .channel('chat:' + channelId)
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'channel_messages',
          filter: 'channel_id=eq.' + channelId,
        },
        payload => {
          if (!active) return
          const incoming = payload.new as ChatMessage
          setMessages(current => current.some(item => item.id === incoming.id)
            ? current
            : [...current, incoming].slice(-50))
        },
      )
      .subscribe()

    void supabase
      .from('channel_messages')
      .select('id,channel_id,nickname,content,created_at')
      .eq('channel_id', channelId)
      .order('created_at', { ascending: false })
      .limit(50)
      .then(({ data, error }) => {
        if (!active) return
        if (error) setChatError(error.message)
        else {
          const history = (data || []).reverse() as ChatMessage[]
          setMessages(current => [...history, ...current]
            .filter((item, index, all) => all.findIndex(candidate => candidate.id === item.id) === index)
            .slice(-50))
        }
        setChatLoading(false)
      })

    return () => {
      active = false
      void supabase.removeChannel(room)
    }
  }, [channelId])

  useEffect(() => {
    const container = scrollRef.current
    if (container) container.scrollTop = container.scrollHeight
  }, [messages])

  const chooseNickname = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const cleaned = nicknameDraft.trim().replace(/\s+/g, ' ').slice(0, 24)
    if (!cleaned) return
    saveSessionNickname(cleaned)
    setNickname(cleaned)
  }

  const sendMessage = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const content = messageDraft.trim()
    if (!supabase || !nickname || !content || sending) return
    if (content.length > MAX_MESSAGE_LENGTH) {
      setChatError('Messages must be 500 characters or fewer.')
      return
    }
    setSending(true)
    setChatError('')
    const { error } = await supabase.from('channel_messages').insert({
      channel_id: channelId,
      nickname,
      content,
    })
    if (error) setChatError(error.message)
    else setMessageDraft('')
    setSending(false)
  }

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/90 p-0 backdrop-blur-sm sm:p-4"
      role="dialog"
      aria-modal="true"
      aria-label={'Watch ' + channel.name}
      onMouseDown={event => {
        if (event.target === event.currentTarget) close()
      }}
    >
      <section className="flex h-full w-full max-w-6xl flex-col overflow-hidden bg-[#0b0c12] text-white sm:h-[min(94vh,900px)] sm:rounded-2xl sm:border sm:border-white/10 sm:shadow-2xl">
        <header className="flex shrink-0 items-center justify-between gap-3 border-b border-white/10 px-4 py-3 sm:px-5">
          <div className="min-w-0">
            <p className="text-[10px] font-bold tracking-[.22em] text-[#e50914]">JOKSTREAM · LIVE</p>
            <h2 className="truncate text-base font-bold sm:text-lg">{channel.name}</h2>
          </div>
          <button type="button" onClick={close} aria-label="Close player and chat" className="rounded-full p-2 text-white/65 hover:bg-white/10 hover:text-white">
            <X size={21} />
          </button>
        </header>

        <div className="shrink-0 border-b border-white/10 bg-black">
          <VideoPlayer src={channel.streamUrl} title={channel.name} autoPlay className="max-h-[52vh]" />
        </div>

        <div className="flex min-h-0 flex-1 flex-col">
          <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-white/10 bg-[#11131c] px-4 py-3 sm:px-5">
            <div className="flex items-center gap-2">
              <MessageCircle size={17} className="text-[#e50914]" />
              <h3 className="text-sm font-bold">Channel Live Chat</h3>
              <span className="rounded-full bg-white/5 px-2 py-1 text-[10px] text-white/45">Room #{channelId}</span>
            </div>
            <div className="flex items-center gap-1.5 rounded-full border border-emerald-400/20 bg-emerald-400/10 px-3 py-1.5 text-xs font-semibold text-emerald-300">
              <span className="h-2 w-2 rounded-full bg-emerald-400" />
              <Users size={13} />
              {presenceReady ? viewerCount.toLocaleString() : '—'} Watching Now
            </div>
          </div>

          <div ref={scrollRef} className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-4 sm:px-5">
            {chatLoading ? (
              <div className="grid h-full min-h-24 place-items-center text-white/40"><LoaderCircle className="animate-spin" size={20} /></div>
            ) : messages.length ? messages.map(message => (
              <article key={message.id} className="flex gap-3">
                <div className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-white/10 text-white/55"><UserRound size={15} /></div>
                <div className="min-w-0 flex-1 rounded-xl bg-white/[.045] px-3 py-2">
                  <div className="mb-1 flex items-center gap-2">
                    <b className="truncate text-xs text-white/90">{message.nickname}</b>
                    <time className="text-[10px] text-white/30">{formatMessageTime(message.created_at)}</time>
                  </div>
                  <p className="break-words text-sm leading-6 text-white/75">{message.content}</p>
                </div>
              </article>
            )) : (
              <div className="grid h-full min-h-24 place-items-center text-center text-xs text-white/35">
                No messages yet. Start the conversation for this channel.
              </div>
            )}
          </div>

          {chatError && <p role="alert" className="shrink-0 px-4 pb-2 text-xs text-red-300 sm:px-5">{chatError}</p>}

          {!nickname ? (
            <form onSubmit={chooseNickname} className="flex shrink-0 gap-2 border-t border-white/10 bg-[#11131c] p-3 sm:p-4">
              <input
                value={nicknameDraft}
                onChange={event => setNicknameDraft(event.target.value)}
                maxLength={24}
                placeholder="Choose a display name"
                aria-label="Display name"
                className="min-w-0 flex-1 rounded-xl border border-white/10 bg-black/30 px-4 py-3 text-sm outline-none placeholder:text-white/30 focus:border-[#e50914]/70"
              />
              <button type="submit" disabled={!nicknameDraft.trim()} className="rounded-xl bg-[#e50914] px-4 py-3 text-sm font-bold disabled:opacity-40">Join Chat</button>
            </form>
          ) : (
            <form onSubmit={sendMessage} className="flex shrink-0 items-center gap-2 border-t border-white/10 bg-[#11131c] p-3 sm:p-4">
              <div className="hidden max-w-28 truncate text-xs text-white/45 sm:block" title={nickname}>As {nickname}</div>
              <input
                value={messageDraft}
                onChange={event => setMessageDraft(event.target.value)}
                maxLength={MAX_MESSAGE_LENGTH}
                placeholder="Message this channel…"
                aria-label="Chat message"
                className="min-w-0 flex-1 rounded-xl border border-white/10 bg-black/30 px-4 py-3 text-sm outline-none placeholder:text-white/30 focus:border-[#e50914]/70"
              />
              <button type="submit" disabled={!messageDraft.trim() || sending} aria-label="Send message" className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-[#e50914] disabled:opacity-40">
                {sending ? <LoaderCircle size={18} className="animate-spin" /> : <Send size={17} />}
              </button>
            </form>
          )}
        </div>
      </section>
    </div>
  )
}
