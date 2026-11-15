import { jsPDF } from 'jspdf';
import type { InvestigationRecord } from '../types/spherex';

function buildExportMetadataBlock(inv: InvestigationRecord) {
  const proc = inv.processingSettings ?? {
    snrThreshold: 5,
    maxRateArcsecYr: 15,
    rejectMask: 0x28647,
    cautionMask: 0x1fdc4880,
    extraScatterArcsec: 0,
    reprojectedToSkyGrid: true,
  };
  const failedObs = inv.observations.filter((o) => o.fetchStatus === 'failed');
  return {
    proc,
    failedObs,
    limitations: [
      'Statistical uncertainties come strictly from the VARIANCE HDU; no unmeasured WCS systematic floor is invented.',
      'Aperture photometry applies no ePSF aperture correction.',
      'Different detectors/bands have distinct PSFs and LVF wavelengths; cross-detector differences can reflect spectrum, not motion or variability.',
      'Significant motion fits remain candidate-association until confirmed by visual inspection, band-consistency checks, and external catalog comparison (e.g. Gaia DR3).',
      'SOURCE flag (bit 21) is never used for pixel rejection.',
    ],
  };
}

export function exportInvestigationCsv(inv: InvestigationRecord): string {
  const meta = buildExportMetadataBlock(inv);
  const astrom = inv.astrometryDetections ?? [];
  const header = [
    'record_type',
    'source_id',
    'frame_id',
    'obs_id',
    'date_obs',
    'mjd_obs',
    'detector',
    'release',
    'version',
    'wavelength_um',
    'ra_deg',
    'dec_deg',
    'x_px',
    'y_px',
    'ra_err_arcsec',
    'dec_err_arcsec',
    'snr',
    'flux_jy',
    'flux_err_jy',
    'flag_bits_hex',
    'caution_flagged',
    'reject_flagged',
    'status',
    'snr_threshold',
    'reject_mask_hex',
    'caution_mask_hex',
    'extra_scatter_arcsec',
    'notes',
  ].join(',');

  const rows: string[] = [];

  if (astrom.length > 0) {
    for (const d of astrom) {
      rows.push(
        [
          'astrometry_detection',
          csvEscape(d.id),
          csvEscape(d.frameId),
          csvEscape(d.obsId),
          csvEscape(d.dateObs),
          d.mjd.toFixed(6),
          d.detector,
          csvEscape(d.release),
          csvEscape(d.version),
          d.wavelengthUm !== undefined ? d.wavelengthUm.toFixed(4) : '',
          d.ra.toFixed(7),
          d.dec.toFixed(7),
          d.x.toFixed(3),
          d.y.toFixed(3),
          d.raErrArcsec.toFixed(4),
          d.decErrArcsec.toFixed(4),
          d.snr.toFixed(2),
          d.fluxJy.toExponential(4),
          d.fluxErrJy.toExponential(4),
          `0x${(d.flagBitsInAperture >>> 0).toString(16)}`,
          d.cautionFlagged,
          d.rejectFlagged,
          csvEscape(d.status),
          meta.proc.snrThreshold,
          `0x${(d.rejectMaskUsed >>> 0).toString(16)}`,
          `0x${(d.cautionMaskUsed >>> 0).toString(16)}`,
          meta.proc.extraScatterArcsec ?? 0,
          csvEscape(d.notes.join(' | ')),
        ].join(','),
      );
    }
  } else {
    for (const d of inv.detections) {
      rows.push(
        [
          'legacy_detection',
          csvEscape(d.id),
          csvEscape(d.frameId),
          csvEscape(d.obsId),
          csvEscape(d.dateObs),
          d.mjdObs.toFixed(6),
          d.detector,
          '',
          '',
          d.wavelengthUm !== undefined ? d.wavelengthUm.toFixed(4) : '',
          d.ra.toFixed(7),
          d.dec.toFixed(7),
          d.x.toFixed(3),
          d.y.toFixed(3),
          d.astrometricUncertaintyArcsec.toFixed(4),
          d.astrometricUncertaintyArcsec.toFixed(4),
          d.snr.toFixed(2),
          d.apertureFluxJy.toExponential(4),
          '',
          d.flaggedPixelsInAperture,
          d.flaggedPixelsInAperture > 0,
          false,
          csvEscape(d.status),
          meta.proc.snrThreshold,
          `0x${(meta.proc.rejectMask >>> 0).toString(16)}`,
          `0x${(meta.proc.cautionMask >>> 0).toString(16)}`,
          meta.proc.extraScatterArcsec ?? 0,
          csvEscape(d.qualityNote),
        ].join(','),
      );
    }
  }

  for (const failed of meta.failedObs) {
    rows.push(
      [
        'failed_frame',
        '',
        csvEscape(failed.id),
        csvEscape(failed.obsId),
        csvEscape(failed.dateObs),
        failed.mjdObs.toFixed(6),
        failed.detector,
        csvEscape(failed.release),
        csvEscape(failed.version ?? ''),
        '',
        failed.ra.toFixed(6),
        failed.dec.toFixed(6),
        '',
        '',
        '',
        '',
        '',
        '',
        '',
        '',
        '',
        '',
        'failed',
        meta.proc.snrThreshold,
        `0x${(meta.proc.rejectMask >>> 0).toString(16)}`,
        `0x${(meta.proc.cautionMask >>> 0).toString(16)}`,
        meta.proc.extraScatterArcsec ?? 0,
        csvEscape(failed.fetchError || 'Cutout retrieval failed'),
      ].join(','),
    );
  }

  return [header, ...rows].join('\n');
}

