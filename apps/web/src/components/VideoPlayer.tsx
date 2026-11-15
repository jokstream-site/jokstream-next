import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react'
import Hls from 'hls.js'
import { AlertCircle, Maximize, Pause, Play, RotateCcw, Volume2, VolumeX } from 'lucide-react'

type PlaybackState = 'connecting' | 'playing' | 'failed'
type VideoPlayerProps = {
  src: string
  title?: string
  autoPlay?: boolean
  className?: string
  onStateChange?: (state: PlaybackState, reason?: string) => void
}

const WATCHDOG_MS = 15_000
const RETRY_DELAY_MS = 2_000
const MAX_AUTO_RETRIES = 3
const DEFAULT_MEDIAFLOW_URL = 'https://jokstream-mediaflow.onrender.com'

function resolvePlayableUrl(input: string) {
  const streamUrl = input.trim()
  if (!streamUrl) throw new Error('No stream URL was provided')
  let parsed: URL
  try {
    parsed = new URL(streamUrl, window.location.href)
  } catch {
    throw new Error('Invalid stream URL')
  }
  if (window.location.protocol === 'https:' && parsed.protocol === 'http:') {
    const base = ((import.meta.env.VITE_MEDIAFLOW_URL as string | undefined) || DEFAULT_MEDIAFLOW_URL).replace(/\/+$/, '')
    return base + '/proxy/hls/manifest.m3u8?d=' + encodeURIComponent(parsed.href)
  }
  return parsed.href
}

function errorMessage(error: unknown) {
  return error instanceof Error && error.message ? error.message : 'Playback failed'
}
function formatTime(seconds: number) {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00'
  return Math.floor(seconds / 60) + ':' + Math.floor(seconds % 60).toString().padStart(2, '0')
}

