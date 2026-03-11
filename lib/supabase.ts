// Supabase client — shared across the app
// NEXT_PUBLIC_ prefix means these are safe to expose in the browser (anon key only)
import { createClient } from '@supabase/supabase-js'

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!

export const supabase = createClient(supabaseUrl, supabaseAnonKey)

// TypeScript types matching our database schema
export type List = {
  id: string
  slug: string
  name: string
  description: string | null
  peak_count: number
}

export type Peak = {
  id: string
  name: string
  state: string
  elevation_ft: number
  latitude: number
  longitude: number
  prominence_ft: number | null
  peak_type: string | null
  source_url: string | null
}