/**
 * Generates an Astropy / IVOA standard ECSV 1.0 file preserving units, flag settings, processing settings, and limitations.
 */
export function exportInvestigationEcsv(inv: InvestigationRecord): string {
  const meta = buildExportMetadataBlock(inv);
  const astrom = inv.astrometryDetections ?? [];
  const lines: string[] = [
    '# %ECSV 1.0',
    '# ---',
    '# datatype:',
    '# - {name: source_id, datatype: string}',
    '# - {name: frame_id, datatype: string}',
    '# - {name: obs_id, datatype: string}',
    '# - {name: date_obs, datatype: string}',
    '# - {name: mjd_obs, unit: d, datatype: float64}',
    '# - {name: detector, datatype: int32}',
    '# - {name: release, datatype: string}',
    '# - {name: version, datatype: string}',
    '# - {name: wavelength_um, unit: um, datatype: float64}',
    '# - {name: ra_deg, unit: deg, datatype: float64}',
    '# - {name: dec_deg, unit: deg, datatype: float64}',
    '# - {name: ra_err_arcsec, unit: arcsec, datatype: float64}',
    '# - {name: dec_err_arcsec, unit: arcsec, datatype: float64}',
    '# - {name: snr, datatype: float64}',
    '# - {name: flux_jy, unit: Jy, datatype: float64}',
    '# - {name: flux_err_jy, unit: Jy, datatype: float64}',
    '# - {name: flag_bits_hex, datatype: string}',
    '# - {name: status, datatype: string}',
    '# meta:',
    `#   application: "URUTAU: The Sky in Motion (GEPPAA / UNILAB)"`,
    `#   investigation_title: ${JSON.stringify(inv.title)}`,
    `#   target_name: ${JSON.stringify(inv.targetName)}`,
    `#   region_center_ra_deg: ${inv.raDeg.toFixed(7)}`,
    `#   region_center_dec_deg: ${inv.decDeg.toFixed(7)}`,
    `#   region_radius_deg: ${inv.regionRadiusDeg}`,
    `#   snr_threshold: ${meta.proc.snrThreshold}`,
    `#   reject_mask_hex: "0x${(meta.proc.rejectMask >>> 0).toString(16)}"`,
    `#   caution_mask_hex: "0x${(meta.proc.cautionMask >>> 0).toString(16)}"`,
    `#   extra_scatter_arcsec: ${meta.proc.extraScatterArcsec ?? 0}`,
    `#   reprojected_to_sky_grid: ${Boolean(meta.proc.reprojectedToSkyGrid)}`,
    `#   failed_frames_count: ${meta.failedObs.length}`,
    `#   exported_utc: ${JSON.stringify(new Date().toISOString())}`,
    `#   scientific_limitations: ${JSON.stringify(meta.limitations.join(' '))}`,
    '# schema: astropy-2.0',
  ];

  const colHeader = [
    'source_id',
    'frame_id',
    'obs_id',
    'date_obs',
    'mjd_obs',
    'detector',
    'release',
    'version',
    'wavelength_um',
    'ra_deg',
    'dec_deg',
    'ra_err_arcsec',
    'dec_err_arcsec',
    'snr',
    'flux_jy',
    'flux_err_jy',
    'flag_bits_hex',
    'status',
  ].join(',');
  lines.push(colHeader);

  if (astrom.length > 0) {
    for (const d of astrom) {
      lines.push(
        [
          csvEscape(d.id),
          csvEscape(d.frameId),
          csvEscape(d.obsId),
          csvEscape(d.dateObs),
          d.mjd.toFixed(6),
          d.detector,
          csvEscape(d.release),
          csvEscape(d.version),
          d.wavelengthUm !== undefined ? d.wavelengthUm.toFixed(4) : 'NaN',
          d.ra.toFixed(7),
          d.dec.toFixed(7),
          d.raErrArcsec.toFixed(4),
          d.decErrArcsec.toFixed(4),
          d.snr.toFixed(2),
          d.fluxJy.toExponential(4),
          d.fluxErrJy.toExponential(4),
          `0x${(d.flagBitsInAperture >>> 0).toString(16)}`,
          csvEscape(d.status),
        ].join(','),
      );
    }
  } else {
    for (const d of inv.detections) {
      lines.push(
        [
          csvEscape(d.id),
          csvEscape(d.frameId),
          csvEscape(d.obsId),
          csvEscape(d.dateObs),
          d.mjdObs.toFixed(6),
          d.detector,
          '""',
          '""',
          d.wavelengthUm !== undefined ? d.wavelengthUm.toFixed(4) : 'NaN',
          d.ra.toFixed(7),
          d.dec.toFixed(7),
          d.astrometricUncertaintyArcsec.toFixed(4),
          d.astrometricUncertaintyArcsec.toFixed(4),
          d.snr.toFixed(2),
          d.apertureFluxJy.toExponential(4),
          'NaN',
          `0x${d.flaggedPixelsInAperture.toString(16)}`,
          csvEscape(d.status),
        ].join(','),
      );
    }
  }

  return lines.join('\n');
}

