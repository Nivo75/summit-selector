'use client'

// Main page — Peak Randomizer
// Shows a list selector, optional distance filter, and a "Surprise Me" button.
// Phase 2 Tier 1: Wikipedia photo + description on result card.
// Phase 2 Tier 2: Browser geolocation + haversine distance filter.
// Phase 2 Tier 3: Nearest town (OSM Nominatim) + season guide (elevation heuristic).

import { useEffect, useState } from 'react'
import { supabase, type List, type Peak } from '@/lib/supabase'

// Wikipedia summary shape — only the fields we use
type WikiSummary = {
  extract: string | null    // short text description
  imageUrl: string | null   // thumbnail image URL
}

// User's GPS coordinates from the browser
type UserLocation = {
  lat: number
  lon: number
}

// Drive time result from our /api/drive-time proxy
type DriveTime = {
  hours: number
  minutes: number
  distanceMi: number
}

// Distance options shown in the dropdown (null = no filter)
const DISTANCE_OPTIONS: { label: string; miles: number | null }[] = [
  { label: 'Any Distance', miles: null },
  { label: 'Within 50 mi',  miles: 50  },
  { label: 'Within 100 mi', miles: 100 },
  { label: 'Within 200 mi', miles: 200 },
  { label: 'Within 500 mi', miles: 500 },
]

// Reverse-geocode a lat/lon to the nearest named place using OSM Nominatim.
// Free, no key needed. Returns a string like "Lone Pine" or null if not found.
async function fetchNearestTown(lat: number, lon: number): Promise<string | null> {
  try {
    const url = `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lon}&format=json`
    const res = await fetch(url, {
      headers: { 'User-Agent': 'SummitSelector/1.0 (summit-selector.vercel.app)' },
    })
    if (!res.ok) return null
    const json = await res.json()
    const addr = json.address ?? {}
    // Walk from smallest to largest populated place name
    return (
      addr.city ?? addr.town ?? addr.village ?? addr.hamlet ?? addr.county ?? null
    )
  } catch {
    return null
  }
}

// Season + conditions check.
// Returns the best-season label AND a contextual warning based on the current month.
// No API needed — pure heuristic from elevation + state + today's date.
type ConditionsInfo = {
  seasonLabel: string    // e.g. "Jun – Sep"
  warning: string | null // non-null when current month is outside the season window
}

function getConditionsInfo(elevationFt: number, state: string): ConditionsInfo {
  if (state === 'Hawaii') return { seasonLabel: 'Year-round', warning: null }

  let seasonLabel: string
  let startMonth: number  // 1 = Jan
  let endMonth: number

  if (state === 'Alaska') {
    if (elevationFt > 14000) {
      seasonLabel = 'Jun – Jul'; startMonth = 6; endMonth = 7
    } else {
      seasonLabel = 'May – Aug'; startMonth = 5; endMonth = 8
    }
  } else if (elevationFt < 4000) {
    seasonLabel = 'Mar – Nov'; startMonth = 3; endMonth = 11
  } else if (elevationFt < 8000) {
    seasonLabel = 'Apr – Oct'; startMonth = 4; endMonth = 10
  } else if (elevationFt < 12000) {
    seasonLabel = 'May – Sep'; startMonth = 5; endMonth = 9
  } else if (elevationFt < 14000) {
    seasonLabel = 'Jun – Sep'; startMonth = 6; endMonth = 9
  } else {
    seasonLabel = 'Jul – Aug'; startMonth = 7; endMonth = 8
  }

  const month = new Date().getMonth() + 1 // 1–12
  const inSeason = month >= startMonth && month <= endMonth

  let warning: string | null = null
  if (!inSeason) {
    if (month === startMonth - 1) {
      // One month before season opens
      warning = `Season opens soon (${seasonLabel}). Snow may still be present at the summit — check conditions before heading out.`
    } else if (month === endMonth + 1) {
      // One month after season closes
      warning = `Late season. Snow and ice increasing — verify trail conditions before going.`
    } else if (month < startMonth) {
      // Deep winter / early spring
      warning = `Currently off-season (best: ${seasonLabel}). Expect snow and ice at the summit. Technical gear likely required.`
    } else {
      // Fall / winter after season
      warning = `Currently off-season (best: ${seasonLabel}). Winter conditions setting in — expect snow and ice at the summit.`
    }
  }

  return { seasonLabel, warning }
}

// Haversine formula — straight-line distance in miles between two lat/lon points
function haversine(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 3959 // Earth radius in miles
  const toRad = (deg: number) => (deg * Math.PI) / 180
  const dLat = toRad(lat2 - lat1)
  const dLon = toRad(lon2 - lon1)
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}

