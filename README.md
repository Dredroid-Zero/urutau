# URUTAU — The Sky in Motion

**Explore the infrared sky. Compare real observations. Keep a research notebook.**

URUTAU is an independent public-facing astronomy web application built for the **2026 NASA Space Apps Challenge — SPHEREx challenge**. The goal is to make astronomical image comparison accessible to curious visitors, citizen scientists and researchers alike.

> URUTAU is an independent project. NASA does not endorse it. Archive availability and scientific interpretation must be checked against the original providers.

## Get started

1. **Explore the sky** — pan and zoom the interactive Aladin Lite atlas, enter a target name or RA/Dec, or click **Choose a sky tile** to pick one of nine visible regions.
2. **Choose images** — query real SPHEREx observations, filter by date, data release, detector and wavelength. Select observations to load.
3. **Watch changes** — play, pause, step through frames, blink, inspect differences and view calibrated FITS cutouts.
4. **Save discoveries** — click **Mark object** in the viewer, name the annotation and save its celestial coordinates and observation metadata to your local notebook.

For a first test, use the documented **SPHEREx QR3 calibration field**. The five challenge targets are also provided; object-name resolution may require a live SIMBAD connection.

### Rodando localmente (Português)

Pré-requisitos: Node.js 22.12+ e npm.

```bash
npm install
npm run dev
```

Abra **http://localhost:3000**. A aplicação integra front-end React/Vite e servidor Express; **não** execute apenas a prévia estática do Vite se quiser consultar o IRSA. Não é necessária uma chave Gemini para as funções astronômicas.

```bash
npm run lint
npm test
npm run build
NODE_ENV=production npm start
```

Node 22+ is recommended. The production server serves the built `dist/` directory and the `/api` routes.

## Is the data real?

The app contains **real archive integration**, not a random-image generator:

- SPHEREx **DR1 + QR3 spectral image records** are queried through IRSA TAP, with SIA2 fallback.
- FITS cutouts are requested from IRSA's IBE service and parsed on the server, including image/WCS/variance/flags where present.
- Gaia DR3 supplies optional contextual catalog sources; SIMBAD/CDS supplies name resolution.
- The SPHEREx DR1 All-Sky Cube is used as an **infrared spectral atlas preview**, not a time-series observation. DSS2, 2MASS and AllWISE are reference map layers, not SPHEREx frames.
- A small, **documented QR3 field** is included as a metadata preset. The FITS pixels still have to download from the real IRSA service; metadata alone is not proof of a successful download.

**Important:** The code has been reviewed for data provenance, but a complete end-to-end live FITS retrieval and all challenge targets have **not yet been independently validated** in this review. The UI should report archive failures rather than substitute invented astronomical observations.

Read [Data sources](docs/DATA_SOURCES.md) and [Validation](docs/VALIDATION.md).

## Source layout

| Path | Responsibility |
| --- | --- |
| `server.ts` | Express API and live IRSA/Gaia/SIMBAD access |
| `src/App.tsx` | User journey, state and notebook persistence wiring |
| `src/components/SkyExplorer.tsx` | Aladin Lite map, tile selection and coordinate search |
| `src/components/ObservationExplorer.tsx` | Observations catalog and filters |
| `src/components/TemporalViewer.tsx` | Image controls, overlays, annotations and playback |
| `src/components/AstrometryPanel.tsx` | Expert measurement tools |
| `src/components/NotebookReports.tsx` | Local reports, exports and saved objects |
| `src/lib/` | FITS, WCS, astrometry, scientific processing and notebook storage |
| `src/config/spherex.ts` | Data-release catalog and IRSA endpoints |
| `src/types/spherex.ts` | Shared models and provenance types |
| `docs/` | Architecture, data sources and validation plan |

Read [Architecture](docs/ARCHITECTURE.md) for the full flow.

## Scientific precautions

- DR1 and QR3 are the recommended compatible releases. Do not quietly mix QR2 or QR1 in a motion sequence.
- Detector filters alone **do not** guarantee identical wavelength; SPHEREx uses linear variable filters. Check the wavelength at the target when interpreting differences.
- Temporal comparison should use WCS alignment and flag/variance quality checks.
- A manual annotation, image difference or source candidate is **not** a confirmed discovery.
- Reports are stored locally via IndexedDB (with a localStorage fallback). Export JSON for backup; clearing browser data can erase notebooks.

## Data citation

SPHEREx Team (2026), *SPHEREx Data Release 1 Spectral Images*, DOI [10.26131/IRSA678](https://doi.org/10.26131/IRSA678). For the DR1 Spectral All-Sky Cube: DOI [10.26131/IRSA679](https://doi.org/10.26131/IRSA679). Follow IRSA's acknowledgement and attribution requirements for each product. Gaia, CDS and other surveys have their own attribution requirements.

See [CONTRIBUTING.md](CONTRIBUTING.md) for development and review conventions.

## Current status

Functional code paths are present for sky navigation, catalog querying, temporal visualization and local notes. **The PR review and CI do not prove live availability** of external astronomy services. Track unresolved checks in [docs/VALIDATION.md](docs/VALIDATION.md).
