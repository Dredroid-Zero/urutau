import { angularSeparationArcsec, positionAngleDeg } from './astronomy';
import { pixelToWorld, wavelengthAtPixel } from './fits';
import type { CrossEpochMotionCandidate, DetectedSource, LoadedSpherexFrame } from '../types/spherex';

export interface DetectionOptions {
  snrThreshold: number;
  apertureRadiusPx: number;
  maxSources?: number;
}

/**
 * Estimates robust background median and MAD-based noise std from finite, unflagged pixels.
 */
export function estimateBackgroundStats(
  image: Float32Array,
  flags?: Uint32Array,
): { median: number; sigmaMad: number } {
  const samples: number[] = [];
  for (let i = 0; i < image.length; i++) {
    const v = image[i];
    if (!Number.isFinite(v)) continue;
    if (flags && (flags[i] & (1 << 6 | 1 << 9 | 1 << 1)) !== 0) continue; // NONFUNC | MISSING | OVERFLOW
    samples.push(v);
  }
  if (samples.length === 0) return { median: 0, sigmaMad: 1e-3 };
  samples.sort((a, b) => a - b);
  const median = samples[Math.floor(samples.length / 2)];
  const absDevs = samples.map((v) => Math.abs(v - median)).sort((a, b) => a - b);
  const mad = absDevs[Math.floor(absDevs.length / 2)];
  const sigmaMad = Math.max(1e-6, 1.4826 * mad);
  return { median, sigmaMad };
}

/**
 * Detects astronomical point-like sources in a 2D SPHEREx frame using local maxima,
 * intensity-weighted sub-pixel centroiding, and circular aperture photometry with
 * variance HDU error propagation.
 */
