import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react'
import Hls from 'hls.js'
import mpegts from 'mpegts.js'
import { AlertCircle, Maximize, Pause, Play, RotateCcw, Volume2, VolumeX } from 'lucide-react'

type PlaybackState = 'connecting' | 'playing' | 'failed'
type VideoPlayerProps = {
  src: string
  fallbackSrc?: string
  streamType?: 'live' | 'movie' | 'series'
  title?: string
  autoPlay?: boolean
  className?: string
  onStateChange?: (state: PlaybackState, reason?: string) => void
}

const WATCHDOG_MS = 15_000
const RETRY_DELAY_MS = 2_000
const MAX_AUTO_RETRIES = 2

function resolvePlayableUrl(input: string) {
  const streamUrl = input.trim()
  if (!streamUrl) throw new Error('No stream URL was provided')
  let parsed: URL
  try {
    parsed = new URL(streamUrl, window.location.href)
  } catch {
    throw new Error('Invalid stream URL')
  }
  if (window.location.protocol === 'https:' && parsed.protocol !== 'https:') {
    throw new Error('Playback URL must use HTTPS and be issued by the Gateway')
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

const HTTP_REASONS: Record<number, string> = {
  401: 'This subscription is not authorised for that stream.',
  403: 'The provider refused this stream for the subscription.',
  404: 'The stream was not found or is offline.',
  429: 'The provider is rate-limiting this connection.',
  500: 'The upstream server failed while starting the stream.',
  502: 'The upstream source did not answer (502).',
  503: 'No upstream server is currently able to play this stream.',
  504: 'The upstream source timed out (504).',
}

function httpStatusMessage(status: number) {
  return HTTP_REASONS[status] || `The stream request failed (HTTP ${status}).`
}

// Probe only after a media error, and only through our same-origin Gateway.
// Deliberately do not send Range: it is not CORS-safelisted and can trigger
// a preflight against provider/CDN redirects. Cancel the body as soon as the
// response headers arrive so this diagnostic never downloads a second stream.
async function probeHttpStatus(input: string): Promise<number> {
  try {
    const target = new URL(input, window.location.href)
    if (target.origin !== window.location.origin) return 0
    const response = await fetch(target.href, {
      method: 'GET',
      credentials: 'same-origin',
      cache: 'no-store',
    })
    const status = response.status
    try { await response.body?.cancel() } catch { /* response already closed */ }
    return status
  } catch {
    return 0
  }
}

export default function VideoPlayer({
  src, fallbackSrc, streamType, title, autoPlay = true, className = '', onStateChange,
}: VideoPlayerProps) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const hlsRef = useRef<Hls | null>(null)
  const mpegtsRef = useRef<ReturnType<typeof mpegts.createPlayer> | null>(null)
  const watchdogRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const attemptRef = useRef(0)
  const sourceIndexRef = useRef(0)
  const failCurrentAttemptRef = useRef<(message: string) => void>(() => {})
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
    if (mpegtsRef.current) {
      mpegtsRef.current.pause()
      mpegtsRef.current.unload()
      mpegtsRef.current.detachMediaElement()
      mpegtsRef.current.destroy()
      mpegtsRef.current = null
    }
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
    const activeSrc = sourceIndexRef.current === 1 && fallbackSrc ? fallbackSrc : src
    if (!activeSrc.trim()) {
      publishState('failed', 'No stream URL was provided')
      return
    }
    clearTimers()
    if (mpegtsRef.current) {
      mpegtsRef.current.pause()
      mpegtsRef.current.unload()
      mpegtsRef.current.detachMediaElement()
      mpegtsRef.current.destroy()
      mpegtsRef.current = null
    }
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
      playableUrl = resolvePlayableUrl(activeSrc)
    } catch (error) {
      publishState('failed', errorMessage(error))
      return
    }

    let failed = false
    const fail = (message: string) => {
      if (failed || generation !== generationRef.current) return
      failed = true
      clearTimers()
      if (attemptRef.current <= MAX_AUTO_RETRIES) {
        if (streamType === 'live' && fallbackSrc) {
          sourceIndexRef.current = sourceIndexRef.current === 0 ? 1 : 0
        }
        publishState('connecting', message)
        retryTimerRef.current = setTimeout(() => {
          if (generation === generationRef.current) startAttempt(generation)
        }, RETRY_DELAY_MS)
      } else {
        publishState('failed', message)
      }
    }
    failCurrentAttemptRef.current = fail

    watchdogRef.current = setTimeout(() => fail('Connection timed out (15s)'), WATCHDOG_MS)
    const sourceUrl = new URL(activeSrc, window.location.href)
    const isMpegTs = sourceUrl.searchParams.get('format') === 'mpegts' || /\.ts(?:$|[?#])/i.test(sourceUrl.pathname)
    const isHls = sourceUrl.searchParams.get('format') === 'hls' || /\.m3u8(?:$|[?#])/i.test(sourceUrl.pathname) || /\.m3u8(?:$|[?#])/i.test(playableUrl)

    if (isMpegTs && mpegts.isSupported()) {
      const player = mpegts.createPlayer({
        type: 'mpegts',
        url: playableUrl,
        isLive: streamType === 'live',
        hasAudio: true,
        hasVideo: true,
      }, {
        enableWorker: true,
        enableStashBuffer: true,
        stashInitialSize: 128 * 1024,
        liveBufferLatencyChasing: true,
        liveBufferLatencyMaxLatency: 8,
        liveBufferLatencyMinRemain: 2,
      })
      mpegtsRef.current = player
      player.on(mpegts.Events.ERROR, (_type, detail) => {
        if (generation !== generationRef.current) return
        void probeHttpStatus(activeSrc).then(status => {
          if (generation !== generationRef.current) return
          fail(status >= 400 ? httpStatusMessage(status) : 'MPEG-TS playback error: ' + detail)
        })
      })
      player.attachMediaElement(video)
      player.load()
      if (autoPlay) void Promise.resolve(player.play()).catch(() => setPaused(true))
    } else if (isMpegTs) {
      fail('MPEG-TS playback is not supported by this browser')
    } else if (isHls && Hls.isSupported()) {
      const hls = new Hls({
        enableWorker: true,
        lowLatencyMode: false,
        maxBufferLength: streamType === 'live' ? 32 : 90,
        maxMaxBufferLength: streamType === 'live' ? 48 : 120,
        liveSyncDurationCount: 3,
        liveMaxLatencyDurationCount: 8,
        backBufferLength: streamType === 'live' ? 15 : 30,
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
        const status = data.response?.code || 0
        if (status >= 400) {
          fail(httpStatusMessage(status))
        } else if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
          // Some CDN failures are hidden from the media engine after a redirect.
          // Ask the same-origin Gateway for the final HTTP status before falling
          // back to a generic network message.
          void probeHttpStatus(activeSrc).then(probedStatus => {
            if (generation !== generationRef.current) return
            fail(probedStatus >= 400 ? httpStatusMessage(probedStatus) : 'Network error — stream unavailable')
          })
        } else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
          fail('Format unsupported')
        } else {
          fail(data.details ? 'Playback error: ' + data.details : 'Playback failed')
        }
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
  }, [autoPlay, clearTimers, fallbackSrc, publishState, src, streamType])

  useEffect(() => {
    const generation = ++generationRef.current
    attemptRef.current = 0
    sourceIndexRef.current = 0
    setRetryCount(0)
    setReason('')
    startAttempt(generation)
    return () => {
      generationRef.current += 1
      teardown()
    }
  }, [src, fallbackSrc, startAttempt, teardown])

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
      const mediaMessage = code === MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED
        ? 'Format unsupported'
        : code === MediaError.MEDIA_ERR_NETWORK
          ? 'Network error — stream unavailable'
          : code === MediaError.MEDIA_ERR_DECODE
            ? 'Format unsupported (decode error)'
            : 'Unable to load stream'
      const activeSrc = sourceIndexRef.current === 1 && fallbackSrc ? fallbackSrc : src
      void probeHttpStatus(activeSrc).then(status => {
        const message = status >= 400 ? httpStatusMessage(status) : mediaMessage
        failCurrentAttemptRef.current(message)
      })
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
    sourceIndexRef.current = 0
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
