// /api/drive-time — server-side proxy for the Google Routes API
//
// Why a proxy?
//   The Maps API key must never be exposed to the browser.
//   All drive time requests go through here so the key stays server-side.
//
// Rate limiting (two layers):
//   - 20 requests per IP per day  → protects against a single user hammering "Pick another"
//   - 200 requests globally per day → keeps us inside the 10,000/month free tier
//   Both counters are stored in the Supabase `rate_limits` table.
//   If either limit is hit we return 429 — the UI silently hides the drive time field.

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

const PER_IP_DAILY_LIMIT = 20
const GLOBAL_DAILY_LIMIT = 200

// Supabase client — uses anon key (rate_limits table has RLS disabled, no sensitive data)
const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
)

export async function POST(req: NextRequest) {
  // Extract requester IP (Vercel always sets x-forwarded-for)
  const ip =
    req.headers.get('x-forwarded-for')?.split(',')[0].trim() ?? 'unknown'
  const today = new Date().toISOString().split('T')[0] // YYYY-MM-DD

  // --- Rate limit: per IP ---
  const { data: ipRow } = await supabase
    .from('rate_limits')
    .select('count')
    .eq('ip', ip)
    .eq('date', today)
    .maybeSingle()

  if (ipRow && ipRow.count >= PER_IP_DAILY_LIMIT) {
    return NextResponse.json(
      { error: 'Daily drive-time limit reached for your IP.' },
      { status: 429 }
    )
  }

  // --- Rate limit: global daily cap ---
  const { data: globalRows } = await supabase
    .from('rate_limits')
    .select('count')
    .eq('date', today)

  const globalTotal = (globalRows ?? []).reduce(
    (sum, row) => sum + (row.count ?? 0),
    0
  )
  if (globalTotal >= GLOBAL_DAILY_LIMIT) {
    return NextResponse.json(
      { error: 'Global daily drive-time limit reached.' },
      { status: 429 }
    )
  }

  // --- Parse request body ---
  let body: { originLat?: number; originLon?: number; destLat?: number; destLon?: number }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid request body.' }, { status: 400 })
  }

  const { originLat, originLon, destLat, destLon } = body
  if (originLat == null || originLon == null || destLat == null || destLon == null) {
    return NextResponse.json({ error: 'Missing coordinates.' }, { status: 400 })
  }

  // --- Call Google Routes API ---
  const mapsKey = process.env.MAPS_API_KEY
  if (!mapsKey) {
    return NextResponse.json(
      { error: 'Maps API key not configured.' },
      { status: 500 }
    )
  }

  const routesRes = await fetch(
    'https://routes.googleapis.com/directions/v2:computeRoutes',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': mapsKey,
        // FieldMask tells Google which fields to return — keeps response small
        'X-Goog-FieldMask': 'routes.duration,routes.distanceMeters',
      },
      body: JSON.stringify({
        origin: {
          location: { latLng: { latitude: originLat, longitude: originLon } },
        },
        destination: {
          location: { latLng: { latitude: destLat, longitude: destLon } },
        },
        travelMode: 'DRIVE',
        routingPreference: 'TRAFFIC_UNAWARE', // no live traffic = free tier
      }),
    }
  )

  if (!routesRes.ok) {
    const text = await routesRes.text()
    console.error('Routes API error:', text)
    return NextResponse.json({ error: 'Routes API error.' }, { status: 502 })
  }

  const routesData = await routesRes.json()
  const route = routesData.routes?.[0]
  if (!route) {
    return NextResponse.json({ error: 'No route found.' }, { status: 404 })
  }

  // duration comes back as e.g. "7234s" — strip the 's' and convert
  const durationSec = parseInt(
    (route.duration ?? '0s').replace('s', ''),
    10
  )
  const hours = Math.floor(durationSec / 3600)
  const minutes = Math.round((durationSec % 3600) / 60)
  const distanceMi = Math.round((route.distanceMeters ?? 0) / 1609.34)

  // --- Increment rate limit counter ---
  // Read-then-write is fine for this low-traffic app (no race condition risk)
  if (ipRow) {
    await supabase
      .from('rate_limits')
      .update({ count: ipRow.count + 1 })
      .eq('ip', ip)
      .eq('date', today)
  } else {
    await supabase
      .from('rate_limits')
      .insert({ ip, date: today, count: 1 })
  }

  return NextResponse.json({ hours, minutes, distanceMi })
}
