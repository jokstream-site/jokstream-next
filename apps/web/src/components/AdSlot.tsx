import type { HTMLAttributes } from 'react'

type AdSlotProps = { placement: 'player-preroll' | 'section-banner'; className?: string }

/** Reserved, first-party mount point for the ad code supplied by the site owner.
 * No third-party script, tracking pixel, or network request is loaded until configured.
 */
export default function AdSlot({ placement, className = '' }: AdSlotProps) {
  return <div
    data-jokstream-ad-slot={placement}
    data-ad-ready="false"
    aria-label={placement === 'player-preroll' ? 'Video advertisement placement' : 'Advertisement placement'}
    className={className}
  />
}
