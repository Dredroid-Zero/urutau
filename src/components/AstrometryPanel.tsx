import React, { useState } from 'react';
import {
  Activity,
  AlertTriangle,
  BookmarkPlus,
  Check,
  Crosshair,
  Loader2,
  ScanSearch,
  ShieldAlert,
  Sparkles,
} from 'lucide-react';
import { FLAG_BITS, type SourceStatus } from '../lib/astrometry';
import { degToDms, degToHms } from '../lib/astronomy';
import type { Language } from '../lib/i18n';
import { TRANSLATIONS } from '../lib/i18n';
import type {
  AstrometricDetectionRecord,
  AstrometricTrackRecord,
  GaiaSource,
  LoadedSpherexFrame,
} from '../types/spherex';

interface AstrometryPanelProps {
  lang: Language;
  frames: LoadedSpherexFrame[];
  activeFrame: LoadedSpherexFrame | null;
  snrThreshold: number;
  maxRateArcsecYr: number;
  extraScatterArcsec: number;
  rejectMask: number;
  cautionMask: number;
  onChangeSnr: (v: number) => void;
  onChangeMaxRate: (v: number) => void;
  onChangeExtraScatter: (v: number) => void;
  onToggleRejectBit: (bit: number) => void;
  onToggleCautionBit: (bit: number) => void;
  onRunDetection: () => void;
  isDetecting?: boolean;
  onQueryGaia: () => void;
  isQueryingGaia?: boolean;
  gaiaSources: GaiaSource[];
  gaiaMirrorUsed?: string | null;
  detectionsByFrame: Record<string, AstrometricDetectionRecord[]>;
  tracks: AstrometricTrackRecord[];
  selectedSource: AstrometricDetectionRecord | null;
  onSelectSource: (src: AstrometricDetectionRecord) => void;
  onUpdateSourceStatus: (id: string, status: SourceStatus) => void;
  onUpdateTrackStatus: (trackId: string, status: SourceStatus) => void;
  onSaveDetectionsToNotebook: (
    sources: AstrometricDetectionRecord[],
    tracks: AstrometricTrackRecord[],
  ) => void;
  targetExpectedPm?: { name: string; pmRaMasYr: number; pmDecMasYr: number } | null;
}

