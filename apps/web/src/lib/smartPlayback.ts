export type DeviceProfile = { maxResolution: number; saveData: boolean; lowPower: boolean; connectionType: string }
type NavHints = Navigator & { deviceMemory?: number; connection?: { effectiveType?: string; downlink?: number; saveData?: boolean } }
export function getDeviceProfile(): DeviceProfile {
  const nav = navigator as NavHints
  const memory = nav.deviceMemory ?? 4
  const cores = navigator.hardwareConcurrency ?? 4
  const type = nav.connection?.effectiveType ?? 'unknown'
  const saveData = Boolean(nav.connection?.saveData)
  const lowPower = saveData || memory <= 2 || cores <= 2 || type === 'slow-2g' || type === '2g'
  return { maxResolution: lowPower ? 480 : memory <= 4 || cores <= 4 ? 720 : 2160, saveData, lowPower, connectionType: type }
}
export function getNetworkEstimate(): number {
  const value = (navigator as NavHints).connection?.downlink
  return typeof value === 'number' && value > 0 ? value * 1_000_000 : 0
}
export function getSafeMaxLevel(levels: Array<{height?: number; bitrate?: number}>, maxResolution: number, estimate: number): number {
  if (!levels.length) return -1
  let allowed = levels.map((level, index) => ({level, index})).filter(x => !x.level.height || x.level.height <= maxResolution)
  if (!allowed.length) allowed = [{level: levels[0], index: 0}]
  if (estimate > 0) {
    const networkAllowed = allowed.filter(x => !x.level.bitrate || x.level.bitrate <= estimate * 0.72)
    if (networkAllowed.length) allowed = networkAllowed
  }
  return allowed[allowed.length - 1].index
}