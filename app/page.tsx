'use client'

// Main page — Peak Randomizer + Quiz
// Phase 2: Wikipedia photo/description, geolocation, drive time, nearest town, season guide.
// Phase 3: "Find My Next Peak" quiz engine — 4 questions that filter the peak pool.

import { useEffect, useState } from 'react'
import { supabase, type List, type Peak } from '@/lib/supabase'

// ─── Types ────────────────────────────────────────────────────────────────────

type WikiSummary = {
  extract: string | null
  imageUrl: string | null
}

type UserLocation = {
  lat: number
  lon: number
}

type DriveTime = {
  hours: number
  minutes: number
  distanceMi: number
}

type ConditionsInfo = {
  seasonLabel: string
  warning: string | null
}

// Quiz answer types — each maps to a concrete filter value
type DriveOption  = 'under1h' | '1to2h' | '2to4h' | 'any'
type FitnessOption = 'easy' | 'moderate' | 'hard' | 'expert'
type TimeOption   = 'halfday' | 'fullday' | 'weekend'

// ─── Pure helper functions (no React state) ───────────────────────────────────

// Haversine: straight-line distance in miles between two lat/lon points
function haversine(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 3959
  const toRad = (d: number) => (d * Math.PI) / 180
  const dLat = toRad(lat2 - lat1)
  const dLon = toRad(lon2 - lon1)
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}

// Conditions: season label + contextual warning based on current month
function getConditionsInfo(elevationFt: number, state: string): ConditionsInfo {
  if (state === 'Hawaii') return { seasonLabel: 'Year-round', warning: null }

  let seasonLabel: string
  let startMonth: number
  let endMonth: number

  if (state === 'Alaska') {
    if (elevationFt > 14000) { seasonLabel = 'Jun – Jul'; startMonth = 6; endMonth = 7 }
    else                      { seasonLabel = 'May – Aug'; startMonth = 5; endMonth = 8 }
  } else if (elevationFt < 4000)  { seasonLabel = 'Mar – Nov'; startMonth = 3; endMonth = 11 }
    else if (elevationFt < 8000)  { seasonLabel = 'Apr – Oct'; startMonth = 4; endMonth = 10 }
    else if (elevationFt < 12000) { seasonLabel = 'May – Sep'; startMonth = 5; endMonth = 9  }
    else if (elevationFt < 14000) { seasonLabel = 'Jun – Sep'; startMonth = 6; endMonth = 9  }
    else                          { seasonLabel = 'Jul – Aug'; startMonth = 7; endMonth = 8  }

  const month = new Date().getMonth() + 1
  const inSeason = month >= startMonth && month <= endMonth
  let warning: string | null = null

  if (!inSeason) {
    if (month === startMonth - 1)
      warning = `Season opens soon (${seasonLabel}). Snow may still be present — check conditions before heading out.`
    else if (month === endMonth + 1)
      warning = `Late season. Snow and ice increasing — verify trail conditions before going.`
    else if (month < startMonth)
      warning = `Currently off-season (best: ${seasonLabel}). Expect snow and ice at the summit. Technical gear likely required.`
    else
      warning = `Currently off-season (best: ${seasonLabel}). Winter conditions setting in — expect snow and ice at the summit.`
  }

  return { seasonLabel, warning }
}

// Format elevation with commas → "14,499 ft"
function formatElevation(ft: number) { return ft.toLocaleString() + ' ft' }

// Convert feet to meters
function toMeters(ft: number) { return Math.round(ft * 0.3048).toLocaleString() + ' m' }

// OSM Nominatim reverse geocode — nearest named place
async function fetchNearestTown(lat: number, lon: number): Promise<string | null> {
  try {
    const res = await fetch(
      `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lon}&format=json`,
      { headers: { 'User-Agent': 'SummitSelector/1.0 (summit-selector.vercel.app)' } }
    )
    if (!res.ok) return null
    const json = await res.json()
    const addr = json.address ?? {}
    return addr.city ?? addr.town ?? addr.village ?? addr.hamlet ?? addr.county ?? null
  } catch { return null }
}

