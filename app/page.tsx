'use client'

// Main page — Peak Randomizer
// Shows a list selector dropdown and a "Surprise Me" button.
// On click, picks a random peak from the selected list and displays a result card.

import { useEffect, useState } from 'react'
import { supabase, type List, type Peak } from '@/lib/supabase'

export default function Home() {
  const [lists, setLists] = useState<List[]>([])
  const [selectedListId, setSelectedListId] = useState<string>('any')
  const [peak, setPeak] = useState<Peak | null>(null)
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

  // Pick a random peak from the selected list (or any list)
  async function surpriseMe() {
    setLoading(true)
    setError(null)
    setPeak(null)

    try {
      let peakIds: string[] = []

      if (selectedListId === 'any') {
        // Grab all peak IDs across all lists
        const { data, error } = await supabase
          .from('list_peaks')
          .select('peak_id')

        if (error) throw error
        peakIds = (data ?? []).map((row) => row.peak_id)
      } else {
        // Grab peak IDs for the selected list
        const { data, error } = await supabase
          .from('list_peaks')
          .select('peak_id')
          .eq('list_id', selectedListId)

        if (error) throw error
        peakIds = (data ?? []).map((row) => row.peak_id)
      }

      if (peakIds.length === 0) {
        setError('No peaks found for that list.')
        return
      }

      // Pick a random ID from the results
      const randomId = peakIds[Math.floor(Math.random() * peakIds.length)]

      // Fetch the full peak record
      const { data: peakData, error: peakError } = await supabase
        .from('peaks')
        .select('*')
        .eq('id', randomId)
        .single()

      if (peakError) throw peakError
      setPeak(peakData)
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
      <div className="flex flex-col sm:flex-row gap-4 items-center mb-10 w-full max-w-lg">

        {/* List selector dropdown */}
        <div className="flex-1 w-full">
          <label className="block text-xs text-stone-500 uppercase tracking-widest mb-1.5">
            Summit List
          </label>
          <select
            value={selectedListId}
            onChange={(e) => {
              setSelectedListId(e.target.value)
              setPeak(null)
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

        {/* Surprise Me button */}
        <div className="sm:mt-5">
          <button
            onClick={surpriseMe}
            disabled={loading || listsLoading}
            className="w-full sm:w-auto px-8 py-3 rounded-lg bg-emerald-600 hover:bg-emerald-500
                       active:scale-95 transition-all font-semibold text-white text-base
                       disabled:opacity-50 disabled:cursor-not-allowed shadow-lg shadow-emerald-900/40"
          >
            {loading ? 'Picking…' : '⛰ Surprise Me'}
          </button>
        </div>
      </div>

      {/* Error message */}
      {error && (
        <div className="text-red-400 text-sm mb-6">{error}</div>
      )}

      {/* Peak result card */}
      {peak && (
        <div className="w-full max-w-lg bg-stone-900 border border-stone-800 rounded-2xl p-8 shadow-2xl">

          {/* Peak name + state */}
          <div className="mb-6">
            <p className="text-xs text-emerald-500 uppercase tracking-widest font-semibold mb-1">
              Your Peak
            </p>
            <h2 className="text-3xl font-bold text-white leading-tight">{peak.name}</h2>
            <p className="text-stone-400 text-lg mt-1">{peak.state}</p>
          </div>

          {/* Stats grid */}
          <div className="grid grid-cols-2 gap-4 mb-6">
            <div className="bg-stone-800 rounded-xl p-4">
              <p className="text-xs text-stone-500 uppercase tracking-widest mb-1">Elevation</p>
              <p className="text-2xl font-bold text-white">{formatElevation(peak.elevation_ft)}</p>
              <p className="text-sm text-stone-400">{toMeters(peak.elevation_ft)}</p>
            </div>

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
      )}

      {/* Footer */}
      <p className="mt-16 text-stone-700 text-xs">
        Summit Selector · Peak data via Peakbagger.com
      </p>
    </main>
  )
}