export default function Home() {
  const [lists, setLists] = useState<List[]>([])
  const [selectedListId, setSelectedListId] = useState<string>('any')
  const [maxDistanceMi, setMaxDistanceMi] = useState<number | null>(null)
  const [userLocation, setUserLocation] = useState<UserLocation | null>(null)
  const [locationStatus, setLocationStatus] = useState<'idle' | 'requesting' | 'granted' | 'denied'>('idle')
  const [peak, setPeak] = useState<Peak | null>(null)
  const [peakDistanceMi, setPeakDistanceMi] = useState<number | null>(null)
  const [driveTime, setDriveTime] = useState<DriveTime | null>(null)
  const [driveTimeLoading, setDriveTimeLoading] = useState(false)
  const [nearestTown, setNearestTown] = useState<string | null>(null)
  const [wiki, setWiki] = useState<WikiSummary | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [listsLoading, setListsLoading] = useState(true)

  // Load available summit lists on first render
  useEffect(() => {
    async function fetchLists() {
      const { data, error } = await supabase
        .from('lists')
        .select('id, slug, name, description, peak_count')
        .order('name')

      if (error) {
        console.error('Failed to load lists:', error)
      } else {
        setLists(data ?? [])
      }
      setListsLoading(false)
    }
    fetchLists()
  }, [])

  // Request browser geolocation and store the result
  function requestLocation(): Promise<UserLocation | null> {
    return new Promise((resolve) => {
      if (!navigator.geolocation) {
        setLocationStatus('denied')
        resolve(null)
        return
      }
      setLocationStatus('requesting')
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          const loc = { lat: pos.coords.latitude, lon: pos.coords.longitude }
          setUserLocation(loc)
          setLocationStatus('granted')
          resolve(loc)
        },
        () => {
          setLocationStatus('denied')
          resolve(null)
        }
      )
    })
  }

  // When distance filter changes: request location if one isn't already stored
  async function handleDistanceChange(miles: number | null) {
    setMaxDistanceMi(miles)
    setPeak(null)
    setWiki(null)
    setPeakDistanceMi(null)
    if (miles !== null && !userLocation) {
      await requestLocation()
    }
  }

  // Fetch a Wikipedia summary (description + photo) for a peak name.
  // Returns null fields silently if the article isn't found.
  async function fetchWiki(peakName: string): Promise<WikiSummary> {
    try {
      const url = `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(peakName)}`
      const res = await fetch(url, { headers: { Accept: 'application/json' } })
      if (!res.ok) return { extract: null, imageUrl: null }

      const json = await res.json()

      // Disambiguation pages have no useful content — skip them
      if (json.type === 'disambiguation') return { extract: null, imageUrl: null }

      // Truncate extract to 2 sentences max
      const fullText: string = json.extract ?? ''
      const sentences = fullText.match(/[^.!?]+[.!?]+/g) ?? []
      const shortExtract = sentences.slice(0, 2).join(' ').trim() || null

      // Wikipedia thumbnails embed width in the URL — bump to 800px for sharpness
      const rawUrl: string | null = json.thumbnail?.source ?? null
      const imageUrl = rawUrl ? rawUrl.replace(/\/\d+px-/, '/800px-') : null

      return { extract: shortExtract, imageUrl }
    } catch {
      return { extract: null, imageUrl: null }
    }
  }

  // Call our server-side /api/drive-time proxy.
  // Returns null silently if rate-limited or if an error occurs — card still shows without it.
  async function fetchDriveTime(
    originLat: number,
    originLon: number,
    destLat: number,
    destLon: number
  ): Promise<DriveTime | null> {
    try {
      const res = await fetch('/api/drive-time', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ originLat, originLon, destLat, destLon }),
      })
      if (!res.ok) return null
      return await res.json()
    } catch {
      return null
    }
  }

  // Called when the user clicks "Get Drive Time" on the result card.
  // Requests location if not already granted, then fetches from /api/drive-time.
  async function requestDriveTime() {
    if (!peak) return
    setDriveTimeLoading(true)

    let loc = userLocation
    if (!loc) {
      loc = await requestLocation()
      if (!loc) {
        setDriveTimeLoading(false)
        return // location denied — button stays visible, nothing breaks
      }
    }

    const dt = await fetchDriveTime(
      loc.lat, loc.lon,
      Number(peak.latitude), Number(peak.longitude)
    )
    setDriveTime(dt)
    setDriveTimeLoading(false)
  }

  // Pick a random peak from the selected list (or any list),
  // optionally filtered to within maxDistanceMi of the user
  async function surpriseMe() {
    setLoading(true)
    setError(null)
    setPeak(null)
    setWiki(null)
    setNearestTown(null)
    setPeakDistanceMi(null)
    setDriveTime(null)
    setDriveTimeLoading(false)

    // If distance filter is active but we don't have location yet, get it now
    let loc = userLocation
    if (maxDistanceMi !== null && !loc) {
      loc = await requestLocation()
      if (!loc) {
        setError('Location access denied. Clear the distance filter or allow location.')
        setLoading(false)
        return
      }
    }

    try {
      // Step 1 — Get peak IDs for the selected list
      let query = supabase.from('list_peaks').select('peak_id')
      if (selectedListId !== 'any') {
        query = query.eq('list_id', selectedListId)
      }
      const { data: listData, error: listError } = await query
      if (listError) throw listError

      let peakIds: string[] = (listData ?? []).map((row) => row.peak_id)

      if (peakIds.length === 0) {
        setError('No peaks found for that list.')
        return
      }

      // Step 2 — If a distance filter is active, fetch coordinates for all
      // peaks in the list and remove any that are too far away
      if (maxDistanceMi !== null && loc) {
        const { data: coordData, error: coordError } = await supabase
          .from('peaks')
          .select('id, latitude, longitude')
          .in('id', peakIds)

        if (coordError) throw coordError

        const nearby = (coordData ?? []).filter((p) => {
          const d = haversine(loc!.lat, loc!.lon, Number(p.latitude), Number(p.longitude))
          return d <= maxDistanceMi
        })

        if (nearby.length === 0) {
          setError(`No peaks found within ${maxDistanceMi} miles. Try a larger radius.`)
          return
        }

        peakIds = nearby.map((p) => p.id)
      }

      // Step 3 — Pick a random ID and fetch the full peak record
      const randomId = peakIds[Math.floor(Math.random() * peakIds.length)]

      const { data: peakData, error: peakError } = await supabase
        .from('peaks')
        .select('*')
        .eq('id', randomId)
        .single()

      if (peakError) throw peakError
      setPeak(peakData)

      // Store straight-line distance to this peak if we have user location
      if (loc) {
        const d = haversine(loc.lat, loc.lon, Number(peakData.latitude), Number(peakData.longitude))
        setPeakDistanceMi(Math.round(d))
      }

      // Fetch Wikipedia photo + description in the background
      fetchWiki(peakData.name).then(setWiki)

      // Fetch nearest town via OSM Nominatim in the background
      fetchNearestTown(Number(peakData.latitude), Number(peakData.longitude))
        .then(setNearestTown)
    } catch (err) {
      console.error(err)
      setError('Something went wrong. Try again.')
    } finally {
      setLoading(false)
    }
  }

  // Format elevation with commas, e.g. 14499 → "14,499 ft"
  function formatElevation(ft: number) {
    return ft.toLocaleString() + ' ft'
  }

  // Convert feet to meters for display
  function toMeters(ft: number) {
    return Math.round(ft * 0.3048).toLocaleString() + ' m'
  }

  return (
    <main className="min-h-screen bg-stone-950 text-stone-100 flex flex-col items-center justify-center px-4 py-16">

      {/* Header */}
      <div className="text-center mb-12">
        <h1 className="text-5xl font-bold tracking-tight text-white mb-3">
          Peak Randomizer
        </h1>
        <p className="text-stone-400 text-lg max-w-md mx-auto">
          No plans. No excuses. Pick a list, hit the button, go climb something.
        </p>
      </div>

      {/* Controls */}
      <div className="flex flex-col sm:flex-row gap-4 items-end mb-4 w-full max-w-lg">

        {/* List selector */}
        <div className="flex-1 w-full">
          <label className="block text-xs text-stone-500 uppercase tracking-widest mb-1.5">
            Summit List
          </label>
          <select
            value={selectedListId}
            onChange={(e) => {
              setSelectedListId(e.target.value)
              setPeak(null)
              setWiki(null)
              setNearestTown(null)
              setPeakDistanceMi(null)
              setDriveTime(null)
            }}
            disabled={listsLoading}
            className="w-full bg-stone-800 border border-stone-700 rounded-lg px-4 py-3 text-stone-100
                       focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:border-transparent
                       disabled:opacity-50 cursor-pointer"
          >
            <option value="any">Any List</option>
            {lists.map((list) => (
              <option key={list.id} value={list.id}>
                {list.name} ({list.peak_count})
              </option>
            ))}
          </select>
        </div>

        {/* Distance filter */}
        <div className="w-full sm:w-44">
          <label className="block text-xs text-stone-500 uppercase tracking-widest mb-1.5">
            Distance
          </label>
          <select
            value={maxDistanceMi ?? 'any'}
            onChange={(e) => {
              const val = e.target.value
              handleDistanceChange(val === 'any' ? null : Number(val))
            }}
            className="w-full bg-stone-800 border border-stone-700 rounded-lg px-4 py-3 text-stone-100
                       focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:border-transparent
                       cursor-pointer"
          >
            {DISTANCE_OPTIONS.map((opt) => (
              <option key={opt.label} value={opt.miles ?? 'any'}>
                {opt.label}
              </option>
            ))}
          </select>
        </div>

        {/* Surprise Me button */}
        <div className="w-full sm:w-auto">
          <button
            onClick={surpriseMe}
            disabled={loading || listsLoading}
            className="w-full px-8 py-3 rounded-lg bg-emerald-600 hover:bg-emerald-500
                       active:scale-95 transition-all font-semibold text-white text-base
                       disabled:opacity-50 disabled:cursor-not-allowed shadow-lg shadow-emerald-900/40"
          >
            {loading ? 'Picking…' : '⛰ Surprise Me'}
          </button>
        </div>
      </div>

      {/* Location status row */}
      {maxDistanceMi !== null && (
        <div className="w-full max-w-lg mb-6 text-xs">
          {locationStatus === 'requesting' && (
            <p className="text-stone-500">Requesting location…</p>
          )}
          {locationStatus === 'granted' && (
            <p className="text-emerald-600">📍 Location active — filtering by distance</p>
          )}
          {locationStatus === 'denied' && (
            <p className="text-red-400">Location access denied. Allow it in your browser to use distance filtering.</p>
          )}
        </div>
      )}

      {/* Error message */}
      {error && (
        <div className="text-red-400 text-sm mb-6">{error}</div>
      )}

      {/* Peak result card */}
      {peak && (
        <div className="w-full max-w-lg bg-stone-900 border border-stone-800 rounded-2xl overflow-hidden shadow-2xl">

          {/* Wikipedia hero photo — shown only if available and loads successfully */}
          {wiki?.imageUrl && (
            <div className="w-full h-52 overflow-hidden">
              <img
                src={wiki.imageUrl}
                alt={peak.name}
                className="w-full h-full object-cover"
                onError={(e) => {
                  // Hide the image container if the URL fails to load
                  const parent = (e.target as HTMLImageElement).parentElement
                  if (parent) parent.style.display = 'none'
                }}
              />
            </div>
          )}

          <div className="p-8">

            {/* Peak name + state + distance */}
            <div className="mb-6">
              <p className="text-xs text-emerald-500 uppercase tracking-widest font-semibold mb-1">
                Your Peak
              </p>
              <h2 className="text-3xl font-bold text-white leading-tight">{peak.name}</h2>
              <div className="flex items-center gap-3 mt-1">
                <p className="text-stone-400 text-lg">{peak.state}</p>
                {peakDistanceMi !== null && (
                  <span className="text-sm text-stone-500">
                    · {peakDistanceMi.toLocaleString()} mi from you
                  </span>
                )}
              </div>
            </div>

            {/* Conditions warning — amber banner shown when outside the season window */}
            {(() => {
              const { warning } = getConditionsInfo(peak.elevation_ft, peak.state)
              return warning ? (
                <div className="bg-amber-900/40 border border-amber-700/50 rounded-xl px-4 py-3 mb-6">
                  <p className="text-xs text-amber-400 uppercase tracking-widest font-semibold mb-1">
                    ⚠ Conditions Notice
                  </p>
                  <p className="text-amber-200 text-sm leading-relaxed">{warning}</p>
                </div>
              ) : null
            })()}

            {/* Wikipedia description — shown only if available */}
            {wiki?.extract && (
              <p className="text-stone-400 text-sm leading-relaxed mb-6">
                {wiki.extract}
              </p>
            )}

            {/* Stats grid */}
            <div className="grid grid-cols-2 gap-4 mb-6">
              <div className="bg-stone-800 rounded-xl p-4">
                <p className="text-xs text-stone-500 uppercase tracking-widest mb-1">Elevation</p>
                <p className="text-2xl font-bold text-white">{formatElevation(peak.elevation_ft)}</p>
                <p className="text-sm text-stone-400">{toMeters(peak.elevation_ft)}</p>
              </div>

              {/* Drive time — shows result tile once loaded, button otherwise */}
              {driveTime ? (
                <div className="bg-stone-800 rounded-xl p-4">
                  <p className="text-xs text-stone-500 uppercase tracking-widest mb-1">Drive Time</p>
                  <p className="text-2xl font-bold text-white">
                    {driveTime.hours > 0
                      ? `${driveTime.hours} hr ${driveTime.minutes} min`
                      : `${driveTime.minutes} min`}
                  </p>
                  <p className="text-sm text-stone-400">{driveTime.distanceMi.toLocaleString()} mi by road</p>
                </div>
              ) : (
                <button
                  onClick={requestDriveTime}
                  disabled={driveTimeLoading}
                  className="bg-stone-800 hover:bg-stone-700 rounded-xl p-4 text-left
                             transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  <p className="text-xs text-stone-500 uppercase tracking-widest mb-1">Drive Time</p>
                  <p className="text-sm font-medium text-emerald-500">
                    {driveTimeLoading ? 'Calculating…' : 'Tap to calculate →'}
                  </p>
                </button>
              )}

              {peak.prominence_ft && (
                <div className="bg-stone-800 rounded-xl p-4">
                  <p className="text-xs text-stone-500 uppercase tracking-widest mb-1">Prominence</p>
                  <p className="text-2xl font-bold text-white">{formatElevation(peak.prominence_ft)}</p>
                  <p className="text-sm text-stone-400">{toMeters(peak.prominence_ft)}</p>
                </div>
              )}

              {peak.peak_type && (
                <div className="bg-stone-800 rounded-xl p-4">
                  <p className="text-xs text-stone-500 uppercase tracking-widest mb-1">Type</p>
                  <p className="text-xl font-semibold text-white">{peak.peak_type}</p>
                </div>
              )}

              {/* Best season tile */}
              <div className="bg-stone-800 rounded-xl p-4">
                <p className="text-xs text-stone-500 uppercase tracking-widest mb-1">Best Season</p>
                <p className="text-xl font-semibold text-white">
                  {getConditionsInfo(peak.elevation_ft, peak.state).seasonLabel}
                </p>
              </div>

              {/* Nearest town — appears once Nominatim responds */}
              {nearestTown && (
                <div className="bg-stone-800 rounded-xl p-4">
                  <p className="text-xs text-stone-500 uppercase tracking-widest mb-1">Nearest Town</p>
                  <p className="text-xl font-semibold text-white leading-tight">{nearestTown}</p>
                </div>
              )}

              <div className="bg-stone-800 rounded-xl p-4">
                <p className="text-xs text-stone-500 uppercase tracking-widest mb-1">Coordinates</p>
                <p className="text-sm font-mono text-stone-300 mt-1">
                  {Number(peak.latitude).toFixed(4)}° N
                </p>
                <p className="text-sm font-mono text-stone-300">
                  {Number(peak.longitude).toFixed(4)}°
                </p>
              </div>
            </div>

            {/* Action links */}
            <div className="flex flex-wrap gap-3">
              {peak.source_url && (
                <a
                  href={peak.source_url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex-1 text-center px-4 py-2.5 rounded-lg bg-stone-800 hover:bg-stone-700
                             text-stone-300 hover:text-white text-sm font-medium transition-colors"
                >
                  Peakbagger →
                </a>
              )}
              <a
                href={`https://www.alltrails.com/search?q=${encodeURIComponent(peak.name)}`}
                target="_blank"
                rel="noopener noreferrer"
                className="flex-1 text-center px-4 py-2.5 rounded-lg bg-stone-800 hover:bg-stone-700
                           text-stone-300 hover:text-white text-sm font-medium transition-colors"
              >
                AllTrails →
              </a>
              <a
                href={`https://www.google.com/maps/search/${encodeURIComponent(peak.name + ' ' + peak.state)}/@${peak.latitude},${peak.longitude},12z`}
                target="_blank"
                rel="noopener noreferrer"
                className="flex-1 text-center px-4 py-2.5 rounded-lg bg-stone-800 hover:bg-stone-700
                           text-stone-300 hover:text-white text-sm font-medium transition-colors"
              >
                Map →
              </a>
            </div>

            {/* Pick again nudge */}
            <button
              onClick={surpriseMe}
              className="w-full mt-4 text-sm text-stone-500 hover:text-stone-300 transition-colors py-2"
            >
              Not feeling it? Pick another →
            </button>

          </div>
        </div>
      )}

      {/* Footer */}
      <p className="mt-16 text-stone-700 text-xs">
        Summit Selector · Peak data via Peakbagger.com
      </p>
    </main>
  )
}
