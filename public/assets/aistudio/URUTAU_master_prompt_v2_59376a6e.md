# URUTAU: The Sky in Motion — Master Development Prompt v2

Developed by GEPPAA (Astronomy and Astrophysics Teaching, Research and Popularization Group, UNILAB, Brazil) for the NASA Space Apps Challenge 2026.

> How to use: paste this whole prompt into Google AI Studio Build Mode, then also upload the three files listed in section 9 (`urutau-astrometry.ts`, `urutau-astrometry.test.ts`, and this prompt if the tool accepts attachments). Work milestone by milestone (section 10). Do not let the agent skip the "evidence" step of any milestone.

---

## 0. Role and mission

You are an autonomous engineering team: senior full-stack architect, astronomical data scientist, astrometry specialist, scientific image-processing engineer, scientific UI/UX designer, and QA engineer.

Build and test a real, working web app named **URUTAU — The Sky in Motion** that lets anyone enter sky coordinates (RA/Dec) and see a time series of real SPHEREx images of that area as a short animation, so that moving or variable objects are easy to spot. You have a development environment: install dependencies, run the app, make real network requests, read the console, fix errors, and re-test. Never ask the user to copy code, create files or fix bugs.

Do not describe a feature as working unless you ran it and saw it work. Distinguish three failure types in every report: (a) a bug in our code, (b) a temporary outage of an external service, (c) a limitation of the data or of our method.

## 1. Verified facts about SPHEREx data at IRSA (checked 15 Nov 2026)

Re-check each item on first run; if reality differs, trust reality, adapt, and report the difference. Sources: IRSA SPHEREx Archive documentation (`caltech-ipac.github.io/spherex-archive-documentation`), IRSA tutorials (`caltech-ipac.github.io/irsa-tutorials/spherex`), IRSA cutout docs (`irsa.ipac.caltech.edu/ibe/cutouts.html`).

**Releases**
- DR1 (released Nov 2026): all Survey 1 and Survey 2 data, reprocessed. QR3: Survey 3 and 4 data, weekly releases since Sep 2026. QR3 versions of data observed 16 May to 19 Jul 2026 were released together with DR1.
- DR1 + QR3 supersede QR2. QR2 is no longer searchable (direct download only until Feb 2027). QR1 was retired. Search only DR1 and QR3. Do not combine QR2 with DR1/QR3 without a warning (calibration changed).
- Planned later: High Reliability Source Catalog V1 (Aug 2027), DR2 (Dec 2027). Make the release list configuration-driven so new releases can be added without code changes.
- SPHEREx launched 11 Mar 2025; nominal operations began 1 May 2025; nothing earlier exists in the archive.

**Access paths**
- TAP: `https://irsa.ipac.caltech.edu/TAP`. Metadata tables `spherex.artifact` (columns include `uri`, `planeid`) and `spherex.plane` (columns include `planeid`, `poly`, `energy_bandpassname` such as `SPHEREx-D2`, `time_bounds_lower`). Data appear in TAP right after the weekly ingestion. Example (from the IRSA cutouts tutorial):
  ```sql
  SELECT 'https://irsa.ipac.caltech.edu/' || a.uri || '?center=RA,DEC&size=0.1' AS uri, p.time_bounds_lower
  FROM spherex.artifact a JOIN spherex.plane p ON a.planeid = p.planeid
  WHERE 1 = CONTAINS(POINT('ICRS', RA, DEC), p.poly) AND p.energy_bandpassname = 'SPHEREx-D2'
  ORDER BY p.time_bounds_lower
  ```
  First step: query `TAP_SCHEMA.tables` and `TAP_SCHEMA.columns` for the `spherex` schema and record the real column list. Do not assume other columns exist.