export function detectSourcesInFrame(
  frame: LoadedSpherexFrame,
  options: DetectionOptions,
): DetectedSource[] {
  const { width, height, image, variance, zodi, flags, wcs, waveWcs, observation } = frame;
  const { median, sigmaMad } = estimateBackgroundStats(image, flags);
  const threshold = median + options.snrThreshold * sigmaMad;
  const minSepPx = Math.max(3, Math.round(options.apertureRadiusPx));
  const pixelScaleArcsec = 6.2; // SPHEREx native plate scale 6.2"/pixel
  const pixelSolidAngleSr = Math.pow((pixelScaleArcsec / 3600) * (Math.PI / 180), 2);

  // Critical bad-pixel bits: NONFUNC (6), MISSING_DATA (9), OVERFLOW (1)
  const fatalMask = (1 << 1) | (1 << 6) | (1 << 9);

  const candidates: { x: number; y: number; val: number }[] = [];
  for (let y = 2; y < height - 2; y++) {
    for (let x = 2; x < width - 2; x++) {
      const idx = y * width + x;
      const v = image[idx];
      if (!Number.isFinite(v) || v < threshold) continue;
      if (flags && (flags[idx] & fatalMask) !== 0) continue;

      let isMax = true;
      for (let dy = -1; dy <= 1 && isMax; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue;
          const nv = image[(y + dy) * width + (x + dx)];
          if (Number.isFinite(nv) && nv > v) {
            isMax = false;
            break;
          }
        }
      }
      if (isMax) candidates.push({ x, y, val: v });
    }
  }

  candidates.sort((a, b) => b.val - a.val);

  const accepted: { x: number; y: number }[] = [];
  const results: DetectedSource[] = [];
  const maxSources = options.maxSources ?? 40;
  const apR = Math.max(1.5, options.apertureRadiusPx);
  const annIn = apR + 1.5;
  const annOut = apR + 4.0;

  for (const cand of candidates) {
    if (results.length >= maxSources) break;
    if (accepted.some((p) => Math.hypot(p.x - cand.x, p.y - cand.y) < minSepPx)) continue;

    // 1. Sub-pixel intensity-weighted centroid in 5x5 box around peak
    let sumW = 0;
    let sumWx = 0;
    let sumWy = 0;
    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -2; dx <= 2; dx++) {
        const px = cand.x + dx;
        const py = cand.y + dy;
        if (px < 0 || px >= width || py < 0 || py >= height) continue;
        const idx = py * width + px;
        if (flags && (flags[idx] & fatalMask) !== 0) continue;
        const w = Math.max(0, image[idx] - median);
        sumW += w;
        sumWx += w * px;
        sumWy += w * py;
      }
    }
    const cx = sumW > 0 ? sumWx / sumW : cand.x;
    const cy = sumW > 0 ? sumWy / sumW : cand.y;

    // 2. Local sky annulus median
    const annVals: number[] = [];
    const rSearch = Math.ceil(annOut);
    for (let dy = -rSearch; dy <= rSearch; dy++) {
      for (let dx = -rSearch; dx <= rSearch; dx++) {
        const r = Math.hypot(dx, dy);
        if (r < annIn || r > annOut) continue;
        const px = Math.round(cx) + dx;
        const py = Math.round(cy) + dy;
        if (px < 0 || px >= width || py < 0 || py >= height) continue;
        const idx = py * width + px;
        if (flags && (flags[idx] & fatalMask) !== 0) continue;
        const val = image[idx];
        if (Number.isFinite(val)) annVals.push(val);
      }
    }
    annVals.sort((a, b) => a - b);
    const localSky = annVals.length > 0 ? annVals[Math.floor(annVals.length / 2)] : median;

    // 3. Circular aperture photometry + variance propagation + second-moment FWHM
    let apFlux = 0;
    let apVar = 0;
    let apPixels = 0;
    let flaggedCount = 0;
    let zodiSum = 0;
    let zodiCount = 0;
    let m2Sum = 0;
    let m2Weight = 0;

    const rApCeil = Math.ceil(apR);
    for (let dy = -rApCeil; dy <= rApCeil; dy++) {
      for (let dx = -rApCeil; dx <= rApCeil; dx++) {
        const px = Math.round(cx) + dx;
        const py = Math.round(cy) + dy;
        if (px < 0 || px >= width || py < 0 || py >= height) continue;
        const dist = Math.hypot(px - cx, py - cy);
        if (dist > apR) continue;
        const idx = py * width + px;
        const val = image[idx];
        if (!Number.isFinite(val)) continue;
        apPixels++;
        if (flags && flags[idx] !== 0) flaggedCount++;
        const net = val - localSky;
        apFlux += net;
        if (net > 0) {
          m2Sum += net * dist * dist;
          m2Weight += net;
        }
        if (variance && Number.isFinite(variance[idx]) && variance[idx] >= 0) {
          apVar += variance[idx];
        } else {
          apVar += sigmaMad * sigmaMad;
        }
        if (zodi && Number.isFinite(zodi[idx])) {
          zodiSum += zodi[idx];
          zodiCount++;
        }
      }
    }

    if (apPixels === 0 || apFlux <= 0) continue;
    const fluxErr = Math.sqrt(Math.max(1e-12, apVar));
    const snr = apFlux / fluxErr;
    if (snr < options.snrThreshold * 0.6) continue;

    // 1 MJy/sr = 1e6 Jy/sr -> multiply by pixel solid angle (sr/pixel)
    const apertureFluxJy = apFlux * 1e6 * pixelSolidAngleSr;

    // Empirical Gaussian sigma -> FWHM = 2.355 * sigma
    const sigmaPx = m2Weight > 0 ? Math.sqrt(Math.max(0.25, m2Sum / (2 * m2Weight))) : 1.0;
    const fwhmPx = 2.355 * sigmaPx;

    // Astrometric centroid uncertainty ~ FWHM / (2.355 * SNR) with systematic floor 0.05 px
    const centroidErrorPx = Math.hypot(0.05, fwhmPx / (2.355 * Math.max(1, snr)));
    const astrometricUncertaintyArcsec = centroidErrorPx * pixelScaleArcsec;

    const skyPos = wcs
      ? pixelToWorld(cx, cy, wcs)
      : { ra: frame.cutoutCenterRa, dec: frame.cutoutCenterDec };

    let wavelengthUm = frame.sliceWavelengthUm;
    let bandwidthUm: number | undefined;
    if (waveWcs) {
      const w = wavelengthAtPixel(cx, cy, waveWcs);
      wavelengthUm = w.wavelengthUm;
      bandwidthUm = w.bandwidthUm;
    }

    accepted.push({ x: cx, y: cy });
    results.push({
      id: `${frame.frameId}-src-${results.length + 1}`,
      frameId: frame.frameId,
      obsId: observation.obsId,
      dateObs: observation.dateObs,
      mjdObs: observation.mjdObs,
      detector: observation.detector,
      bandpassName: observation.bandpassName,
      x: cx,
      y: cy,
      ra: skyPos.ra,
      dec: skyPos.dec,
      centroidErrorPx,
      astrometricUncertaintyArcsec,
      snr,
      peakFluxMJySr: cand.val - localSky,
      apertureFluxMJySr: apFlux,
      apertureFluxJy,
      fluxUncertaintyMJySr: fluxErr,
      zodiBackgroundMJySr: zodiCount > 0 ? zodiSum / zodiCount : 0,
      fwhmPx,
      wavelengthUm,
      bandwidthUm,
      flaggedPixelsInAperture: flaggedCount,
      qualityNote: flaggedCount > 0
        ? `${flaggedCount} flagged pixel(s) in aperture`
        : 'Clean aperture',
      status: 'automatic_detection',
    });
  }

  return results;
}

