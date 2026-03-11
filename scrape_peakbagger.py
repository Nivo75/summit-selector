"""
scrape_peakbagger.py
Scrapes U.S. State High Points list from peakbagger.com using the Firecrawl API,
then collects GPS coordinates from each individual peak page.
Output: us_state_highpoints.csv

Dependencies: requests
Usage: python3 scrape_peakbagger.py
"""

import csv
import json
import os
import re
import time
import requests

# ── Configuration ────────────────────────────────────────────────────────────

# Load API key from environment variable (set in .env or export in shell)
# Never hardcode API keys in source files — GitHub will flag them as exposed secrets
FIRECRAWL_API_KEY = os.environ.get("FIRECRAWL_API_KEY", "")
FIRECRAWL_SCRAPE  = "https://api.firecrawl.dev/v1/scrape"

LIST_URL   = "https://www.peakbagger.com/List.aspx?lid=12003&cid=23310"
BASE_URL   = "https://www.peakbagger.com"
OUTPUT_CSV = os.path.join(os.path.dirname(__file__), "us_state_highpoints.csv")
CACHE_FILE = os.path.join(os.path.dirname(__file__), "peak_cache.json")

# Be polite — Firecrawl queues requests but we add a small delay too
REQUEST_DELAY = 1.0  # seconds between peak page calls

# ── Firecrawl helper ─────────────────────────────────────────────────────────

def firecrawl_scrape(url):
    """
    Call Firecrawl /v1/scrape and return plain markdown text.
    Raises on HTTP error or API-level failure.
    """
    headers = {
        "Authorization": f"Bearer {FIRECRAWL_API_KEY}",
        "Content-Type":  "application/json",
    }
    payload = {
        "url":     url,
        "formats": ["markdown"],
    }
    resp = requests.post(FIRECRAWL_SCRAPE, headers=headers, json=payload, timeout=60)
    resp.raise_for_status()
    data = resp.json()

    if not data.get("success"):
        raise RuntimeError(f"Firecrawl reported failure for {url}: {data}")

    return data["data"]["markdown"]


# ── Step 1: Scrape the list page ─────────────────────────────────────────────

def parse_list_markdown(md):
    """
    Parse the Firecrawl markdown of the list page to extract peak rows.

    Firecrawl renders the page as a mix of tables. The header row and data rows
    end up in separate markdown tables (separated by blank lines), so we cannot
    rely on the standard table continuation. Instead we scan every line for
    peak.aspx links and treat those lines as data rows.

    Observed column order (0-indexed):
      0 = Rank  |  1 = State  |  2 = Peak (link)  |  3 = Elev-Ft
      4 = Range  |  5 = Ascents  |  6 = Ascent Date (optional)
    """
    peaks = []

    for line in md.splitlines():
        # Only care about table rows that contain a peak.aspx link
        if "/peak.aspx" not in line:
            continue
        if not line.strip().startswith("|"):
            continue

        # Split on pipe, strip whitespace
        cells = [c.strip() for c in line.strip().strip("|").split("|")]
        if len(cells) < 4:
            continue

        # Find the cell with the peak link
        peak_url     = ""
        pid          = ""
        peak_name_clean = ""

        for cell_text in cells:
            link_match = re.search(
                r"\[([^\]]+)\]\((https?://[^)]*peak\.aspx[^)]*)\)", cell_text, re.I
            )
            if not link_match:
                # Also handle relative URLs (shouldn't appear after Firecrawl but just in case)
                link_match = re.search(
                    r"\[([^\]]+)\]\((/peak\.aspx[^)]*)\)", cell_text, re.I
                )
                if link_match:
                    href = link_match.group(2)
                    peak_name_clean = link_match.group(1).strip()
                    peak_url = BASE_URL + href
                else:
                    continue

            if not peak_name_clean:
                peak_name_clean = link_match.group(1).strip()
                href = link_match.group(2)
                peak_url = href  # already absolute from Firecrawl

            pid_match = re.search(r"pid=(\d+)", peak_url, re.I)
            pid = pid_match.group(1) if pid_match else ""
            break

        if not peak_url:
            continue

        def cell(idx):
            """Return plain text of cell at index, stripping markdown links."""
            if idx < len(cells):
                return re.sub(r"\[([^\]]+)\]\([^\)]+\)", r"\1", cells[idx]).strip()
            return ""

        # Strip trailing punctuation from rank (e.g. "1." → "1")
        rank_raw = re.sub(r"[^0-9]", "", cell(0))

        # Elevation: digits only (remove commas, spaces, etc.)
        elev_raw = re.sub(r"[^\d]", "", cell(3))

        # Range: plain text of cell 4
        range_raw = cell(4)

        # Ascents: cell 5 (digits only)
        asc_raw = re.sub(r"[^\d]", "", cell(5))

        peak = {
            "pid":       pid,
            "rank":      rank_raw,
            "state":     cell(1),
            "peak_name": peak_name_clean,
            "elev_ft":   elev_raw,
            "range":     range_raw,
            "ascents":   asc_raw,
            "peak_url":  peak_url,
        }
        peaks.append(peak)

    return peaks