export function exportInvestigationJson(inv: InvestigationRecord): string {
  const meta = buildExportMetadataBlock(inv);
  return JSON.stringify(
    {
      schema: 'urutau-investigation-v2',
      generatedBy: 'URUTAU: The Sky in Motion (GEPPAA / UNILAB)',
      exportedAtUtc: new Date().toISOString(),
      processingSettings: meta.proc,
      failedOrMissingFrames: meta.failedObs.map((o) => ({
        obsId: o.obsId,
        detector: o.detector,
        error: o.fetchError || 'Failed to retrieve',
      })),
      scientificLimitations: meta.limitations,
      investigation: inv,
    },
    null,
    2,
  );
}

export function parseImportedNotebookJson(rawText: string): InvestigationRecord {
  const parsed = JSON.parse(rawText);
  const candidate = parsed?.investigation ? parsed.investigation : parsed;
  if (!candidate || typeof candidate !== 'object' || typeof candidate.title !== 'string') {
    throw new Error('Invalid URUTAU notebook JSON structure.');
  }
  const now = new Date().toISOString();
  return {
    id: `inv-import-${Date.now()}`,
    title: `${candidate.title}`,
    targetName: String(candidate.targetName ?? 'Imported Region'),
    raDeg: Number(candidate.raDeg ?? 0),
    decDeg: Number(candidate.decDeg ?? 0),
    regionRadiusDeg: Number(candidate.regionRadiusDeg ?? 0.05),
    hypothesis: String(candidate.hypothesis ?? ''),
    conclusions: String(candidate.conclusions ?? ''),
    createdAt: String(candidate.createdAt ?? now),
    updatedAt: now,
    observations: Array.isArray(candidate.observations) ? candidate.observations : [],
    detections: Array.isArray(candidate.detections) ? candidate.detections : [],
    astrometryDetections: Array.isArray(candidate.astrometryDetections)
      ? candidate.astrometryDetections
      : [],
    astrometryTracks: Array.isArray(candidate.astrometryTracks)
      ? candidate.astrometryTracks
      : [],
    processingSettings: candidate.processingSettings,
    motionCandidates: Array.isArray(candidate.motionCandidates) ? candidate.motionCandidates : [],
    epochNotes: Array.isArray(candidate.epochNotes) ? candidate.epochNotes : [],
    snapshots: Array.isArray(candidate.snapshots) ? candidate.snapshots : [],
  };
}

