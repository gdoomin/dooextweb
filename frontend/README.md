# Frontend

Next.js App Router frontend.

## Current Flow (Client-side KML)

1. User selects a `.kml` file.
2. Browser reads the file with `File.text()`.
3. KML is converted to GeoJSON with `@tmcw/togeojson` in a Web Worker.
4. Geometry is simplified with `@turf/simplify` (adaptive tolerance).
5. Result is rendered with Leaflet `L.geoJSON(...)`.
6. Converted JSON is sent to backend `POST /api/convert` only for persistence/history/viewer URLs.

## Environment

`.env.local`

```env
NEXT_PUBLIC_API_BASE_URL=http://127.0.0.1:8000
```

## Run

```powershell
cd C:\Users\indoo\Desktop\DH_APP\DOO_EXTRACTOR_Web\frontend
npm run dev
```