def scrape_list_page():
    print(f"Fetching list page via Firecrawl: {LIST_URL}")
    md = firecrawl_scrape(LIST_URL)
    peaks = parse_list_markdown(md)
    print(f"  Extracted {len(peaks)} peaks.\n")
    return peaks


# ── Step 2: Scrape each peak page for GPS + extra data ───────────────────────

def scrape_peak_page(peak_url):
    """Fetch a peak page via Firecrawl and extract GPS coordinates + extras."""
    md = firecrawl_scrape(peak_url)

    lat, lon, prominence_ft, peak_type = "", "", "", ""

    # GPS decimal degrees: two signed decimals separated by comma
    # e.g.  "63.0695, -151.0074"  or  "41.408982, -122.194926"
    gps_match = re.search(
        r"(-?\d{1,3}\.\d{4,})\s*,\s*(-?\d{1,3}\.\d{4,})",
        md
    )
    if gps_match:
        lat = gps_match.group(1)
        lon = gps_match.group(2)

    # Prominence ft — look near the word "Prominence"
    prom_match = re.search(
        r"Prominence[^\d]{0,20}?([\d,]+)\s*ft",
        md,
        re.I
    )
    if prom_match:
        prominence_ft = prom_match.group(1).replace(",", "")

    # Peak Type
    type_match = re.search(
        r"Peak Type[:\s\|]+([A-Za-z][A-Za-z ]{1,30}?)(?:\n|\||\s{2,}|$)",
        md,
        re.I
    )
    if type_match:
        peak_type = type_match.group(1).strip()

    return {
        "latitude":      lat,
        "longitude":     lon,
        "prominence_ft": prominence_ft,
        "peak_type":     peak_type,
    }


# ── Cache helpers ─────────────────────────────────────────────────────────────

def load_cache():
    if os.path.exists(CACHE_FILE):
        with open(CACHE_FILE, "r") as f:
            return json.load(f)
    return {}


def save_cache(cache):
    with open(CACHE_FILE, "w") as f:
        json.dump(cache, f, indent=2)


# ── Main ──────────────────────────────────────────────────────────────────────

def main():
    # Step 1
    peaks = scrape_list_page()

    # Step 2
    cache = load_cache()
    total = len(peaks)

    for i, peak in enumerate(peaks, 1):
        pid = peak["pid"]

        if pid and pid in cache:
            print(f"  [{i:>2}/{total}] {peak['peak_name']} — (cached)")
            peak.update(cache[pid])
            continue

        print(f"  [{i:>2}/{total}] Scraping: {peak['peak_name']} ({peak['peak_url']})")
        try:
            details = scrape_peak_page(peak["peak_url"])
            peak.update(details)

            if pid:
                cache[pid] = details
                save_cache(cache)

            if details["latitude"]:
                print(f"           GPS: {details['latitude']}, {details['longitude']}")
            else:
                print(f"           WARNING: no GPS found")

        except Exception as e:
            print(f"           ERROR: {e}")
            peak.update({"latitude": "", "longitude": "", "prominence_ft": "", "peak_type": ""})

        time.sleep(REQUEST_DELAY)

    # Step 3 — write CSV
    fieldnames = [
        "rank", "state", "peak_name", "elev_ft", "range", "ascents",
        "latitude", "longitude", "prominence_ft", "peak_type", "peak_url"
    ]

    with open(OUTPUT_CSV, "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames, extrasaction="ignore")
        writer.writeheader()
        writer.writerows(peaks)

    print(f"\nDone! Wrote {len(peaks)} rows to:\n  {OUTPUT_CSV}")

    missing = [p["peak_name"] for p in peaks if not p.get("latitude")]
    if missing:
        print(f"\nWarning — {len(missing)} peak(s) with no GPS data:")
        for name in missing:
            print(f"  - {name}")
    else:
        print("All peaks have GPS coordinates.")


if __name__ == "__main__":
    main()