export function generateInvestigationPdf(inv: InvestigationRecord): void {
  const doc = new jsPDF({ unit: 'mm', format: 'a4' });
  const meta = buildExportMetadataBlock(inv);
  let y = 18;
  const lineH = 6;
  const pageH = 278;

  const ensureSpace = (needed = 12) => {
    if (y + needed > pageH) {
      doc.addPage();
      y = 18;
    }
  };

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(16);
  doc.text('URUTAU: The Sky in Motion — Investigation Report', 14, y);
  y += 8;

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9);
  doc.setTextColor(90, 95, 105);
  doc.text('GEPPAA / UNILAB · NASA SPHEREx Archive Investigation Provenance', 14, y);
  doc.setTextColor(20, 25, 35);
  y += 8;

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(12);
  doc.text(inv.title || 'Untitled Investigation', 14, y);
  y += 7;

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(10);
  doc.text(`Target / Region: ${inv.targetName} (RA ${inv.raDeg.toFixed(6)} deg, Dec ${inv.decDeg.toFixed(6)} deg, r=${inv.regionRadiusDeg} deg)`, 14, y);
  y += lineH;
  const astromCount = inv.astrometryDetections?.length ?? 0;
  const trackCount = inv.astrometryTracks?.length ?? 0;
  doc.text(`Updated: ${inv.updatedAt} · Obs: ${inv.observations.length} · Detections: ${astromCount || inv.detections.length} · Tracks: ${trackCount}`, 14, y);
  y += lineH;
  doc.setFontSize(8.5);
  doc.text(
    `Processing: SNR >= ${meta.proc.snrThreshold}, Reject=0x${(meta.proc.rejectMask >>> 0).toString(16)}, Caution=0x${(meta.proc.cautionMask >>> 0).toString(16)}, ExtraScatter=${meta.proc.extraScatterArcsec ? `${meta.proc.extraScatterArcsec}"` : 'not measured'}`,
    14,
    y,
  );
  doc.setFontSize(10);
  y += 8;

  if (inv.hypothesis) {
    ensureSpace(18);
    doc.setFont('helvetica', 'bold');
    doc.text('Hypothesis', 14, y);
    y += 5;
    doc.setFont('helvetica', 'normal');
    const hypLines = doc.splitTextToSize(inv.hypothesis, 180);
    doc.text(hypLines, 14, y);
    y += hypLines.length * 5 + 4;
  }

  if (inv.observations.length > 0) {
    ensureSpace(20);
    doc.setFont('helvetica', 'bold');
    doc.text(`Attached Observations (${inv.observations.length})`, 14, y);
    y += 5;
    doc.setFont('courier', 'normal');
    doc.setFontSize(8);
    for (const obs of inv.observations.slice(0, 22)) {
      ensureSpace(6);
      doc.text(
        `${obs.obsId} | ${obs.release}/${obs.version ?? ''} | D${obs.detector} | ${obs.dateObs.slice(0, 19)} | ${obs.fetchStatus ?? 'listed'}`,
        14,
        y,
      );
      y += 4.5;
    }
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(10);
    y += 4;
  }

  if (astromCount > 0) {
    ensureSpace(20);
    doc.setFont('helvetica', 'bold');
    doc.text(`Astrometric Detections (${astromCount})`, 14, y);
    y += 5;
    doc.setFont('courier', 'normal');
    doc.setFontSize(7.5);
    for (const det of (inv.astrometryDetections ?? []).slice(0, 25)) {
      ensureSpace(6);
      doc.text(
        `${det.obsId} D${det.detector} | RA=${det.ra.toFixed(5)}±${det.raErrArcsec.toFixed(2)}" Dec=${det.dec.toFixed(5)}±${det.decErrArcsec.toFixed(2)}" | SNR=${det.snr.toFixed(1)} | ${det.fluxJy.toExponential(2)} Jy | ${det.status}`,
        14,
        y,
      );
      y += 4.5;
    }
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(10);
    y += 4;
  }

  if (trackCount > 0) {
    ensureSpace(20);
    doc.setFont('helvetica', 'bold');
    doc.text(`Cross-Epoch Tracks & Motion Fits (${trackCount})`, 14, y);
    y += 5;
    doc.setFont('courier', 'normal');
    doc.setFontSize(8);
    for (const tr of (inv.astrometryTracks ?? []).slice(0, 15)) {
      ensureSpace(7);
      if (tr.fit) {
        doc.text(
          `${tr.id} (D${tr.detector}, n=${tr.fit.n}): rate=${tr.fit.totalRateArcsecYr.toFixed(2)}"/yr, dChi2=${tr.fit.deltaChi2.toFixed(2)}, p=${tr.fit.pValueStaticHypothesis.toExponential(2)}, redChi2=${tr.fit.reducedChi2Motion.toFixed(2)} | ${tr.status}`,
          14,
          y,
        );
      } else {
        doc.text(`${tr.id} (D${tr.detector}, n=${tr.detections.length}) | ${tr.status}`, 14, y);
      }
      y += 4.5;
    }
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(10);
    y += 4;
  }

  if (inv.snapshots.length > 0) {
    for (const snap of inv.snapshots.slice(0, 2)) {
      ensureSpace(75);
      doc.setFont('helvetica', 'bold');
      doc.text(`Snapshot: ${snap.label}`, 14, y);
      y += 4;
      try {
        doc.addImage(snap.dataUrl, 'PNG', 14, y, 90, 62);
        y += 66;
      } catch {
        y += 6;
      }
    }
  }

  if (inv.conclusions) {
    ensureSpace(18);
    doc.setFont('helvetica', 'bold');
    doc.text('Conclusions', 14, y);
    y += 5;
    doc.setFont('helvetica', 'normal');
    const cLines = doc.splitTextToSize(inv.conclusions, 180);
    doc.text(cLines, 14, y);
    y += cLines.length * 5 + 4;
  }

  ensureSpace(30);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(9);
  doc.text('Scientific Limitations & Data Provenance', 14, y);
  y += 5;
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8);
  const lim = doc.splitTextToSize(meta.limitations.join(' '), 180);
  doc.text(lim, 14, y);

  const safeName = (inv.title || 'urutau-report').toLowerCase().replace(/[^a-z0-9]+/g, '-');
  doc.save(`${safeName}.pdf`);
}

function csvEscape(val: string): string {
  if (val.includes(',') || val.includes('"') || val.includes('\n')) {
    return `"${val.replace(/"/g, '""')}"`;
  }
  return val;
}

export function triggerTextDownload(filename: string, content: string, mimeType = 'text/plain;charset=utf-8'): void {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export function triggerBinaryDownload(filename: string, buffer: ArrayBuffer, mimeType = 'application/fits'): void {
  const blob = new Blob([buffer], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
