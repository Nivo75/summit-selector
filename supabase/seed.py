"""
seed.py — Load us_state_highpoints.csv into Supabase

Run this ONCE after applying schema.sql:
  python3 supabase/seed.py

Requires: pip3 install supabase --break-system-packages
"""

import csv
import os
import sys

# ── Supabase credentials ────────────────────────────────────────────────────
SUPABASE_URL = "https://aqxukdrcqzhgerectbfw.supabase.co"
SUPABASE_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImFxeHVrZHJjcXpoZ2VyZWN0YmZ3Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzMxOTA2OTUsImV4cCI6MjA4ODc2NjY5NX0.fXQ_XAPhEFioxAfndMYkwyOx5JIrKVwC-rJvMEMflrE"

try:
    from supabase import create_client
except ImportError:
    print("Missing dependency. Run: pip3 install supabase --break-system-packages")
    sys.exit(1)

# ── File path ───────────────────────────────────────────────────────────────
script_dir = os.path.dirname(os.path.abspath(__file__))
csv_path = os.path.join(script_dir, "..", "us_state_highpoints.csv")

client = create_client(SUPABASE_URL, SUPABASE_KEY)

# ── Step 1: Create the list record ──────────────────────────────────────────
print("Creating list: US State Highpoints...")
list_result = (
    client.table("lists")
    .upsert(
        {
            "slug": "us-state-highpoints",
            "name": "US State Highpoints",
            "description": "The highest point in each of the 50 US states.",
            "peak_count": 50,
        },
        on_conflict="slug",  # don't duplicate if re-run
    )
    .execute()
)

list_id = list_result.data[0]["id"]
print(f"  List ID: {list_id}")

# ── Step 2: Load peaks from CSV ─────────────────────────────────────────────
print("Loading peaks from CSV...")
peaks_inserted = []

with open(csv_path, newline="", encoding="utf-8") as f:
    reader = csv.DictReader(f)
    for row in reader:
        # Convert numeric fields, handle empty strings
        def to_int(val):
            try:
                return int(float(val)) if val.strip() else None
            except (ValueError, AttributeError):
                return None

        def to_float(val):
            try:
                return float(val) if val.strip() else None
            except (ValueError, AttributeError):
                return None

        peak_data = {
            "name":          row["peak_name"].strip(),
            "state":         row["state"].strip(),
            "elevation_ft":  to_int(row["elev_ft"]),
            "latitude":      to_float(row["latitude"]),
            "longitude":     to_float(row["longitude"]),
            "prominence_ft": to_int(row["prominence_ft"]),
            "peak_type":     row["peak_type"].strip() or None,
            "source_url":    row["peak_url"].strip() or None,
        }

        result = client.table("peaks").insert(peak_data).execute()
        peak_id = result.data[0]["id"]
        peaks_inserted.append((peak_id, int(row["rank"])))
        print(f"  Inserted: {peak_data['name']} ({peak_data['state']})")

# ── Step 3: Link peaks to the list via list_peaks ───────────────────────────
print("Linking peaks to list...")
list_peaks_rows = [
    {"list_id": list_id, "peak_id": peak_id, "rank": rank}
    for peak_id, rank in peaks_inserted
]
client.table("list_peaks").insert(list_peaks_rows).execute()

print(f"\nDone! {len(peaks_inserted)} peaks seeded into 'us-state-highpoints'.")
