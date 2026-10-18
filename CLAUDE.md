# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Parse all GPX files and regenerate catalog-data.js
node scripts/build-catalog.js

# Serve and open the viewer at http://localhost:8080
npm start

# Build catalog + start server in one step
npm run dev
```

`catalog-data.js` is auto-generated — never edit it by hand. Always re-run the build script after changing `scripts/build-catalog.js` or adding/removing GPX files.

The viewer works only from a local HTTP server, not `file://`, because it loads `catalog-data.js` via `<script src>`.

## Architecture

This is a static two-file project with a separate build step:

### Build step — `scripts/build-catalog.js` (Node.js, no npm deps)
Recursively walks `TracksGps/`, parses every `.gpx` file with `indexOf`-based XML parsing (no library), and writes `catalog-data.js` which exposes a global `const CATALOG = [...]`.

Each catalog entry:
```js
{
  name, file,
  category,   // first-level subfolder under TracksGps/, or "General"
  zone,       // second-level subfolder, or null
  date,       // YYYY-MM-DD from metadata/time, first trkpt/time, or filename prefix
  distance,   // km, haversine sum
  elevationGain, elevationLoss,  // metres, cumulative
  minElevation, maxElevation,
  bounds,     // [[minLat,minLon],[maxLat,maxLon]]
  center,     // [lat,lon]
  points      // simplified to ≤150 pts: [[lat,lon,ele|null], ...]
}
```

`MAX_POINTS = 150` controls simplification (uniform sampling). Files containing only `<wpt>` waypoints (no `<trkpt>`) are silently skipped.

### Viewer — `index.html` (vanilla JS + Leaflet 1.9.4 from cdnjs)
Single-page app that reads the global `CATALOG` array. Key sections of the inline script:

- **Color assignment** — categories get colors from a 12-entry `PALETTE` in stable sorted order.
- **Polylines** — all tracks rendered at startup with Leaflet's Canvas renderer (`L.canvas()`). Visibility is toggled with `layer.addTo(map)` / `layer.remove()` rather than opacity, to keep 370+ tracks fast.
- **`activateTrack(i, fitMap)`** — selects a track: highlights polyline, fits bounds, opens popup, and calls `showProfile()`.
- **`showProfile(track, color)`** — renders an SVG elevation chart in `#profile` panel below the map. Uses `requestAnimationFrame` so the SVG has a real bounding rect before drawing. Elevation is read from `track.points[n][2]`. Cumulative distances are recomputed client-side with `hav()`.
- **`applyFilters()`** — called on every filter change; iterates all items, shows/hides layers, re-renders the list.
- Layout: `#main` is a flex row; `#right-col` is a flex column containing `#map` (flex:1) and `#profile` (height:175px, hidden until a track is selected). Showing/hiding the profile calls `map.invalidateSize()`.

## GPX file conventions
- Source tracks live in `TracksGps/` and are never modified by the build.
- The folder structure (`TracksGps/<category>/<zone>/track.gpx`) defines `category` and `zone` metadata.
- Files with a `YYYY-MM-DD` prefix in the filename get that date if no `<time>` tag is present.
- Waypoint-only files (`.wpt`, or `.gpx` with only `<wpt>` elements) are not rendered.
