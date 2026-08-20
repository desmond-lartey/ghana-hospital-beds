#!/usr/bin/env python3
"""
Recompute the status field and simplestyle marker colours for every hospital
feature from its reported bed counts.

GeoLibre renders a vector layer per-feature when its features carry
simplestyle-spec properties, so setting marker-color here is all that is
needed to drive the green / yellow / red map. No custom style file required.

Usage:
    python3 update_status.py hospitals.geojson
    python3 update_status.py hospitals.geojson --out styled.geojson
"""

import argparse
import json
import sys

# Colours are drawn from a colourblind-safer palette rather than pure RGB,
# so the three states stay distinguishable for red-green colour blindness.
PALETTE = {
    "available": {"marker": "#1D9E75", "stroke": "#0F6E56"},   # green
    "limited":   {"marker": "#EF9F27", "stroke": "#854F0B"},   # amber
    "full":      {"marker": "#E24B4A", "stroke": "#A32D2D"},   # red
    "unreported": {"marker": "#888780", "stroke": "#5F5E5A"},  # grey
}

# Thresholds. Adjust to match the project brief.
LIMITED_EMERGENCY = 3
LIMITED_ICU = 2
LIMITED_GENERAL = 5 


def classify(props):
    """Return one of: unreported, full, limited, available."""
    beds = [props.get("emergency_beds"),
            props.get("icu_beds"),
            props.get("general_beds")]

    if any(b is None for b in beds):
        return "unreported"

    emergency, icu, general = beds

    if emergency == 0 or icu == 0 or general == 0:
        return "full"

    if (emergency <= LIMITED_EMERGENCY
            or icu <= LIMITED_ICU
            or general <= LIMITED_GENERAL):
        return "limited"

    return "available"


def apply_style(feature):
    props = feature.setdefault("properties", {})
    status = classify(props)
    colours = PALETTE[status]

    props["status"] = status
    props["marker-color"] = colours["marker"]
    props["stroke"] = colours["stroke"]
    props["fill"] = colours["marker"]
    props.setdefault("marker-size", "medium")
    props.setdefault("stroke-width", 1)
    props.setdefault("fill-opacity", 0.7)
    return status


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("geojson", help="input GeoJSON file")
    parser.add_argument("--out", help="output file (defaults to editing in place)")
    args = parser.parse_args()

    with open(args.geojson, encoding="utf-8") as handle:
        data = json.load(handle)

    features = data.get("features", [])
    if not features:
        sys.exit("No features found in the input file.")

    tally = {}
    for feature in features:
        status = apply_style(feature)
        tally[status] = tally.get(status, 0) + 1

    destination = args.out or args.geojson
    with open(destination, "w", encoding="utf-8") as handle:
        json.dump(data, handle, indent=2, ensure_ascii=False)
        handle.write("\n")

    print(f"Styled {len(features)} features -> {destination}")
    for status in ("available", "limited", "full", "unreported"):
        if status in tally:
            print(f"  {status:<12} {tally[status]}")


if __name__ == "__main__":
    main()