export default function VideoPlayer({
  src, title, autoPlay = true, className = '', onStateChange,
}: VideoPlayerProps) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const hlsRef = useRef<Hls | null>(null)
  const watchdogRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const attemptRef = useRef(0)
  const generationRef = useRef(0)

  const [state, setState] = useState<PlaybackState>('connecting')
  const [reason, setReason] = useState('')
  const [retryCount, setRetryCount] = useState(0)
  const [muted, setMuted] = useState(false)
  const [volume, setVolume] = useState(1)
  const [paused, setPaused] = useState(!autoPlay)
  const [currentTime, setCurrentTime] = useState(0)
  const [duration, setDuration] = useState(0)
  const [buffered, setBuffered] = useState(0)

  const clearTimers = useCallback(() => {
    if (watchdogRef.current) clearTimeout(watchdogRef.current)
    if (retryTimerRef.current) clearTimeout(retryTimerRef.current)
    watchdogRef.current = null
    retryTimerRef.current = null
  }, [])

  const publishState = useCallback((next: PlaybackState, message = '') => {
    setState(next)
    setReason(message)
    onStateChange?.(next, message || undefined)
  }, [onStateChange])

  const teardown = useCallback(() => {
    clearTimers()
    const video = videoRef.current
    if (hlsRef.current) {
      hlsRef.current.stopLoad()
      hlsRef.current.detachMedia()
      hlsRef.current.destroy()
      hlsRef.current = null
    }
    if (video) {
      video.pause()
      video.removeAttribute('src')
      video.querySelectorAll('source').forEach(source => source.removeAttribute('src'))
      video.load()
    }
  }, [clearTimers])

  const startAttempt = useCallback((generation: number) => {
    const video = videoRef.current
    if (!video || generation !== generationRef.current) return
    if (!src.trim()) {
      publishState('failed', 'No stream URL was provided')
      return
    }
    clearTimers()
    if (hlsRef.current) {
      hlsRef.current.stopLoad()
      hlsRef.current.detachMedia()
      hlsRef.current.destroy()
      hlsRef.current = null
    }
    video.pause()
    video.removeAttribute('src')
    video.load()

    const attemptNumber = attemptRef.current + 1
    attemptRef.current = attemptNumber
    setRetryCount(Math.max(0, attemptNumber - 1))
    setCurrentTime(0)
    setDuration(0)
    setBuffered(0)
    setPaused(!autoPlay)
    publishState('connecting')

    let playableUrl: string
    try {
      playableUrl = resolvePlayableUrl(src)
    } catch (error) {
      publishState('failed', errorMessage(error))
      return
    }

    const fail = (message: string) => {
      if (generation !== generationRef.current) return
      clearTimers()
      if (attemptRef.current <= MAX_AUTO_RETRIES) {
        publishState('connecting', message)
        retryTimerRef.current = setTimeout(() => {
          if (generation === generationRef.current) startAttempt(generation)
        }, RETRY_DELAY_MS)
      } else {
        publishState('failed', message)
      }
    }

    watchdogRef.current = setTimeout(() => fail('Connection timed out (15s)'), WATCHDOG_MS)
    const isHls = /\.m3u8(?:$|[?#])/i.test(playableUrl)

    if (isHls && Hls.isSupported()) {
      const hls = new Hls({
        enableWorker: true,
        lowLatencyMode: true,
        backBufferLength: 30,
        manifestLoadingTimeOut: WATCHDOG_MS,
        levelLoadingTimeOut: WATCHDOG_MS,
        fragLoadingTimeOut: WATCHDOG_MS,
        manifestLoadingMaxRetry: 0,
        levelLoadingMaxRetry: 0,
        fragLoadingMaxRetry: 0,
      })
      hlsRef.current = hls
      hls.on(Hls.Events.ERROR, (_event, data) => {
        if (!data.fatal || generation !== generationRef.current) return
        const status = data.response?.code
        if (status === 404) fail('Stream offline (404)')
        else if (status) fail('Stream request failed (' + status + ')')
        else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) fail('Format unsupported')
        else if (data.type === Hls.ErrorTypes.NETWORK_ERROR) fail('Network error — stream unavailable')
        else fail(data.details ? 'Playback error: ' + data.details : 'Playback failed')
      })
      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        if (generation !== generationRef.current || !autoPlay) return
        void video.play().catch(() => setPaused(true))
      })
      hls.attachMedia(video)
      hls.loadSource(playableUrl)
    } else if (isHls && video.canPlayType('application/vnd.apple.mpegurl')) {
      video.src = playableUrl
      video.load()
      if (autoPlay) void video.play().catch(() => setPaused(true))
    } else if (isHls) {
      fail('Format unsupported')
    } else {
      video.src = playableUrl
      video.load()
      if (autoPlay) void video.play().catch(() => setPaused(true))
    }
  }, [autoPlay, clearTimers, publishState, src])

  useEffect(() => {
    const generation = ++generationRef.current
    attemptRef.current = 0
    setRetryCount(0)
    setReason('')
    startAttempt(generation)
    return () => {
      generationRef.current += 1
      teardown()
    }
  }, [src, startAttempt, teardown])

  useEffect(() => {
    const video = videoRef.current
    if (!video) return
    const onPlaying = () => {
      clearTimers()
      setPaused(false)
      publishState('playing')
    }
    const onPause = () => setPaused(true)
    const onPlay = () => setPaused(false)
    const onTime = () => {
      setCurrentTime(video.currentTime || 0)
      if (Number.isFinite(video.duration)) setDuration(video.duration)
      if (video.buffered.length) setBuffered(video.buffered.end(video.buffered.length - 1))
    }
    const onError = () => {
      const code = video.error?.code
      if (!code) return
      const message = code === MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED
        ? 'Format unsupported'
        : code === MediaError.MEDIA_ERR_NETWORK
          ? 'Network error — stream unavailable'
          : code === MediaError.MEDIA_ERR_DECODE
            ? 'Format unsupported (decode error)'
            : 'Unable to load stream'
      clearTimers()
      const generation = generationRef.current
      if (attemptRef.current <= MAX_AUTO_RETRIES) {
        publishState('connecting', message)
        retryTimerRef.current = setTimeout(() => startAttempt(generation), RETRY_DELAY_MS)
      } else publishState('failed', message)
    }
    video.addEventListener('playing', onPlaying)
    video.addEventListener('pause', onPause)
    video.addEventListener('play', onPlay)
    video.addEventListener('timeupdate', onTime)
    video.addEventListener('durationchange', onTime)
    video.addEventListener('progress', onTime)
    video.addEventListener('error', onError)
    return () => {
      video.removeEventListener('playing', onPlaying)
      video.removeEventListener('pause', onPause)
      video.removeEventListener('play', onPlay)
      video.removeEventListener('timeupdate', onTime)
      video.removeEventListener('durationchange', onTime)
      video.removeEventListener('progress', onTime)
      video.removeEventListener('error', onError)
    }
  }, [clearTimers, publishState, startAttempt])

  const manualRetry = () => {
    attemptRef.current = 0
    setRetryCount(0)
    setReason('')
    startAttempt(generationRef.current)
  }
  const togglePlay = () => {
    const video = videoRef.current
    if (!video) return
    if (video.paused) void video.play().catch(error => publishState('failed', errorMessage(error)))
    else video.pause()
  }
  const toggleMute = () => {
    const video = videoRef.current
    if (!video) return
    video.muted = !video.muted
    setMuted(video.muted)
  }
  const changeVolume = (next: number) => {
    const video = videoRef.current
    if (!video) return
    video.volume = next
    video.muted = next === 0
    setVolume(next)
    setMuted(video.muted)
  }
  const seek = (next: number) => {
    const video = videoRef.current
    if (video && Number.isFinite(video.duration)) {
      video.currentTime = next
      setCurrentTime(next)
    }
  }
  const fullscreen = () => {
    const target = videoRef.current?.parentElement
    if (!target) return
    if (document.fullscreenElement) void document.exitFullscreen()
    else void target.requestFullscreen?.()
  }

  const progress = duration > 0 ? currentTime / duration * 100 : 0
  const bufferedProgress = duration > 0 ? buffered / duration * 100 : 0

  return (
    <div
      className={'relative isolate aspect-video w-full overflow-hidden bg-black text-white ' + className}
      style={{ '--player-accent': '#E50914' } as CSSProperties}
      aria-label={title ? 'Video player: ' + title : 'Video player'}
    >
      <video ref={videoRef} className="h-full w-full bg-black object-contain" playsInline preload="auto" controls={false} aria-label={title || 'Video'} />

      {state !== 'playing' && (
        <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 bg-[#05060a]/90 px-6 text-center">
          {state === 'connecting' ? (
            <>
              <span className="h-10 w-10 animate-spin rounded-full border-[3px] border-white/20 border-t-[#E50914]" />
              <strong className="text-sm font-semibold tracking-wide">Connecting...</strong>
              {reason && <span className="max-w-md text-xs text-white/50">{reason}</span>}
              <span className="text-[11px] text-white/35">Attempt {Math.min(retryCount + 1, MAX_AUTO_RETRIES + 1)} of {MAX_AUTO_RETRIES + 1}</span>
            </>
          ) : (
            <>
              <AlertCircle className="h-10 w-10 text-red-400" />
              <strong className="text-sm font-semibold">Playback failed</strong>
              <span className="max-w-md text-sm text-red-200">{reason || 'Stream unavailable'}</span>
              <button type="button" onClick={manualRetry} className="mt-2 inline-flex items-center gap-2 rounded-lg bg-[#E50914] px-5 py-2.5 text-sm font-bold transition hover:bg-red-700">
                <RotateCcw size={16} /> Retry
              </button>
            </>
          )}
        </div>
      )}

      <div className="absolute inset-x-0 bottom-0 z-20 bg-gradient-to-t from-black/95 via-black/55 to-transparent px-4 pb-3 pt-10">
        <div className="mb-3 flex items-center gap-3">
          <span className="text-[11px] tabular-nums text-white/75">{formatTime(currentTime)}</span>
          <div className="relative h-1 flex-1 rounded-full bg-white/20">
            <div className="absolute inset-y-0 left-0 rounded-full bg-white/25" style={{ width: Math.min(bufferedProgress, 100) + '%' }} />
            <div className="absolute inset-y-0 left-0 rounded-full bg-[#E50914]" style={{ width: Math.min(progress, 100) + '%' }} />
            <input aria-label="Seek" type="range" min={0} max={duration || 0} step={0.1} value={Math.min(currentTime, duration || 0)} onChange={event => seek(Number(event.target.value))} className="absolute -top-2 h-5 w-full cursor-pointer opacity-0" />
          </div>
          <span className="text-[11px] tabular-nums text-white/75">{formatTime(duration)}</span>
        </div>
        <div className="flex items-center gap-3">
          <button type="button" onClick={togglePlay} aria-label={paused ? 'Play' : 'Pause'} className="rounded p-1.5 hover:bg-white/10">
            {paused ? <Play size={19} fill="currentColor" /> : <Pause size={19} />}
          </button>
          <button type="button" onClick={toggleMute} aria-label={muted ? 'Unmute' : 'Mute'} className="rounded p-1.5 hover:bg-white/10">
            {muted || volume === 0 ? <VolumeX size={18} /> : <Volume2 size={18} />}
          </button>
          <input aria-label="Volume" type="range" min={0} max={1} step={0.05} value={muted ? 0 : volume} onChange={event => changeVolume(Number(event.target.value))} className="w-20 accent-[#E50914]" />
          <span className="min-w-0 flex-1 truncate text-xs font-medium text-white/75">{title || ''}</span>
          <button type="button" onClick={fullscreen} aria-label="Fullscreen" className="rounded p-1.5 hover:bg-white/10"><Maximize size={18} /></button>
        </div>
      </div>
    </div>
  )
}
