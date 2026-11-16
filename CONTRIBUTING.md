# Contributing to URUTAU

URUTAU serves two audiences: people exploring astronomy for the first time and people who need traceable scientific data. Changes must respect both.

## Development

1. Open an issue describing the user problem or scientific bug.
2. Work in a short-lived branch. Avoid unrelated sweeping rewrites.
3. Run `npm run lint`, `npm test` and `npm run build`.
4. Create a pull request with **what changed**, **how you tested**, **what remains unverified**, and screenshots for visible UI changes.

## Source conventions

- Keep UI state in `src/App.tsx` and presentation logic in focused components.
- Prefer a small, named function over duplicated inline callbacks when an action repeats.
- Label coordinates using the **ICRS frame** and degrees or sexagesimal units.
- Preserve observation identifiers, UTC/MJD epochs, release, detector, wavelength and archive path.
- Never silently create simulated SPHEREx pixels to fill a missing IRSA observation.
- Label reference imagery as reference imagery. Spectral cube channels are **wavelength slices**, not successive dates.
- Avoid destructive schema migrations: existing IndexedDB investigations should still load.
- Keep expert controls discoverable but secondary to the basic journey.
- Check keyboard navigation and mobile layout for new controls.

## Testing

The existing tests under `src/lib/*.test.ts` use synthetic fixtures for numeric algorithms. Their success does **not** establish scientific performance on SPHEREx images. Maintain live manual checks separately in [docs/VALIDATION.md](docs/VALIDATION.md).

## Pull request checklist

- [ ] A beginner can explain where to click next.
- [ ] Archive failures are surfaced clearly.
- [ ] Data provenance and release compatibility remain visible.
- [ ] New scientific processing has unit tests and at least one real-data validation case, when possible.
- [ ] Documentation matches functionality.
- [ ] No secrets, large FITS downloads or generated build directories are committed.

## Licensing

A source-code license has **not** yet been selected by the repository owner. Do not add one or claim the software is permissively licensed without that decision. Data belong to their respective providers and follow their published conditions.