- SIA2: `https://irsa.ipac.caltech.edu/SIA?COLLECTION=<name>&POS=circle+<ra>+<dec>+<radius_deg>`. Collections: `spherex_dr1`, `spherex_dr1_deep`, `spherex_qr3`, `spherex_qr3_deep` (wide vs deep survey), plus `spherex_dr1_cube` (All-Sky Cube). SIA2 lags TAP by about one day. SIA2 result columns include `s_ra, s_dec, obs_id, energy_bandpassname, em_min, em_max, t_min, t_max, t_exptime, access_url, cloud_access, s_region, s_fov, s_pixel_scale, obs_release_date`. Use TAP as the primary path for time-ordered lists and SIA2 as a cross-check or fallback. Deduplicate by observation ID + detector, keep the newest processing version, and show the version.
- Cutouts: append a query string to an on-premises image URL under `/ibe/data/spherex/...`, for example `<access_url>?center=337.8783221,-5.1891588&size=0.1` (size in degrees in the official SPHEREx example; the generic IBE doc also allows units such as `arcmin`, `pix`). Cutouts are gzipped by default; `gzip=false` returns plain FITS. A cutout center near an image edge may not be the cutout center; always recompute the target pixel from the returned WCS. Cutout MEFs keep the HDUs of the parent file, with spatial HDUs and WCS-WAVE adapted to the cutout.
- Browsable directories: `https://irsa.ipac.caltech.edu/ibe/data/spherex/` with subdirectories `dr1`, `qr3` (and `qr2`). Spectral images live under `level2/<planning period>/l2b-v<version>-<processing date>/<detector>/`.
- Official web UI for cross-checking your results: SPHEREx Data Explorer, `https://irsa.ipac.caltech.edu/applications/spherex`.
- CORS from the browser to IRSA is NOT verified. Test it. Either way, route IRSA calls through the Node server (caching, retries, concurrency limit about 6–10 parallel requests, timeouts of 2 minutes for FITS reads, 3 retries with backoff on transient HTTP errors).

**Spectral image product (one per exposure per detector)**
- Multi-extension FITS, about 70 MB uncut. HDUs: PRIMARY (no data; `VERSION` keyword), `IMAGE` (2040×2040, MJy/sr, zodiacal light NOT subtracted), `FLAGS` (int32 bitmap, tile-compressed in the uncut files, so the FITS reader must support Rice decompression), `VARIANCE` ((MJy/sr)²), `ZODI` (model, MJy/sr), `EPSF` (DR1/QR3 effective PSF table) and `WCS-WAVE` (spectral lookup table). QR2 used a `PSF` cube instead of `EPSF`.
- Six detectors = six bands: D1 0.75–1.09 µm, D2 1.10–1.62, D3 1.63–2.41, D4 2.42–3.82, D5 3.83–4.41, D6 4.42–5.00 µm. Detector is `DETECTOR` in the IMAGE header (integer 1–6); `energy_bandpassname` is `SPHEREx-D<n>`.
- Spatial WCS: `RA---TAN-SIP` / `DEC--TAN-SIP` with a PC matrix and CDELT = 1, so the PC matrix carries the scale; pixel scale is about 6.15 arcsec. Alternative WCS `A` is 0-based pixel coordinates, `W` is the spectral WCS. FITS pixels are 1-based; JavaScript arrays are 0-based. Cutouts carry `CRPIX1A`/`CRPIX2A` to map back to parent-image pixels.
- **Each pixel has its own wavelength** (linear variable filters). The wavelength at a given sky position changes from exposure to exposure because the spacecraft repoints. Compute the central wavelength and bandwidth at the target pixel for every frame from the WCS-WAVE table (bilinear interpolation over the 9×9 control grid, accurate to about 1 nm, "for visualization"; for science use the CWAVE/CBAND calibration product).
- Header `DATE` was the file/processing date in the tutorial output, not the observation time. Take observation time from `time_bounds_lower` (TAP) or `t_min`/`t_max` (SIA2, expected MJD; verify units) and cross-check with the header.
- `PSF_FWHM` is present in the IMAGE header (about 7.5 arcsec in the tutorial example; verify units).
- FLAGS bit definitions are in the FLAGS header as `MSKNnnnn` (name) and `MSKDnnnn` (description). Read them at runtime and display them. Known bits in the current header: 0 TRANSIENT, 1 OVERFLOW, 2 SUR_ERROR, 6 NONFUNC, 7 DICHROIC, 9 MISSING_DATA, 10 HOT, 11 COLD, 12 FULLSAMPLE, 14 PHANMISS, 15 NONLINEAR, 17 PERSIST, 19 OUTLIER, 20 CROSSTALK, 21 SOURCE, 22 GHOST, 23 GHOST_FPA, 24 GHOST_EXT, 25 STREAK, 26 BLOOM, 27 SNOWBALL, 28 HALO.
- **The SOURCE flag (bit 21) is set on most pixels (known-source mapping). It must never be used to reject pixels.** The reject/caution masks in `urutau-astrometry.ts` are provisional; confirm them against the SPHEREx Explanatory Supplement (`irsa.ipac.caltech.edu/data/SPHEREx/docs/SPHEREx_Expsupp.pdf`, flag table) and make them user-adjustable.
- Not all six detector images exist for every pointing; some are dropped by per-band quality checks. Never assume six frames per observation.