/**
 * Associates detected sources across two frames by celestial proximity and evaluates
 * whether angular displacement exceeds combined astrometric uncertainty (without
 * conflating spectral bandpass shifts with proper motion).
 */
export function associateSourcesAcrossEpochs(
  sourcesA: DetectedSource[],
  sourcesB: DetectedSource[],
  matchRadiusArcsec: number,
): CrossEpochMotionCandidate[] {
  const candidates: CrossEpochMotionCandidate[] = [];
  const usedB = new Set<string>();

  for (const srcA of sourcesA) {
    let bestB: DetectedSource | null = null;
    let bestSep = Infinity;
    for (const srcB of sourcesB) {
      if (usedB.has(srcB.id)) continue;
      const sep = angularSeparationArcsec(
        { ra: srcA.ra, dec: srcA.dec },
        { ra: srcB.ra, dec: srcB.dec },
      );
      if (sep <= matchRadiusArcsec && sep < bestSep) {
        bestSep = sep;
        bestB = srcB;
      }
    }
    if (!bestB) continue;
    usedB.add(bestB.id);

    const deltaTimeDays = bestB.mjdObs - srcA.mjdObs;
    const absDays = Math.abs(deltaTimeDays);
    const cosDec = Math.cos(((srcA.dec + bestB.dec) / 2) * (Math.PI / 180));
    const deltaRaArcsec = (bestB.ra - srcA.ra) * cosDec * 3600;
    const deltaDecArcsec = (bestB.dec - srcA.dec) * 3600;
    const pa = positionAngleDeg(
      { ra: srcA.ra, dec: srcA.dec },
      { ra: bestB.ra, dec: bestB.dec },
    );
    const combinedUncertaintyArcsec = Math.hypot(
      srcA.astrometricUncertaintyArcsec,
      bestB.astrometricUncertaintyArcsec,
    );
    const sigmaSignificance = bestSep / Math.max(1e-4, combinedUncertaintyArcsec);
    const apparentRateArcsecYr = absDays > 0.01 ? (bestSep / (absDays / 365.25)) : 0;
    const sameBand = srcA.bandpassName === bestB.bandpassName;

    let classification: CrossEpochMotionCandidate['classification'] = 'consistent_with_noise';
    let cautionNote = 'Displacement is within combined centroid/WCS uncertainty.';

    if (!sameBand) {
      classification = 'bandpass_shift_caution';
      cautionNote = `Different spectral bands (${srcA.bandpassName} vs ${bestB.bandpassName}): PSF chromatic variation or SED structure can shift centroids.`;
    } else if (absDays < 0.01) {
      classification = 'consistent_with_noise';
      cautionNote = 'Observations share nearly identical epoch (< 15 min); displacement reflects noise/jitter rather than proper motion.';
    } else if (sigmaSignificance >= 3.0) {
      classification = 'candidate_motion';
      cautionNote = `Displacement (${bestSep.toFixed(2)}") exceeds 3σ combined astrometric uncertainty over ${absDays.toFixed(2)} d; requires visual & PSF inspection.`;
    }

    candidates.push({
      id: `match-${srcA.id}-${bestB.id}`,
      sourceA: srcA,
      sourceB: bestB,
      deltaTimeDays,
      deltaArcsec: bestSep,
      deltaRaArcsec,
      deltaDecArcsec,
      positionAngleDeg: pa,
      combinedUncertaintyArcsec,
      sigmaSignificance,
      apparentRateArcsecYr,
      sameBand,
      classification,
      cautionNote,
    });
  }

  return candidates.sort((a, b) => b.sigmaSignificance - a.sigmaSignificance);
}
