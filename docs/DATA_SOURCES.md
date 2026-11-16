# Astronomical data and provenance

URUTAU intentionally connects to **multiple scientific providers**, but roles must remain explicit. A reference image from another mission must never be misrepresented as a SPHEREx time frame.

| Provider | URL | Used for | Distinction |
| --- | --- | --- | --- |
| NASA/IPAC IRSA SPHEREx | https://irsa.ipac.caltech.edu/Missions/spherex.html | DR1 and QR3 observation discovery, Level 2 FITS, flags, wavelength/WCS | Primary time-series source |
| IRSA SPHEREx HiPS | https://irsa.ipac.caltech.edu/spherex-archive-documentation/ | DR1 spectral all-sky visualization | Wavelength slices, **not epochs** |
| ESA Gaia DR3 | https://gea.esac.esa.int/archive/ | Reference astrometry and proper motions | Catalog overlay, not SPHEREx image |
| CDS SIMBAD / Sesame | https://simbad.cds.unistra.fr/simbad/ | Resolve target names to coordinates | Metadata resolver |
| DSS2 / 2MASS / AllWISE | via Aladin Lite HiPS services | Navigable background and cross-survey context | Historical survey layers, not SPHEREx |
| Aladin Lite (CDS) | https://aladin.cds.unistra.fr/AladinLite/ | Interactive sky projection and navigation | Interface library |

For SPHEREx current releases, follow https://irsa.ipac.caltech.edu/spherex-archive-documentation/spherex-data-releases/ . DR1 (Surveys 1–2) and QR3 (Surveys 3–4) use compatible reprocessing; QR2 has been superseded and should not be mixed into primary comparisons.

**Archive lookup is not proof of a successful image download.** A row has `provenanceSource` and `fetchStatus`. Actual pixels are displayed only when IRSA returns a readable FITS cutout. The built-in calibration-field preset references published filenames; it is not an offline image fixture.

The viewer also supports user-generated labels: each saved label stores name, color, shape, RA, Dec, original image ID, image date, pixel coordinates at marking time and creation time. These records are annotations, not source catalog detections.

## Citation

- SPHEREx Team (2026), *SPHEREx DR1 Spectral Images*, https://doi.org/10.26131/IRSA678
- SPHEREx Team (2026), *SPHEREx DR1 Spectral All-Sky Cube*, https://doi.org/10.26131/IRSA679

The relevant providers may require additional acknowledgements for publications and derivative outputs. Check their current license and attribution terms before redistributing images.