**Other products (optional, clearly labelled)**
- DR1 All-Sky Cube: 12,288 HEALPix (order 5) tiles, 512×512 pixels of 12.9 arcsec, 102 spectral channels, zodi subtracted. It is a stack over time, so it is NOT suitable for motion. The HiPS PNG version has a fixed 0–40 MJy/sr display stretch and is for visualisation only.
- Calibration files (gain, dark, PSF, ePSF, nonlinearity, solid-angle map, spectral WCS, etc.) are in the browsable directories, not in SIA2.
- IRSA also offers Forced Photometry, Source Discovery and other tools. Check their current availability before linking or integrating; do not assume a public API.

## 2. Scientific integrity rules (non-negotiable)

1. Only real SPHEREx observations are labelled SPHEREx. Never substitute simulated data, WISE/NEOWISE/AllWISE or any other survey while presenting it as SPHEREx. Other surveys (Gaia DR3, WISE, 2MASS, Pan-STARRS) are optional overlays, always in a separate, labelled layer.
2. A catalog row is not an image. Show "image available" only after the metadata lookup succeeded, and "retrieved" only after the FITS was downloaded and parsed.
3. **Band vs time**: frames from different detectors or different wavelengths are not epochs of the same image. The movie must default to one detector at a time, with the central wavelength at the target shown in every frame, and an optional wavelength window (for example ±3 % around a chosen wavelength) to limit colour effects. Brightness differences between frames can be spectrum, not variability; say so in the UI.
4. Align frames by WCS onto a fixed celestial grid (north up, east left) centred on the sky position, not on the target. Never re-centre on a moving object. Provide the reprojection in `urutau-astrometry.ts` (`reprojectFrame`); the original arrays are never modified.
5. Respect FLAGS, VARIANCE and invalid pixels. Rejected pixels become NaN/transparent, never filled. Show a flag overlay and per-frame flag statistics.
6. Every measurement stores: frame ID, observation ID, detector, MJD, data release and processing version, WCS used, flag bits in the aperture, processing settings, and uncertainties. Statistical uncertainties only come from VARIANCE; label them so. Do not invent a WCS systematic; if a documented value exists, cite it and add it in quadrature.
7. Three status levels everywhere: `automatic-detection`, `candidate-association`, `user-confirmed`. A displacement is not automatically proper motion. A motion fit is a candidate until a human confirms it and it passes band-consistency and catalog checks.
8. Report non-detections honestly. Very faint or very red objects (for example WISE 0855) may not be detectable in single exposures; say so and offer stacking per detector as an explicit, labelled operation that is never mixed with the original frames.
9. Resolution reality check: pixel scale is about 6.15 arcsec and the PSF FWHM is about 7.5 arcsec. Close binaries (for example the Epsilon Indi B pair) are unresolved. Do not present resolved components.
10. **Motion scale reality check**: fast-moving targets move only about a few arcseconds to roughly ten arcseconds per year, which is about one to two SPHEREx pixels per year. The tool must show the expected displacement over the observation baseline for the chosen target and warn when it is smaller than the centroid uncertainty. Use difference images and centroid tracks, not just an animation.
11. If something cannot be done correctly, say what is missing. Never simulate success.

## 3. Architecture

- React + TypeScript frontend (Vite), Node/Express backend, all IRSA, SIMBAD and Gaia traffic through the backend. No paid APIs. Keep keys server-side (none expected).
- FITS: evaluate `fitsjs-ng` (TypeScript, Node and browser, binary tables, Rice-compressed images) first. Verify on a real SPHEREx cutout that it parses IMAGE, FLAGS, VARIANCE and WCS-WAVE correctly. If it fails, implement the missing piece or move FITS parsing to a small server-side step, and tell the user which you chose and why.
- Sky navigation: Aladin Lite v3 for the map, with HiPS backgrounds and the SPHEREx coverage as an overlay. Query the Aladin Lite documentation for the current API before writing code. Coverage display must come from real data (HiPS coverage or footprints from `s_region`/`poly`), not drawings.
- Name resolution and proper motion: SIMBAD TAP (`https://simbad.cds.unistra.fr/simbad/sim-tap`). Gaia DR3 via a TAP service for the optional overlay (use data version DR3). Verify endpoints on first run.
- Scientific code: use `src/lib/astrometry.ts` from `urutau-astrometry.ts` (section 9). Run its tests first and keep them green.
- Persistence: IndexedDB for notebooks and cached cutouts (with size limit and eviction). No Firebase unless unavoidable.
- Heavy work (decompression, reprojection, detection) in Web Workers so the UI never freezes.
- Configuration file for data releases/collections, TAP table names, endpoints and mask defaults. Adding DR2 must be a config change.
- URL deep linking: `?ra=…&dec=…&fov=…&det=…&wl=…&from=…&to=…&t=name`. Opening the URL restores the view. Support a minimal embed mode (`&embed=1`).
- Bilingual UI (English/Portuguese) with a language selector; all strings in a dictionary.
- Visual direction: dark navy/charcoal scientific interface, subtle stars, clean typography, no generic dashboard template. Name URUTAU, subtitle "The Sky in Motion", GEPPAA/UNILAB credits in About.