// Wikipedia summary — description + hero photo
async function fetchWiki(peakName: string): Promise<WikiSummary> {
  try {
    const res = await fetch(
      `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(peakName)}`,
      { headers: { Accept: 'application/json' } }
    )
    if (!res.ok) return { extract: null, imageUrl: null }
    const json = await res.json()
    if (json.type === 'disambiguation') return { extract: null, imageUrl: null }

    const fullText: string = json.extract ?? ''
    const sentences = fullText.match(/[^.!?]+[.!?]+/g) ?? []
    const shortExtract = sentences.slice(0, 2).join(' ').trim() || null
    const rawUrl: string | null = json.thumbnail?.source ?? null
    const imageUrl = rawUrl ? rawUrl.replace(/\/\d+px-/, '/800px-') : null

    return { extract: shortExtract, imageUrl }
  } catch { return { extract: null, imageUrl: null } }
}

// Convert quiz drive answer to mile radius (null = no limit)
function driveToMiles(opt: DriveOption): number | null {
  return { under1h: 60, '1to2h': 120, '2to4h': 240, any: null }[opt]
}

// Convert quiz fitness + time answers to max elevation ft (null = no limit)
// Takes the more restrictive of the two
function answersToMaxElevation(fitness: FitnessOption, time: TimeOption): number | null {
  const fitnessMax: Record<FitnessOption, number | null> = {
    easy: 6000, moderate: 11000, hard: 14500, expert: null,
  }
  const timeMax: Record<TimeOption, number | null> = {
    halfday: 7000, fullday: 12000, weekend: null,
  }
  const f = fitnessMax[fitness]
  const t = timeMax[time]
  if (f !== null && t !== null) return Math.min(f, t)
  return f ?? t
}

// ─── Shared pill-button group component ──────────────────────────────────────

function PillGroup<T extends string>({
  options, value, onChange,
}: {
  options: { label: string; value: T }[]
  value: T
  onChange: (v: T) => void
}) {
  return (
    <div className="flex flex-wrap gap-2">
      {options.map((opt) => (
        <button
          key={opt.value}
          onClick={() => onChange(opt.value)}
          className={`px-4 py-2 rounded-full text-sm font-medium transition-colors
            ${value === opt.value
              ? 'bg-emerald-600 text-white'
              : 'bg-stone-800 text-stone-400 hover:bg-stone-700 hover:text-white'
            }`}
        >
          {opt.label}
        </button>
      ))}
    </div>
  )
}

// ─── Distance options for the randomizer dropdown ────────────────────────────

const DISTANCE_OPTIONS = [
  { label: 'Any Distance', miles: null },
  { label: 'Within 50 mi',  miles: 50  },
  { label: 'Within 100 mi', miles: 100 },
  { label: 'Within 200 mi', miles: 200 },
  { label: 'Within 500 mi', miles: 500 },
]

// ─── Main component ───────────────────────────────────────────────────────────