export const AstrometryPanel: React.FC<AstrometryPanelProps> = ({
  lang,
  frames,
  activeFrame,
  snrThreshold,
  maxRateArcsecYr,
  extraScatterArcsec,
  rejectMask,
  cautionMask,
  onChangeSnr,
  onChangeMaxRate,
  onChangeExtraScatter,
  onToggleRejectBit,
  onToggleCautionBit,
  onRunDetection,
  isDetecting = false,
  onQueryGaia,
  isQueryingGaia = false,
  gaiaSources,
  gaiaMirrorUsed,
  detectionsByFrame,
  tracks,
  selectedSource,
  onSelectSource,
  onUpdateSourceStatus,
  onUpdateTrackStatus,
  onSaveDetectionsToNotebook,
  targetExpectedPm,
}) => {
  const t = TRANSLATIONS[lang];
  const [showFlagEditor, setShowFlagEditor] = useState(false);

  const activeDetections = activeFrame ? detectionsByFrame[activeFrame.frameId] ?? [] : [];
  const allDetections = Object.values(detectionsByFrame).flat();
  const expectedTotalPmArcsecYr = targetExpectedPm
    ? Math.hypot(targetExpectedPm.pmRaMasYr, targetExpectedPm.pmDecMasYr) / 1000
    : null;

  return (
    <div className="space-y-4">
      {/* Detection & Gaia Controls */}
      <div className="bg-[#0B0E17] border border-slate-800 rounded-md p-4 space-y-3">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div className="flex flex-wrap items-end gap-4">
            <label className="text-xs text-slate-400 space-y-1">
              <span className="block">{t.snrThreshold}</span>
              <input
                type="number"
                min={2}
                max={50}
                step={0.5}
                value={snrThreshold}
                onChange={(e) => onChangeSnr(Number(e.target.value))}
                className="w-24 bg-[#07090E] border border-slate-700 rounded px-2.5 py-1.5 text-xs font-mono text-slate-100"
              />
            </label>

            <label className="text-xs text-slate-400 space-y-1">
              <span className="block">{t.maxRateLabel}</span>
              <input
                type="number"
                min={0.5}
                max={60}
                step={0.5}
                value={maxRateArcsecYr}
                onChange={(e) => onChangeMaxRate(Number(e.target.value))}
                className="w-24 bg-[#07090E] border border-slate-700 rounded px-2.5 py-1.5 text-xs font-mono text-slate-100"
              />
            </label>

            <label
              className="text-xs text-slate-400 space-y-1"
              title="Leave at 0 when per-exposure WCS scatter is not measured; astrometry.ts will report statistical-only errors with an explicit warning."
            >
              <span className="block">{t.extraScatterLabel}</span>
              <input
                type="number"
                min={0}
                max={5}
                step={0.05}
                value={extraScatterArcsec}
                onChange={(e) => onChangeExtraScatter(Number(e.target.value))}
                className="w-28 bg-[#07090E] border border-slate-700 rounded px-2.5 py-1.5 text-xs font-mono text-slate-100"
              />
            </label>

            <button
              type="button"
              onClick={() => setShowFlagEditor((v) => !v)}
              className="px-2.5 py-1.5 rounded bg-[#07090E] border border-slate-700 text-xs text-slate-300 hover:text-white flex items-center gap-1.5 cursor-pointer"
            >
              <ShieldAlert className="w-3.5 h-3.5 text-amber-400" />
              Flag Masks (0x{(rejectMask >>> 0).toString(16)})
            </button>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              disabled={frames.length === 0 || isDetecting}
              onClick={onRunDetection}
              className="bg-cyan-600 hover:bg-cyan-500 disabled:opacity-40 text-slate-950 text-xs font-semibold px-3.5 py-2 rounded flex items-center gap-1.5 cursor-pointer whitespace-nowrap"
            >
              {isDetecting ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <ScanSearch className="w-3.5 h-3.5" />
              )}
              {t.runDetectionBtn}
            </button>

            <button
              type="button"
              disabled={frames.length === 0 || isQueryingGaia}
              onClick={onQueryGaia}
              className="bg-slate-800 hover:bg-slate-700 disabled:opacity-40 border border-emerald-500/40 text-emerald-200 text-xs font-medium px-3 py-2 rounded flex items-center gap-1.5 cursor-pointer whitespace-nowrap"
            >
              {isQueryingGaia ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <Sparkles className="w-3.5 h-3.5" />
              )}
              {t.queryGaiaBtn}
            </button>

            {allDetections.length > 0 && (
              <button
                type="button"
                onClick={() => onSaveDetectionsToNotebook(allDetections, tracks)}
                className="bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-100 text-xs font-medium px-3 py-2 rounded flex items-center gap-1.5 cursor-pointer whitespace-nowrap"
              >
                <BookmarkPlus className="w-3.5 h-3.5" />
                {t.saveMeasurementsBtn}
              </button>
            )}
          </div>
        </div>

        {/* Motion Scale Reality Check */}
        <div className="bg-[#07090E] border border-slate-800 rounded px-3 py-2 text-[11px] text-slate-300 flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <AlertTriangle className="w-3.5 h-3.5 text-amber-400 shrink-0" />
            <span>
              <strong>Motion Scale Reality Check:</strong> SPHEREx plate scale is ~6.15"/px (PSF FWHM ~7.5").
              {extraScatterArcsec === 0
                ? ' Extra WCS scatter is unmeasured (0") — centroid errors come solely from the VARIANCE HDU and may understate systematic residuals.'
                : ` Extra scatter floor of ±${extraScatterArcsec.toFixed(2)}" applied in motion fits.`}
              {gaiaMirrorUsed ? ` · Gaia DR3 loaded (${gaiaSources.length} stars via ${gaiaMirrorUsed}).` : ''}
            </span>
          </div>
          {expectedTotalPmArcsecYr !== null && expectedTotalPmArcsecYr > 0.1 && (
            <span className="font-mono text-cyan-300 tabular-nums">
              Catalog Ref ({targetExpectedPm?.name}): {expectedTotalPmArcsecYr.toFixed(2)}"/yr (~{(expectedTotalPmArcsecYr / 6.15).toFixed(2)} px/yr)
            </span>
          )}
        </div>

        {/* Interactive Reject / Caution Flag Bitmask Editor */}
        {showFlagEditor && (
          <div className="bg-[#07090E] border border-slate-800 rounded p-3 space-y-2">
            <div className="text-[11px] text-slate-400">
              Provisional bitmask controls (`astrometry.ts`). <strong>SOURCE (bit 21)</strong> marks pixels mapped to known sources and is locked so it can never be rejected.
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-2 text-[11px] font-mono">
              {Object.entries(FLAG_BITS).map(([name, bit]) => {
                const mask = 1 << bit;
                const isSource = bit === FLAG_BITS.SOURCE;
                const isReject = (rejectMask & mask) !== 0;
                const isCaution = (cautionMask & mask) !== 0;
                return (
                  <div
                    key={name}
                    className={`border rounded p-1.5 space-y-1 ${
                      isSource
                        ? 'border-cyan-500/40 bg-cyan-950/20'
                        : 'border-slate-800 bg-[#0B0E17]'
                    }`}
                  >
                    <div className="text-slate-200 truncate" title={`Bit ${bit}`}>
                      {bit}: {name}
                    </div>
                    <div className="flex items-center gap-2 text-[10px]">
                      <label className="flex items-center gap-1 cursor-pointer">
                        <input
                          type="checkbox"
                          disabled={isSource}
                          checked={!isSource && isReject}
                          onChange={() => onToggleRejectBit(bit)}
                          className="accent-rose-500"
                        />
                        <span className={isSource ? 'text-slate-500' : 'text-rose-300'}>
                          {isSource ? 'Locked' : 'Rej'}
                        </span>
                      </label>
                      <label className="flex items-center gap-1 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={isCaution}
                          onChange={() => onToggleCautionBit(bit)}
                          className="accent-amber-500"
                        />
                        <span className="text-amber-300">Warn</span>
                      </label>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>

      {/* Detected Sources & Provenance Inspector */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-4">
        <div className="lg:col-span-7 bg-[#0B0E17] border border-slate-800 rounded-md overflow-hidden">
          <div className="px-4 py-2.5 border-b border-slate-800 flex items-center justify-between">
            <h3 className="text-xs font-semibold text-slate-200 uppercase tracking-wider">
              {t.detectedSources} ({activeDetections.length} in active frame · {allDetections.length} total)
            </h3>
          </div>
          {activeDetections.length === 0 ? (
            <div className="p-6 text-xs text-slate-400 text-center">
              Click &quot;{t.runDetectionBtn}&quot; to run matched-filter detection, windowed centroiding, VARIANCE HDU error propagation, and per-detector cross-epoch association.
            </div>
          ) : (
            <div className="overflow-x-auto max-h-[320px]">
              <table className="w-full text-left border-collapse text-xs">
                <thead>
                  <tr className="bg-[#07090E] border-b border-slate-800 text-slate-400">
                    <th className="py-2 px-3">{t.pixelCoords}</th>
                    <th className="py-2 px-3">{t.skyCoords}</th>
                    <th className="py-2 px-3">SNR</th>
                    <th className="py-2 px-3">{t.fluxDensity}</th>
                    <th className="py-2 px-3">Gaia Δ"</th>
                    <th className="py-2 px-3">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800/60 font-mono tabular-nums">
                  {activeDetections.map((src) => {
                    const isSel = selectedSource?.id === src.id;
                    return (
                      <tr
                        key={src.id}
                        onClick={() => onSelectSource(src)}
                        className={`cursor-pointer ${
                          isSel ? 'bg-cyan-950/40 text-cyan-100' : 'hover:bg-slate-900/50 text-slate-300'
                        }`}
                      >
                        <td className="py-2 px-3">
                          ({src.x.toFixed(2)}, {src.y.toFixed(2)})
                        </td>
                        <td className="py-2 px-3">
                          <div>{degToHms(src.ra, 2)} {degToDms(src.dec, 1)}</div>
                          <div className="text-[10px] text-slate-500">
                            ±{src.raErrArcsec.toFixed(2)}", ±{src.decErrArcsec.toFixed(2)}"
                          </div>
                        </td>
                        <td className="py-2 px-3">{src.snr.toFixed(1)}</td>
                        <td className="py-2 px-3">
                          {src.fluxJy.toExponential(2)} ± {src.fluxErrJy.toExponential(1)}
                        </td>
                        <td className="py-2 px-3">
                          {src.nearestGaiaSepArcsec !== undefined
                            ? `${src.nearestGaiaSepArcsec.toFixed(2)}"`
                            : '—'}
                        </td>
                        <td className="py-2 px-3 text-[11px]">
                          <span
                            className={
                              src.status === 'user-confirmed'
                                ? 'text-emerald-300'
                                : src.status === 'candidate-association'
                                ? 'text-amber-300'
                                : 'text-slate-400'
                            }
                          >
                            {src.status}
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* Selected Source Provenance Inspector */}
        <div className="lg:col-span-5 bg-[#0B0E17] border border-slate-800 rounded-md p-4">
          <h3 className="text-xs font-semibold text-slate-200 uppercase tracking-wider mb-3 flex items-center gap-1.5">
            <Crosshair className="w-3.5 h-3.5 text-cyan-400" />
            {t.sourceProvenanceTitle}
          </h3>
          {!selectedSource ? (
            <p className="text-xs text-slate-400">
              Select a detected source in the Temporal Lab canvas or table to inspect its WCS coordinates, statistical centroid uncertainties, aperture photometry, flag bits, and provenance caveats.
            </p>
          ) : (
            <div className="space-y-3 text-xs">
              <div className="grid grid-cols-2 gap-2 font-mono tabular-nums bg-[#07090E] border border-slate-800 rounded p-3">
                <div>
                  <div className="text-[10px] text-slate-500">OBSERVATION / REL</div>
                  <div className="text-slate-200">
                    {selectedSource.obsId} ({selectedSource.release})
                  </div>
                </div>
                <div>
                  <div className="text-[10px] text-slate-500">DETECTOR / λ</div>
                  <div className="text-slate-200">
                    D{selectedSource.detector}
                    {selectedSource.wavelengthUm ? ` · ${selectedSource.wavelengthUm.toFixed(4)} µm` : ''}
                  </div>
                </div>
                <div>
                  <div className="text-[10px] text-slate-500">ICRS RA / DEC</div>
                  <div className="text-cyan-300">
                    {selectedSource.ra.toFixed(6)}°, {selectedSource.dec.toFixed(6)}°
                  </div>
                </div>
                <div>
                  <div className="text-[10px] text-slate-500">STAT. SIGMA (E, N)</div>
                  <div className="text-slate-200">
                    ±{selectedSource.raErrArcsec.toFixed(3)}", ±{selectedSource.decErrArcsec.toFixed(3)}"
                  </div>
                </div>
                <div>
                  <div className="text-[10px] text-slate-500">FLUX (NO AP. CORR)</div>
                  <div className="text-slate-200">
                    {selectedSource.fluxJy.toExponential(3)} ± {selectedSource.fluxErrJy.toExponential(2)} Jy
                  </div>
                </div>
                <div>
                  <div className="text-[10px] text-slate-500">APERTURE / FLAGS</div>
                  <div className="text-slate-300">
                    N={selectedSource.nValidAperturepx} px · 0x{(selectedSource.flagBitsInAperture >>> 0).toString(16)}
                  </div>
                </div>
                {selectedSource.nearestGaiaId && (
                  <div className="col-span-2">
                    <div className="text-[10px] text-slate-500">NEAREST GAIA DR3 (PROPAGATED)</div>
                    <div className="text-emerald-300">
                      Gaia DR3 {selectedSource.nearestGaiaId} · sep = {selectedSource.nearestGaiaSepArcsec?.toFixed(2)}"
                    </div>
                  </div>
                )}
              </div>

              {/* Provenance Notes from astrometry.ts */}
              <div className="bg-[#07090E] border border-slate-800 rounded p-2.5 space-y-1 text-[11px] text-slate-400">
                {selectedSource.notes.map((n, idx) => (
                  <div key={idx}>• {n}</div>
                ))}
              </div>

              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => onUpdateSourceStatus(selectedSource.id, 'candidate-association')}
                  className={`px-2.5 py-1.5 rounded border text-xs cursor-pointer ${
                    selectedSource.status === 'candidate-association'
                      ? 'bg-amber-950/50 border-amber-500/60 text-amber-200'
                      : 'bg-[#07090E] border-slate-700 text-slate-300'
                  }`}
                >
                  {t.markCandidate}
                </button>
                <button
                  type="button"
                  onClick={() => onUpdateSourceStatus(selectedSource.id, 'user-confirmed')}
                  className={`px-2.5 py-1.5 rounded border text-xs flex items-center gap-1 cursor-pointer ${
                    selectedSource.status === 'user-confirmed'
                      ? 'bg-emerald-950/50 border-emerald-500/60 text-emerald-200'
                      : 'bg-[#07090E] border-slate-700 text-slate-300'
                  }`}
                >
                  <Check className="w-3.5 h-3.5" />
                  {t.confirmIdentification}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Cross-Epoch Tracks & Linear Motion Fits (Per-Detector) */}
      <div className="bg-[#0B0E17] border border-slate-800 rounded-md overflow-hidden">
        <div className="px-4 py-2.5 border-b border-slate-800 flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <Activity className="w-3.5 h-3.5 text-cyan-400" />
            <h3 className="text-xs font-semibold text-slate-200 uppercase tracking-wider">
              {t.crossEpochMotion} ({tracks.length})
            </h3>
          </div>
          <span className="text-[11px] text-slate-400">
            Grouped per detector (`groupByDetector`) · Linear fits computed when N ≥ 3
          </span>
        </div>

        {tracks.length === 0 ? (
          <div className="p-5 text-xs text-slate-400">
            Load multiple exposures from the same detector and click &quot;{t.runDetectionBtn}&quot; to associate detections across epochs and compute weighted linear motion fits.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse text-xs">
              <thead>
                <tr className="bg-[#07090E] border-b border-slate-800 text-slate-400">
                  <th className="py-2 px-3">Track / Det</th>
                  <th className="py-2 px-3">N Epochs (Span)</th>
                  <th className="py-2 px-3">Rate ("/yr)</th>
                  <th className="py-2 px-3">Δχ² (p-value)</th>
                  <th className="py-2 px-3">Red. χ²</th>
                  <th className="py-2 px-3">Caveats & Status</th>
                  <th className="py-2 px-3 text-right">Review</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/60 font-mono tabular-nums">
                {tracks.slice(0, 25).map((tr) => {
                  const fit = tr.fit;
                  return (
                    <tr key={tr.id} className="hover:bg-slate-900/40">
                      <td className="py-2 px-3 text-slate-200">
                        <div>{tr.id}</div>
                        <div className="text-[10px] text-slate-500">Detector D{tr.detector}</div>
                      </td>
                      <td className="py-2 px-3 text-slate-300">
                        {tr.detections.length}
                        {fit ? ` (${(fit.spanYears * 365.25).toFixed(1)} d)` : ''}
                      </td>
                      <td className="py-2 px-3 text-cyan-300">
                        {fit ? `${fit.totalRateArcsecYr.toFixed(2)}"/yr` : 'Need N ≥ 3'}
                      </td>
                      <td className="py-2 px-3 text-slate-200">
                        {fit
                          ? `${fit.deltaChi2.toFixed(2)} (p=${fit.pValueStaticHypothesis.toExponential(1)})`
                          : '—'}
                      </td>
                      <td className="py-2 px-3 text-slate-300">
                        {fit && Number.isFinite(fit.reducedChi2Motion)
                          ? fit.reducedChi2Motion.toFixed(2)
                          : '—'}
                      </td>
                      <td className="py-2 px-3 font-sans">
                        <div
                          className={
                            tr.status === 'user-confirmed'
                              ? 'text-emerald-300 font-medium'
                              : tr.status === 'candidate-association'
                              ? 'text-amber-300'
                              : 'text-slate-400'
                          }
                        >
                          {tr.status}
                        </div>
                        {fit && (
                          <div className="text-[11px] text-slate-500 max-w-md">
                            {fit.notes.join(' ')}
                          </div>
                        )}
                      </td>
                      <td className="py-2 px-3 text-right font-sans">
                        <div className="inline-flex items-center gap-1">
                          <button
                            type="button"
                            onClick={() => onUpdateTrackStatus(tr.id, 'candidate-association')}
                            className="px-2 py-1 rounded bg-[#07090E] border border-slate-700 text-[11px] text-amber-200 cursor-pointer"
                          >
                            Candidate
                          </button>
                          <button
                            type="button"
                            onClick={() => onUpdateTrackStatus(tr.id, 'user-confirmed')}
                            className="px-2 py-1 rounded bg-[#07090E] border border-slate-700 text-[11px] text-emerald-200 cursor-pointer"
                          >
                            Confirm
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
};