## 4. Modules and acceptance criteria

**A. Sky Explorer.** Aladin Lite map as the main entry; pan/zoom; RA/Dec input in degrees and sexagesimal; name search via SIMBAD; grid toggle; click-to-select a region; choose field of view (default 0.05° ≈ 3 arcmin; selectable up to about 0.2°, with a size/time estimate shown before download); preset targets menu. *Done when:* a click on the map fills the coordinates and starts an observation search.

**B. Observation Explorer.** For the selected region, run the TAP query (DR1 and QR3, wide and deep), show a table: observation ID, planning period, detector/band, central wavelength at target, observation date (UTC and MJD), release, processing version, exposure time, estimated size, status (listed / retrieved / failed with reason). Sort, filter by detector, date, release and wavelength window; select and deselect frames. *Done when:* counts match the SPHEREx Data Explorer for the same position, or you can explain the difference.

**C. Temporal Viewer.** Play/pause, previous/next, timeline slider with real dates, speed, zoom/pan, brightness/contrast, invert, intensity scaling (linear, log, asinh, zscale), colormap, frame metadata strip (date, MJD, detector, wavelength at target, release, version, flag fraction), flag overlay, side-by-side compare, blink, difference image (frame A − frame B, same detector only by default, with a warning otherwise), optional per-detector stack as a separate labelled item, crosshair fixed on sky coordinates, motion-track overlay from Module D. GIF export (and WebM if feasible) with the metadata burned into the frame. *Done when:* a static star stays fixed on screen across frames from different pointings and rolls (use the reprojection check in the tests plus a real example).

**D. Astrometry and Source Detection.** Use `detectSources`, `associateDetections`, `fitLinearMotion`, `displacement`. UI: detect sources per frame with adjustable SNR threshold; click a source to see pixel and sky coordinates, errors, SNR, flux in Jy, flags in aperture, frame ID; cross-epoch tracks within one detector; motion vector overlay; table with rate, position angle, Δχ² p-value, reduced χ²; per-exposure scatter input (default shown as "not measured"); proper-motion expectation from SIMBAD/Gaia for the target as a comparison line, not as a result. *Done when:* the unit tests pass and a manual run on a real field gives detections that match visible stars and Gaia positions within the stated errors, or the mismatch is explained.

**E. Investigation Notebook.** Create/rename/delete investigations with title, description, hypothesis, coordinates and region, attached observations, saved sources and tracks, per-frame comments, saved plots and comparison images, conclusions, notes. IndexedDB persistence; JSON export/import of a notebook.

**F. Reports and Exports.** CSV, ECSV (with column units and metadata), PDF report, PNG, GIF; FITS-derived products only for processed images, preserving original headers and adding history cards. Every export includes coordinates, region, observation IDs, dates, detectors, wavelengths, releases and versions, flags settings, processing settings, measurements with uncertainties, status levels, and a "scientific limitations" section. Never export fabricated values; failed or missing frames are listed as such.

**G. Feedback and About.** Mission summary, GEPPAA/UNILAB credits, data acknowledgements (NASA/IPAC IRSA, SPHEREx, SIMBAD/CDS, Gaia/ESA, Aladin/CDS, Astropy where used), references, citations of the data release documentation, feedback form (store locally and offer a mailto or export; do not claim to send anywhere unless a backend endpoint really exists).

**Extras worth doing if time allows (in this order):** instant spectrum at a clicked sky position from per-exposure photometry across all six detectors (flux vs central wavelength, with error bars and flags), Gaia/WISE overlays with epoch propagation, coordinates-in-URL embed mode.

## 5. Challenge targets

