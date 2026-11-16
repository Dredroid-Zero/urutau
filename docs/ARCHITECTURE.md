# Architecture

URUTAU is a React 19 / TypeScript front end with a small Express server. A server is required because archive discovery and FITS cutout requests may be large, slow or blocked by browser CORS.

## User journey

\`\`\`text
Aladin Lite atlas / tile grid / target name / RA+Dec
  -> region (ICRS RA, Dec, field of view)
  -> GET /api/spherex/observations
  -> selectable dated spectral image records
  -> GET /api/spherex/cutout (one selected exposure)
  -> decoded FITS data + WCS + flags + variance
  -> common sky projection (Web Worker)
  -> temporal viewer (blink / timeline / differences)
  -> named manual marks and notebook (IndexedDB)
\`\`\`

The three key public-facing concerns are **finding a place**, **finding comparable epochs**, and **saving context**, not exposing every instrument setting on the landing page.

## Runtime boundaries

- \`server.ts\`: calls IRSA TAP/SIA2/IBE; resolves names with CDS Sesame/SIMBAD; queries Gaia DR3 through the configured catalog mirrors; supplies health and cutout endpoints.
- \`src/App.tsx\`: coordinates step navigation and loaded frames, astrometry, selected observations, local investigations.
- \`src/components/SkyExplorer.tsx\`: Aladin Lite (true sky projection) with optional 3×3 clickable region selection. Canvas fallback is a **schematic navigator**, not a substitute for the infrared data.
- \`src/components/ObservationExplorer.tsx\`: separate discovery, filtering and batch selection.
- \`src/components/TemporalViewer.tsx\`: rendering of scientific FITS arrays, controls, WCS overlays, manual annotations. Annotations are placed on the image using WCS coordinates, so their screen locations respond to zoom/pan.
- \`src/lib/astrometry.ts\` and \`src/lib/processing.ts\`: reprojection, detection, association and stacking. These features should remain opt-in and accompanied by quality metrics.
- \`src/lib/notebookDb.ts\`: local IndexedDB storage. Investigations store annotation metadata but not every raw FITS frame; reacquiring an original frame may require a live archive query.

## Archive precedence

1. IRSA TAP discovery of available SPHEREx Level 2 products.
2. IRSA SIA2 fallback when TAP is unavailable or empty.
3. IRSA IBE cutout URL for actual image data.
4. IRSA DR1 All-Sky Cube HiPS tiles for **spectral context only**.

Additional catalog layers and sources **enrich** a SPHEREx observation; they do not become SPHEREx frames. See [DATA_SOURCES.md](DATA_SOURCES.md).

## Scientific assumptions and known risks

- A Level 2 SPHEREx pixel is not directly comparable across arbitrary detectors, wavelengths or spatial projections.
- A cube slice encodes spectral information, not epoch-by-epoch motion.
- The TAP query currently caps records at 200; dense/deep regions may require pagination or more focused constraints.
- External services may time out, use different CORS policies or become unavailable.
- Name resolution may return catalog epochs that must be propagated for high proper motion objects.
- The IBE FITS response can be large for larger cutouts; batch loads need careful concurrency limits.
- The interface provides research/education tools but does not automatically confirm new objects.

## Planned refactors

Keep the current scientific code working before splitting \`server.ts\` into routes/services and the large \`App.tsx\` / viewer into smaller hooks. Prioritize regression tests and consistent data contracts over file moves for their own sake.