export default function Home() {
  // App mode
  const [mode, setMode] = useState<'randomizer' | 'quiz'>('randomizer')

  // Lists
  const [lists, setLists] = useState<List[]>([])
  const [listsLoading, setListsLoading] = useState(true)

  // Randomizer controls
  const [selectedListId, setSelectedListId] = useState<string>('any')
  const [maxDistanceMi, setMaxDistanceMi] = useState<number | null>(null)

  // Quiz answers
  const [quizDrive, setQuizDrive]     = useState<DriveOption>('any')
  const [quizFitness, setQuizFitness] = useState<FitnessOption>('moderate')
  const [quizList, setQuizList]       = useState<string>('any')
  const [quizTime, setQuizTime]       = useState<TimeOption>('fullday')

  // Location
  const [userLocation, setUserLocation] = useState<UserLocation | null>(null)
  const [locationStatus, setLocationStatus] = useState<'idle' | 'requesting' | 'granted' | 'denied'>('idle')

  // Result state
  const [peak, setPeak]                   = useState<Peak | null>(null)
  const [peakDistanceMi, setPeakDistanceMi] = useState<number | null>(null)
  const [driveTime, setDriveTime]         = useState<DriveTime | null>(null)
  const [driveTimeLoading, setDriveTimeLoading] = useState(false)
  const [nearestTown, setNearestTown]     = useState<string | null>(null)
  const [wiki, setWiki]                   = useState<WikiSummary | null>(null)
  const [loading, setLoading]             = useState(false)
  const [error, setError]                 = useState<string | null>(null)

  // Load summit lists on mount
  useEffect(() => {
    supabase
      .from('lists')
      .select('id, slug, name, description, peak_count')
      .order('name')
      .then(({ data, error }) => {
        if (!error) setLists(data ?? [])
        setListsLoading(false)
      })
  }, [])

  // Browser geolocation
  function requestLocation(): Promise<UserLocation | null> {
    return new Promise((resolve) => {
      if (!navigator.geolocation) { setLocationStatus('denied'); resolve(null); return }
      setLocationStatus('requesting')
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          const loc = { lat: pos.coords.latitude, lon: pos.coords.longitude }
          setUserLocation(loc)
          setLocationStatus('granted')
          resolve(loc)
        },
        () => { setLocationStatus('denied'); resolve(null) }
      )
    })
  }

  // Clear result when randomizer dropdowns change
  function handleDistanceChange(miles: number | null) {
    setMaxDistanceMi(miles)
    clearResult()
    if (miles !== null && !userLocation) requestLocation()
  }

  function clearResult() {
    setPeak(null); setWiki(null); setNearestTown(null)
    setPeakDistanceMi(null); setDriveTime(null); setDriveTimeLoading(false)
  }

  // ── Core: find a random peak given explicit filter options ──────────────────
  async function findPeak(opts: {
    listId: string
    distanceMi: number | null
    maxElevationFt: number | null
  }) {
    setLoading(true)
    setError(null)
    clearResult()

    let loc = userLocation
    if (opts.distanceMi !== null && !loc) {
      loc = await requestLocation()
      if (!loc) {
        setError('Location access denied. Allow it in your browser to use the distance filter.')
        setLoading(false)
        return
      }
    }

    try {
      // Step 1 — peak IDs for the chosen list
      let q = supabase.from('list_peaks').select('peak_id')
      if (opts.listId !== 'any') q = q.eq('list_id', opts.listId)
      const { data: listData, error: listErr } = await q
      if (listErr) throw listErr
      let peakIds: string[] = (listData ?? []).map((r) => r.peak_id)
      if (peakIds.length === 0) { setError('No peaks found for that list.'); return }

      // Step 2 — if any spatial/elevation filter is active, fetch coords + elevation
      // and filter client-side (50 state highpoints is tiny; this scales fine for now)
      if (opts.distanceMi !== null || opts.maxElevationFt !== null) {
        const { data: coordData, error: coordErr } = await supabase
          .from('peaks')
          .select('id, latitude, longitude, elevation_ft')
          .in('id', peakIds)
        if (coordErr) throw coordErr

        let filtered = coordData ?? []

        if (opts.distanceMi !== null && loc) {
          filtered = filtered.filter((p) =>
            haversine(loc!.lat, loc!.lon, Number(p.latitude), Number(p.longitude)) <= opts.distanceMi!
          )
        }
        if (opts.maxElevationFt !== null) {
          filtered = filtered.filter((p) => Number(p.elevation_ft) <= opts.maxElevationFt!)
        }

        if (filtered.length === 0) {
          setError('No peaks matched your criteria. Try relaxing one of the filters.')
          return
        }
        peakIds = filtered.map((p) => p.id)
      }

      // Step 3 — pick random, fetch full record
      const randomId = peakIds[Math.floor(Math.random() * peakIds.length)]
      const { data: peakData, error: peakErr } = await supabase
        .from('peaks').select('*').eq('id', randomId).single()
      if (peakErr) throw peakErr
      setPeak(peakData)

      if (loc) {
        const d = haversine(loc.lat, loc.lon, Number(peakData.latitude), Number(peakData.longitude))
        setPeakDistanceMi(Math.round(d))
      }

      fetchWiki(peakData.name).then(setWiki)
      fetchNearestTown(Number(peakData.latitude), Number(peakData.longitude)).then(setNearestTown)
    } catch (err) {
      console.error(err)
      setError('Something went wrong. Try again.')
    } finally {
      setLoading(false)
    }
  }

  // Randomizer entry point — reads existing dropdown state
  function surpriseMe() {
    findPeak({ listId: selectedListId, distanceMi: maxDistanceMi, maxElevationFt: null })
  }

  // Quiz entry point — converts quiz answers to filter values then calls findPeak
  function submitQuiz() {
    findPeak({
      listId: quizList,
      distanceMi: driveToMiles(quizDrive),
      maxElevationFt: answersToMaxElevation(quizFitness, quizTime),
    })
  }

  // Drive time on-demand
  async function requestDriveTime() {
    if (!peak) return
    setDriveTimeLoading(true)
    let loc = userLocation
    if (!loc) {
      loc = await requestLocation()
      if (!loc) { setDriveTimeLoading(false); return }
    }
    try {
      const res = await fetch('/api/drive-time', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          originLat: loc.lat, originLon: loc.lon,
          destLat: Number(peak.latitude), destLon: Number(peak.longitude),
        }),
      })
      if (res.ok) setDriveTime(await res.json())
    } catch { /* silent — button stays */ }
    finally { setDriveTimeLoading(false) }
  }

  // ─── Render ─────────────────────────────────────────────────────────────────

  return (
    <main className="min-h-screen bg-stone-950 text-stone-100 flex flex-col items-center justify-center px-4 py-16">

      {/* Header */}
      <div className="text-center mb-10">
        <h1 className="text-5xl font-bold tracking-tight text-white mb-3">Peak Randomizer</h1>
        <p className="text-stone-400 text-lg max-w-md mx-auto">
          No plans. No excuses. Pick a list, hit the button, go climb something.
        </p>
      </div>

      {/* Mode toggle */}
      <div className="flex gap-2 mb-8 bg-stone-900 border border-stone-800 rounded-xl p-1">
        <button
          onClick={() => { setMode('randomizer'); clearResult() }}
          className={`px-6 py-2 rounded-lg text-sm font-semibold transition-colors
            ${mode === 'randomizer' ? 'bg-emerald-600 text-white' : 'text-stone-400 hover:text-white'}`}
        >
          ⛰ Surprise Me
        </button>
        <button
          onClick={() => { setMode('quiz'); clearResult() }}
          className={`px-6 py-2 rounded-lg text-sm font-semibold transition-colors
            ${mode === 'quiz' ? 'bg-emerald-600 text-white' : 'text-stone-400 hover:text-white'}`}
        >
          🧭 Find My Peak
        </button>
      </div>

      {/* ── Randomizer mode ── */}
      {mode === 'randomizer' && (
        <div className="flex flex-col sm:flex-row gap-4 items-end mb-4 w-full max-w-lg">
          <div className="flex-1 w-full">
            <label className="block text-xs text-stone-500 uppercase tracking-widest mb-1.5">Summit List</label>
            <select
              value={selectedListId}
              onChange={(e) => { setSelectedListId(e.target.value); clearResult() }}
              disabled={listsLoading}
              className="w-full bg-stone-800 border border-stone-700 rounded-lg px-4 py-3 text-stone-100
                         focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:border-transparent
                         disabled:opacity-50 cursor-pointer"
            >
              <option value="any">Any List</option>
              {lists.map((l) => (
                <option key={l.id} value={l.id}>{l.name} ({l.peak_count})</option>
              ))}
            </select>
          </div>

          <div className="w-full sm:w-44">
            <label className="block text-xs text-stone-500 uppercase tracking-widest mb-1.5">Distance</label>
            <select
              value={maxDistanceMi ?? 'any'}
              onChange={(e) => handleDistanceChange(e.target.value === 'any' ? null : Number(e.target.value))}
              className="w-full bg-stone-800 border border-stone-700 rounded-lg px-4 py-3 text-stone-100
                         focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:border-transparent cursor-pointer"
            >
              {DISTANCE_OPTIONS.map((o) => (
                <option key={o.label} value={o.miles ?? 'any'}>{o.label}</option>
              ))}
            </select>
          </div>

          <div className="w-full sm:w-auto">
            <button
              onClick={surpriseMe}
              disabled={loading || listsLoading}
              className="w-full px-8 py-3 rounded-lg bg-emerald-600 hover:bg-emerald-500
                         active:scale-95 transition-all font-semibold text-white text-base
                         disabled:opacity-50 disabled:cursor-not-allowed shadow-lg shadow-emerald-900/40"
            >
              {loading ? 'Picking…' : 'Go'}
            </button>
          </div>
        </div>
      )}

      {/* Location status (randomizer only) */}
      {mode === 'randomizer' && maxDistanceMi !== null && (
        <div className="w-full max-w-lg mb-6 text-xs">
          {locationStatus === 'requesting' && <p className="text-stone-500">Requesting location…</p>}
          {locationStatus === 'granted'    && <p className="text-emerald-600">📍 Location active — filtering by distance</p>}
          {locationStatus === 'denied'     && <p className="text-red-400">Location access denied. Allow it in your browser to use distance filtering.</p>}
        </div>
      )}

      {/* ── Quiz mode ── */}
      {mode === 'quiz' && (
        <div className="w-full max-w-lg bg-stone-900 border border-stone-800 rounded-2xl p-8 mb-8">
          <p className="text-xs text-emerald-500 uppercase tracking-widest font-semibold mb-6">
            Find My Next Peak
          </p>

          {/* Q1 — Drive radius */}
          <div className="mb-6">
            <p className="text-sm font-semibold text-white mb-3">How far will you drive?</p>
            <PillGroup<DriveOption>
              value={quizDrive}
              onChange={setQuizDrive}
              options={[
                { label: 'Under 1 hr',  value: 'under1h' },
                { label: '1 – 2 hrs',   value: '1to2h'   },
                { label: '2 – 4 hrs',   value: '2to4h'   },
                { label: 'No limit',    value: 'any'      },
              ]}
            />
          </div>

          {/* Q2 — Fitness */}
          <div className="mb-6">
            <p className="text-sm font-semibold text-white mb-3">How fit are you feeling today?</p>
            <PillGroup<FitnessOption>
              value={quizFitness}
              onChange={setQuizFitness}
              options={[
                { label: 'Easy day',     value: 'easy'    },
                { label: 'Moderate',     value: 'moderate'},
                { label: 'Push myself',  value: 'hard'    },
                { label: 'Beast mode 💪', value: 'expert'  },
              ]}
            />
          </div>

          {/* Q3 — List */}
          <div className="mb-6">
            <p className="text-sm font-semibold text-white mb-3">Any list preference?</p>
            <PillGroup<string>
              value={quizList}
              onChange={setQuizList}
              options={[
                { label: 'Any', value: 'any' },
                ...lists.map((l) => ({ label: l.name, value: l.id })),
              ]}
            />
          </div>

          {/* Q4 — Time */}
          <div className="mb-8">
            <p className="text-sm font-semibold text-white mb-3">How much time do you have?</p>
            <PillGroup<TimeOption>
              value={quizTime}
              onChange={setQuizTime}
              options={[
                { label: 'Half day',  value: 'halfday'  },
                { label: 'Full day',  value: 'fullday'  },
                { label: 'Weekend',   value: 'weekend'  },
              ]}
            />
          </div>

          <button
            onClick={submitQuiz}
            disabled={loading || listsLoading}
            className="w-full py-3 rounded-lg bg-emerald-600 hover:bg-emerald-500
                       active:scale-95 transition-all font-semibold text-white text-base
                       disabled:opacity-50 disabled:cursor-not-allowed shadow-lg shadow-emerald-900/40"
          >
            {loading ? 'Finding your peak…' : 'Find My Peak →'}
          </button>

          {/* Location note if drive filter is active */}
          {quizDrive !== 'any' && locationStatus !== 'idle' && (
            <p className={`mt-3 text-xs ${locationStatus === 'granted' ? 'text-emerald-600' : locationStatus === 'denied' ? 'text-red-400' : 'text-stone-500'}`}>
              {locationStatus === 'requesting' && 'Requesting location…'}
              {locationStatus === 'granted' && '📍 Location active'}
              {locationStatus === 'denied' && 'Location denied — try "No limit" for drive distance.'}
            </p>
          )}
        </div>
      )}

      {/* Error */}
      {error && <div className="text-red-400 text-sm mb-6">{error}</div>}

      {/* ── Peak result card (shared by both modes) ── */}
      {peak && (
        <div className="w-full max-w-lg bg-stone-900 border border-stone-800 rounded-2xl overflow-hidden shadow-2xl">

          {wiki?.imageUrl && (
            <div className="w-full h-52 overflow-hidden">
              <img
                src={wiki.imageUrl}
                alt={peak.name}
                className="w-full h-full object-cover"
                onError={(e) => {
                  const p = (e.target as HTMLImageElement).parentElement
                  if (p) p.style.display = 'none'
                }}
              />
            </div>
          )}

          <div className="p-8">

            {/* Name + state + distance */}
            <div className="mb-6">
              <p className="text-xs text-emerald-500 uppercase tracking-widest font-semibold mb-1">Your Peak</p>
              <h2 className="text-3xl font-bold text-white leading-tight">{peak.name}</h2>
              <div className="flex items-center gap-3 mt-1">
                <p className="text-stone-400 text-lg">{peak.state}</p>
                {peakDistanceMi !== null && (
                  <span className="text-sm text-stone-500">· {peakDistanceMi.toLocaleString()} mi from you</span>
                )}
              </div>
            </div>

            {/* Conditions warning */}
            {(() => {
              const { warning } = getConditionsInfo(peak.elevation_ft, peak.state)
              return warning ? (
                <div className="bg-amber-900/40 border border-amber-700/50 rounded-xl px-4 py-3 mb-6">
                  <p className="text-xs text-amber-400 uppercase tracking-widest font-semibold mb-1">⚠ Conditions Notice</p>
                  <p className="text-amber-200 text-sm leading-relaxed">{warning}</p>
                </div>
              ) : null
            })()}

            {/* Wikipedia description */}
            {wiki?.extract && (
              <p className="text-stone-400 text-sm leading-relaxed mb-6">{wiki.extract}</p>
            )}

            {/* Stats grid */}
            <div className="grid grid-cols-2 gap-4 mb-6">
              <div className="bg-stone-800 rounded-xl p-4">
                <p className="text-xs text-stone-500 uppercase tracking-widest mb-1">Elevation</p>
                <p className="text-2xl font-bold text-white">{formatElevation(peak.elevation_ft)}</p>
                <p className="text-sm text-stone-400">{toMeters(peak.elevation_ft)}</p>
              </div>

              {driveTime ? (
                <div className="bg-stone-800 rounded-xl p-4">
                  <p className="text-xs text-stone-500 uppercase tracking-widest mb-1">Drive Time</p>
                  <p className="text-2xl font-bold text-white">
                    {driveTime.hours > 0 ? `${driveTime.hours} hr ${driveTime.minutes} min` : `${driveTime.minutes} min`}
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

              <div className="bg-stone-800 rounded-xl p-4">
                <p className="text-xs text-stone-500 uppercase tracking-widest mb-1">Best Season</p>
                <p className="text-xl font-semibold text-white">
                  {getConditionsInfo(peak.elevation_ft, peak.state).seasonLabel}
                </p>
              </div>

              {nearestTown && (
                <div className="bg-stone-800 rounded-xl p-4">
                  <p className="text-xs text-stone-500 uppercase tracking-widest mb-1">Nearest Town</p>
                  <p className="text-xl font-semibold text-white leading-tight">{nearestTown}</p>
                </div>
              )}

              <div className="bg-stone-800 rounded-xl p-4">
                <p className="text-xs text-stone-500 uppercase tracking-widest mb-1">Coordinates</p>
                <p className="text-sm font-mono text-stone-300 mt-1">{Number(peak.latitude).toFixed(4)}° N</p>
                <p className="text-sm font-mono text-stone-300">{Number(peak.longitude).toFixed(4)}°</p>
              </div>
            </div>

            {/* Action links */}
            <div className="flex flex-wrap gap-3">
              {peak.source_url && (
                <a href={peak.source_url} target="_blank" rel="noopener noreferrer"
                   className="flex-1 text-center px-4 py-2.5 rounded-lg bg-stone-800 hover:bg-stone-700
                              text-stone-300 hover:text-white text-sm font-medium transition-colors">
                  Peakbagger →
                </a>
              )}
              <a href={`https://www.alltrails.com/search?q=${encodeURIComponent(peak.name)}`}
                 target="_blank" rel="noopener noreferrer"
                 className="flex-1 text-center px-4 py-2.5 rounded-lg bg-stone-800 hover:bg-stone-700
                            text-stone-300 hover:text-white text-sm font-medium transition-colors">
                AllTrails →
              </a>
              <a href={`https://www.google.com/maps/search/${encodeURIComponent(peak.name + ' ' + peak.state)}/@${peak.latitude},${peak.longitude},12z`}
                 target="_blank" rel="noopener noreferrer"
                 className="flex-1 text-center px-4 py-2.5 rounded-lg bg-stone-800 hover:bg-stone-700
                            text-stone-300 hover:text-white text-sm font-medium transition-colors">
                Map →
              </a>
            </div>

            {/* Pick again */}
            <button
              onClick={mode === 'quiz' ? submitQuiz : surpriseMe}
              className="w-full mt-4 text-sm text-stone-500 hover:text-stone-300 transition-colors py-2"
            >
              Not feeling it? Pick another →
            </button>

          </div>
        </div>
      )}

      <p className="mt-16 text-stone-700 text-xs">Summit Selector · Peak data via Peakbagger.com</p>
    </main>
  )
}
