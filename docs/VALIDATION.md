# Scientific and user-experience validation

Last reviewed: 15 November 2026. This is a **verification plan**, not a declaration that end-to-end science has passed.

| Check | Status | Evidence required |
| --- | --- | --- |
| Source structure and API paths reviewed | Reviewed in code | \`server.ts\`, relevant components |
| Mathematical FITS / astrometry unit tests | **Passed in GitHub Actions** | Offline synthetic fixtures; does not establish performance on real SPHEREx data |
| TypeScript and Vite production build | **Passed in GitHub Actions** | [Quality checks](https://github.com/Dredroid-Zero/urutau/actions/workflows/ci.yml) |
| Aladin map drag, click and 3×3 tile overlay | Implementation added, browser check pending | Screen recording or manual QA |
| IRSA TAP or SIA2 returns DR1/QR3 objects | Live test pending | HTTP response and observation ID |
| IRSA IBE returns parseable FITS cutout | Live test pending | FITS filename, headers, sample pixels |
| Reprojected frame alignment | Live test pending | Residual measurements on reference stars |
| Date/wavelength/detector filtering | Manual test pending | Sample record set |
| Frame-by-frame player, speed, blink and diff | Manual browser test pending | Before/after capture with real frames |
| Manual annotation and local persistence | Implementation added, browser test pending | Save, reload, jump to object |
| Gaia DR3 and SIMBAD lookup | Live test pending | Provider response provenance |
| Barnard's Star | Not yet validated | Epoch propagation, matching-band frames |
| Epsilon Indi B | Not yet validated | Resolvability caveat, matching epochs |
| WISE 0855 | Not yet validated | Correct epoch-propagated target; non-detection possible |
| RW Aurigae | Not yet validated | Same-band brightness variation |
| R Draconis | Not yet validated | Same-band brightness variation |
| Small mobile viewport and keyboard-only use | Manual test pending | Accessibility QA |

## Minimal end-to-end acceptance test

1. Start \`npm run dev\` with network access.
2. Select the published QR3 calibration pointing or an arbitrary region.
3. Verify IRSA record identifiers, dates, detector, release and reference URL.
4. Download **two actual FITS cutouts**, checking the server did not substitute cube tiles or synthetic data.
5. Confirm WCS alignment, play/pause, step frames, adjust contrast and zoom.
6. Add a named mark, reload the page, and reopen it through **My discoveries**.
7. Repeat with at least one challenge target, documenting failures and non-detections without fabricated results.

## Claim boundaries

- **Data source integration** means code targets real services. It does not guarantee uptime, access or valid science.
- **Live verified** means actual archive bytes were retrieved, parsed and shown with their provenance.
- **Discovered object** requires confirmation beyond a user mark or blinking frame.
- **Cube channel animation** is spectral browsing, not temporal motion.

## Submission evidence

Provide a short project video, public repository link, a usable deployed URL, citation of archive resources, documented limitations, and (if possible) a reproducible real FITS example. Do not claim full validation on five targets until those tests have been completed.