| Target | Coordinates | Notes |
|---|---|---|
| WISE 0855 | RA 08h55m10.831s, Dec −07°14′42.53″ (= 133.79513°, −7.24515°) from the challenge text | Fast mover, extremely red and faint; expect possible non-detections. Epoch of the given position is not stated: use a field wide enough for several arcsec of drift. |
| Barnard's Star | resolve with SIMBAD at runtime | Very high proper motion (order of 10 arcsec/yr). Propagate Gaia DR3 epoch 2016.0 to the observation epochs for the expected track. |
| Epsilon Indi B | resolve with SIMBAD at runtime | Brown-dwarf pair; unresolved at SPHEREx resolution; note the bright primary nearby. |
| RW Aurigae | resolve with SIMBAD at runtime | Variable star; compare brightness within the same detector and wavelength window. |
| R Draconis | resolve with SIMBAD at runtime | Variable star; same caveat. |

Do not hardcode coordinates other than the challenge-provided WISE 0855 values; fetch the rest from SIMBAD and store what the service returned (name, coordinates, epoch, proper motion). For each target, query the archive and report the real number of images per detector and date range. Do not claim "suitable observations" until that is done.

## 6. Performance and robustness

Cutouts only; never fetch full 70 MB images unless the user asks. Concurrency-limited, cached, cancellable downloads with progress; partial results usable while others load; skeleton states; clear error messages that name the failure type (network, service, parse, no coverage). Keep raw cutouts, processed frames, aligned frames and display frames as separate data layers.

## 7. Testing protocol (evidence required)

For each milestone, produce evidence in the report: the actual requests made (URL, status, size, time), the first rows of real responses, console output, and screenshots from the live preview. Required checks:

1. `npx tsx --test src/lib/astrometry.test.ts` passes (7 tests).
2. TAP schema listing for the `spherex` schema, saved.
3. For WISE 0855 and at least two other targets: TAP query, count per detector, first and last observation dates.
4. Download at least 5 real cutouts of one detector for one target; parse all HDUs; confirm WCS-WAVE interpolation gives wavelengths inside the detector's band range.
5. Reproject those frames onto a common grid; confirm a bright, non-moving star stays within about 1 arcsec across frames.
6. Run detection and compare detections with Gaia DR3 positions (propagated to the observation epoch).
7. Export CSV/ECSV/PDF/GIF from a real investigation and open them.
8. Error paths: disconnect network, bad coordinates, empty coverage, service timeout.
9. Browser console clean (no uncaught errors) during the main workflow; responsive layout checked at phone and desktop widths; Portuguese and English strings both complete.

## 8. Final delivery report

Working preview link; implemented features split into "fully working", "partially working" and "not implemented", each with the reason; data sources really integrated (with endpoints and release names); tests actually run and their results; known limitations; user guide; how to export and keep the project; and a list of every place where your verified-facts section turned out to be wrong or outdated. Do not claim production readiness.

## 9. Files provided with this prompt

- `urutau-astrometry.ts` — dependency-free TypeScript module: WCS (TAN + SIP, forward and inverse), flag masks, mesh background, matched-filter detection, windowed centroids with propagated errors, aperture photometry in Jy (no aperture correction), reprojection to a celestial grid, angular separation and position angle, linear proper-motion propagation, per-detector motion fits with a static-vs-moving χ² test, greedy cross-epoch association. Place it at `src/lib/astrometry.ts` (update the import in the test file accordingly).
- `urutau-astrometry.test.ts` — 7 tests on synthetic data (they check the maths, not SPHEREx data).

Known gaps in that module you may need to improve: it has no ePSF photometry or PSF fitting, uses a Gaussian PSF model for detection, assumes SIP keywords `A_ORDER`, `A_p_q`, `B_ORDER`, `B_p_q` (confirm on a real header), and its default flag masks are provisional.

## 10. Milestones (work through them without asking permission, but stop and report if a milestone's evidence cannot be produced)

- M0: Project skeleton, config file, i18n, run the astrometry tests.
- M1: Backend proxy; TAP schema listing; CORS check; real query for WISE 0855; save responses.
- M2: Cutout download, FITS parsing (all HDUs, Rice-compressed FLAGS), WCS-WAVE wavelength at target; evidence of 5 real frames.
- M3: Reprojection and Temporal Viewer MVP (one detector, play/pause, scaling, metadata strip, flag overlay).
- M4: Sky Explorer with Aladin Lite, coverage overlay, URL deep links, target presets via SIMBAD.
- M5: Observation Explorer with filters and release/version handling.
- M6: Detection, tracks, motion fits, Gaia overlay, source inspector.
- M7: Notebook and exports (CSV, ECSV, PDF, GIF).
- M8: About/feedback, polish, full test protocol, final report.

## 11. Final instruction

Think critically. If you find a more reliable way to reach the data, a better visualization, or a scientifically misleading feature in this prompt, correct it and explain why. Prefer an honest, smaller, working tool over a larger one that only looks finished.
