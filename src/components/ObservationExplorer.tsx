import React, { useMemo, useState } from 'react';
import {
  AlertTriangle,
  ArrowUpDown,
  BookmarkPlus,
  CheckCircle2,
  Download,
  Eye,
  Filter,
  Loader2,
  RefreshCw,
} from 'lucide-react';
import { estimateCutoutTransfer, SPHEREX_RELEASES } from '../config/spherex';
import { degToDms, degToHms, SPHEREX_BANDS } from '../lib/astronomy';
import type { Language } from '../lib/i18n';
import { TRANSLATIONS } from '../lib/i18n';
import type { ArchiveDiagnostics, SpherexObservation } from '../types/spherex';

interface ObservationExplorerProps {
  lang: Language;
  raDeg: number;
  decDeg: number;
  searchRadiusDeg: number;
  cutoutSizeDeg: number;
  onChangeRadius: (r: number) => void;
  observations: SpherexObservation[];
  diagnostics: ArchiveDiagnostics | null;
  cubeWavelengthsUm: number[];
  isQuerying: boolean;
  loadingCutoutId: string | null;
  onRefreshQuery: () => void;
  onLoadVerifiedMultiSlew: () => void;
  onLoadCubeSlices: (frames: number[]) => void;
  onOpenObservation: (obs: SpherexObservation) => void;
  onOpenMultipleObservations: (obsList: SpherexObservation[]) => void;
  onSaveObservationToNotebook: (obs: SpherexObservation) => void;
}

const DEFAULT_CUBE_SLICE_FRAMES = [5, 22, 38, 63, 75, 91];

export const ObservationExplorer: React.FC<ObservationExplorerProps> = ({
  lang,
  raDeg,
  decDeg,
  searchRadiusDeg,
  cutoutSizeDeg,
  onChangeRadius,
  observations,
  diagnostics,
  cubeWavelengthsUm,
  isQuerying,
  loadingCutoutId,
  onRefreshQuery,
  onLoadVerifiedMultiSlew,
  onLoadCubeSlices,
  onOpenObservation,
  onOpenMultipleObservations,
  onSaveObservationToNotebook,
}) => {
  const t = TRANSLATIONS[lang];
  const [bandFilter, setBandFilter] = useState<string>('ALL');
  const [releaseFilter, setReleaseFilter] = useState<string>('ALL');
  const [dateFrom, setDateFrom] = useState<string>('');
  const [dateTo, setDateTo] = useState<string>('');
  const [targetWavelengthUm, setTargetWavelengthUm] = useState<string>('');
  const [wlTolerancePct, setWlTolerancePct] = useState<number>(3);
  const [sortBy, setSortBy] = useState<'date_asc' | 'date_desc' | 'detector' | 'version'>('date_asc');
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  const filteredObs = useMemo(() => {
    const wlTarget = Number(targetWavelengthUm);
    const useWlFilter = targetWavelengthUm.trim() !== '' && Number.isFinite(wlTarget) && wlTarget > 0;
    const list = observations.filter((o) => {
      if (bandFilter !== 'ALL' && o.bandpassName !== bandFilter) return false;
      if (releaseFilter !== 'ALL' && o.release !== releaseFilter) return false;
      if (dateFrom && o.dateObs !== 'Unknown' && o.dateObs.slice(0, 10) < dateFrom) return false;
      if (dateTo && o.dateObs !== 'Unknown' && o.dateObs.slice(0, 10) > dateTo) return false;
      if (useWlFilter) {
        const wlObs = o.targetWavelengthUm ?? (o.lambdaMinUm + o.lambdaMaxUm) / 2;
        const tol = (wlTolerancePct / 100) * wlTarget;
        // Check if target wavelength overlaps band or measured targetWavelengthUm within window
        if (o.targetWavelengthUm !== undefined) {
          if (Math.abs(wlObs - wlTarget) > tol) return false;
        } else if (wlTarget < o.lambdaMinUm - tol || wlTarget > o.lambdaMaxUm + tol) {
          return false;
        }
      }
      return true;
    });

    list.sort((a, b) => {
      if (sortBy === 'date_desc') return b.mjdObs - a.mjdObs;
      if (sortBy === 'detector') return a.detector - b.detector || a.mjdObs - b.mjdObs;
      if (sortBy === 'version') return (b.version ?? '').localeCompare(a.version ?? '');
      return a.mjdObs - b.mjdObs;
    });

    return list;
  }, [observations, bandFilter, releaseFilter, dateFrom, dateTo, targetWavelengthUm, wlTolerancePct, sortBy]);

  const toggleSelect = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const selectedObservations = filteredObs.filter((o) => selectedIds.has(o.id));
  const batchEst = estimateCutoutTransfer(cutoutSizeDeg, selectedObservations.length);

  return (
    <div className="space-y-4">
      {/* Header & Query Parameters */}
      <div className="bg-[#0B0E17] border border-slate-800 rounded-md p-4 flex flex-wrap items-center justify-between gap-4">
        <div>
          <h2 className="text-base font-semibold text-slate-100">
            {t.navObservations} · ICRS {degToHms(raDeg, 3)} {degToDms(decDeg, 2)}
          </h2>
          <p className="text-xs font-mono text-slate-400 mt-0.5 tabular-nums">
            Center: ({raDeg.toFixed(6)}°, {decDeg.toFixed(6)}°) · Searchable releases:{' '}
            {SPHEREX_RELEASES.filter((r) => r.searchable && r.available).map((r) => r.id).join(', ')} (config-driven)
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <label className="text-xs text-slate-400 flex items-center gap-2">
            Radius (°)
            <select
              value={searchRadiusDeg}
              onChange={(e) => onChangeRadius(Number(e.target.value))}
              className="bg-[#07090E] border border-slate-700 rounded px-2 py-1.5 text-xs font-mono text-slate-100"
            >
              <option value={0.05}>0.05°</option>
              <option value={0.15}>0.15°</option>
              <option value={0.3}>0.30°</option>
              <option value={0.5}>0.50°</option>
            </select>
          </label>

          <button
            type="button"
            onClick={onRefreshQuery}
            disabled={isQuerying}
            className="bg-cyan-600 hover:bg-cyan-500 text-slate-950 text-xs font-semibold px-3.5 py-2 rounded flex items-center gap-1.5 cursor-pointer whitespace-nowrap"
          >
            {isQuerying ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <RefreshCw className="w-3.5 h-3.5" />
            )}
            {t.queryArchiveBtn}
          </button>
        </div>
      </div>

      {/* Honest Archive Query Diagnostics */}
      {diagnostics && (
        <div className="bg-[#0B0E17] border border-slate-800 rounded-md p-4 space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-xs font-semibold text-slate-300 uppercase tracking-wider">
              {t.archiveStatusTitle}
              {diagnostics.dedupRemovedCount ? ` · Deduplicated ${diagnostics.dedupRemovedCount} older version(s)` : ''}
            </h3>
            <span className="text-[11px] font-mono text-slate-500 tabular-nums">
              {new Date(diagnostics.queriedAt).toUTCString()}
            </span>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-3 text-xs">
            <div className="bg-[#07090E] border border-slate-800 rounded p-3">
              <div className="flex items-center gap-1.5 font-semibold mb-1">
                {diagnostics.tapStatus === 'ok' ? (
                  <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
                ) : (
                  <AlertTriangle className="w-3.5 h-3.5 text-amber-400" />
                )}
                <span>IRSA TAP Primary (spherex.artifact + plane)</span>
              </div>
              <p className="text-slate-400 text-[11px] leading-relaxed">
                {diagnostics.tapMessage}
              </p>
            </div>

            <div className="bg-[#07090E] border border-slate-800 rounded p-3">
              <div className="flex items-center gap-1.5 font-semibold mb-1">
                {diagnostics.siaStatus === 'ok' ? (
                  <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
                ) : diagnostics.siaStatus === 'skipped' ? (
                  <CheckCircle2 className="w-3.5 h-3.5 text-slate-400" />
                ) : (
                  <AlertTriangle className="w-3.5 h-3.5 text-amber-400" />
                )}
                <span>IRSA SIA2 Fallback / Cross-Check</span>
              </div>
              <p className="text-slate-400 text-[11px] leading-relaxed">
                {diagnostics.siaMessage}
              </p>
            </div>

            <div className="bg-[#07090E] border border-slate-800 rounded p-3">
              <div className="flex items-center gap-1.5 font-semibold mb-1">
                {diagnostics.cubeAvailable ? (
                  <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
                ) : (
                  <AlertTriangle className="w-3.5 h-3.5 text-amber-400" />
                )}
                <span>{t.dr1CubeTitle}</span>
              </div>
              <p className="text-slate-400 text-[11px] font-mono">
                HEALPix Norder{diagnostics.cubeInfo.order} · Npix{diagnostics.cubeInfo.ipix} ·{' '}
                {diagnostics.cubeAvailable ? 'Tile Online' : 'Not Verified'}
              </p>
            </div>
          </div>

          {/* Direct Scientific Access Actions */}
          <div className="flex flex-wrap items-center gap-3 pt-1">
            {diagnostics.cubeAvailable && (
              <button
                type="button"
                onClick={() => onLoadCubeSlices(DEFAULT_CUBE_SLICE_FRAMES)}
                className="bg-slate-800 hover:bg-slate-700 text-cyan-200 border border-cyan-500/40 text-xs font-medium px-3 py-1.5 rounded cursor-pointer whitespace-nowrap"
              >
                {t.extractCubeBtn} (6 Bands · {cubeWavelengthsUm.length || 102}ch)
              </button>
            )}
            <button
              type="button"
              onClick={onLoadVerifiedMultiSlew}
              className="bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 text-xs font-medium px-3 py-1.5 rounded cursor-pointer whitespace-nowrap"
            >
              {t.loadMultiSlewBtn} (2026W21_2A_0001 · D1)
            </button>
          </div>
        </div>
      )}

      {/* Filter & Sort Bar */}
      <div className="bg-[#0B0E17] border border-slate-800 rounded-md px-4 py-3 flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2.5">
          <span className="text-xs text-slate-400 flex items-center gap-1.5">
            <Filter className="w-3.5 h-3.5" />
            {filteredObs.length} / {observations.length}
          </span>

          <select
            aria-label={t.filterBand}
            value={bandFilter}
            onChange={(e) => setBandFilter(e.target.value)}
            className="bg-[#07090E] border border-slate-700 rounded px-2 py-1.5 text-xs text-slate-200"
          >
            <option value="ALL">{t.allBands}</option>
            {SPHEREX_BANDS.map((b) => (
              <option key={b.bandpassName} value={b.bandpassName}>
                {b.bandpassName} ({b.lambdaMinUm}–{b.lambdaMaxUm} µm)
              </option>
            ))}
          </select>

          <select
            aria-label={t.filterRelease}
            value={releaseFilter}
            onChange={(e) => setReleaseFilter(e.target.value)}
            className="bg-[#07090E] border border-slate-700 rounded px-2 py-1.5 text-xs text-slate-200"
          >
            <option value="ALL">{t.allReleases}</option>
            {SPHEREX_RELEASES.filter((r) => r.searchable).map((r) => (
              <option key={r.id} value={r.id}>
                {r.id}
              </option>
            ))}
          </select>

          <input
            type="date"
            aria-label="Date From"
            value={dateFrom}
            onChange={(e) => setDateFrom(e.target.value)}
            className="bg-[#07090E] border border-slate-700 rounded px-2 py-1 text-xs font-mono text-slate-200"
          />
          <input
            type="date"
            aria-label="Date To"
            value={dateTo}
            onChange={(e) => setDateTo(e.target.value)}
            className="bg-[#07090E] border border-slate-700 rounded px-2 py-1 text-xs font-mono text-slate-200"
          />

          <div className="flex items-center gap-1 bg-[#07090E] border border-slate-700 rounded px-2 py-1">
            <input
              type="number"
              step="0.05"
              min="0.7"
              max="5.0"
              placeholder="λ (µm)"
              aria-label="Target Wavelength Filter"
              value={targetWavelengthUm}
              onChange={(e) => setTargetWavelengthUm(e.target.value)}
              className="w-16 bg-transparent text-xs font-mono text-slate-200 focus:outline-none"
            />
            <span className="text-[11px] text-slate-500">±</span>
            <input
              type="number"
              min={1}
              max={25}
              value={wlTolerancePct}
              aria-label="Wavelength Window Percent"
              onChange={(e) => setWlTolerancePct(Number(e.target.value))}
              className="w-10 bg-transparent text-xs font-mono text-slate-200 focus:outline-none"
            />
            <span className="text-[11px] text-slate-500">%</span>
          </div>

          <label className="text-xs text-slate-400 flex items-center gap-1">
            <ArrowUpDown className="w-3.5 h-3.5" />
            <select
              aria-label="Sort observations"
              value={sortBy}
              onChange={(e) => setSortBy(e.target.value as typeof sortBy)}
              className="bg-[#07090E] border border-slate-700 rounded px-2 py-1.5 text-xs text-slate-200"
            >
              <option value="date_asc">Date ↑</option>
              <option value="date_desc">Date ↓</option>
              <option value="detector">Detector</option>
              <option value="version">Version</option>
            </select>
          </label>
        </div>

        <div className="flex items-center gap-2">
          {filteredObs.length > 0 && (
            <button
              type="button"
              onClick={() =>
                setSelectedIds((prev) =>
                  prev.size === filteredObs.length ? new Set() : new Set(filteredObs.map((o) => o.id)),
                )
              }
              className="px-2.5 py-1.5 rounded bg-[#07090E] border border-slate-700 text-xs text-slate-300 hover:text-white cursor-pointer"
            >
              {selectedIds.size === filteredObs.length ? 'Deselect All' : 'Select All'}
            </button>
          )}
          {selectedObservations.length > 0 && (
            <button
              type="button"
              onClick={() => onOpenMultipleObservations(selectedObservations)}
              className="bg-cyan-600 hover:bg-cyan-500 text-slate-950 text-xs font-semibold px-3 py-1.5 rounded cursor-pointer whitespace-nowrap"
            >
              {t.openInViewer} ({selectedObservations.length} · ~{batchEst.totalMb.toFixed(1)} MB)
            </button>
          )}
        </div>
      </div>

      {/* Observation Catalog Table */}
      <div className="bg-[#0B0E17] border border-slate-800 rounded-md overflow-hidden">
        {filteredObs.length === 0 ? (
          <div className="p-8 text-center space-y-3">
            <p className="text-sm text-slate-300">{t.noObservations}</p>
            <p className="text-xs text-slate-500 max-w-2xl mx-auto">
              {diagnostics && (diagnostics.tapStatus !== 'ok' || diagnostics.siaStatus !== 'ok')
                ? 'IRSA TAP/SIA2 search gateways returned an external upstream error (HTTP 502/timeout). Direct IBE cutouts and the DR1 All-Sky Cube remain online — use the Verified QR3 Multi-Slew Loader or DR1 Cube Extractor above.'
                : 'No Level-2 spectral exposures overlapped this search cone. Expand the search radius or extract the DR1 All-Sky HiPS Cube for this coordinate.'}
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse text-xs">
              <thead>
                <tr className="border-b border-slate-800 bg-[#07090E] text-slate-400 font-medium">
                  <th className="py-2.5 px-3 w-8">Sel</th>
                  <th className="py-2.5 px-3">Observation ID / Period</th>
                  <th className="py-2.5 px-3">Detector / λ at Target</th>
                  <th className="py-2.5 px-3">UTC / MJD</th>
                  <th className="py-2.5 px-3">Release / Version</th>
                  <th className="py-2.5 px-3">Exp / Est. Size</th>
                  <th className="py-2.5 px-3">Status</th>
                  <th className="py-2.5 px-3 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/70">
                {filteredObs.map((obs) => {
                  const isLoading = loadingCutoutId === obs.id;
                  const status = obs.fetchStatus ?? 'listed';
                  return (
                    <tr key={obs.id} className="hover:bg-slate-900/40">
                      <td className="py-2.5 px-3">
                        <input
                          type="checkbox"
                          aria-label={`Select ${obs.obsId}`}
                          checked={selectedIds.has(obs.id)}
                          onChange={() => toggleSelect(obs.id)}
                          className="accent-cyan-500 cursor-pointer"
                        />
                      </td>
                      <td className="py-2.5 px-3 font-mono text-slate-200">
                        <div>{obs.obsId}</div>
                        <div className="text-[11px] text-slate-500">
                          {obs.planningPeriod ?? '—'} · {obs.provenanceSource}
                        </div>
                      </td>
                      <td className="py-2.5 px-3 font-mono text-slate-300 tabular-nums">
                        <div>{obs.bandpassName} (D{obs.detector})</div>
                        <div className="text-[11px] text-slate-500">
                          {obs.targetWavelengthUm !== undefined
                            ? `λ_tgt = ${obs.targetWavelengthUm.toFixed(3)} µm`
                            : `${obs.lambdaMinUm.toFixed(2)}–${obs.lambdaMaxUm.toFixed(2)} µm`}
                        </div>
                      </td>
                      <td className="py-2.5 px-3 font-mono text-slate-300 tabular-nums">
                        <div>{obs.dateObs.slice(0, 19).replace('T', ' ')}</div>
                        <div className="text-[11px] text-slate-500">
                          MJD {obs.mjdObs > 0 ? obs.mjdObs.toFixed(5) : '—'}
                        </div>
                      </td>
                      <td className="py-2.5 px-3 font-mono text-slate-300">
                        <div>{obs.release} · {obs.surveyMode}</div>
                        <div className="text-[11px] text-slate-500">{obs.version ?? '—'}</div>
                      </td>
                      <td className="py-2.5 px-3 font-mono text-slate-300 tabular-nums">
                        <div>{obs.exposureSec ? `${obs.exposureSec.toFixed(1)}s` : '—'}</div>
                        <div className="text-[11px] text-slate-500">
                          ~{(obs.estimatedSizeMb ?? estimateCutoutTransfer(cutoutSizeDeg, 1).mbPerFrame).toFixed(1)} MB
                        </div>
                      </td>
                      <td className="py-2.5 px-3 font-mono text-[11px]">
                        <span
                          className={
                            status === 'retrieved'
                              ? 'text-emerald-400'
                              : status === 'failed'
                              ? 'text-rose-400'
                              : status === 'retrieving'
                              ? 'text-cyan-300'
                              : 'text-slate-400'
                          }
                        >
                          {status}
                        </span>
                        {obs.fetchError && (
                          <div className="text-[10px] text-rose-400 max-w-[160px] truncate" title={obs.fetchError}>
                            {obs.fetchError}
                          </div>
                        )}
                      </td>
                      <td className="py-2.5 px-3 text-right">
                        <div className="inline-flex items-center gap-1.5">
                          <button
                            type="button"
                            disabled={isLoading}
                            onClick={() => onOpenObservation(obs)}
                            className="px-2.5 py-1 rounded bg-cyan-600 hover:bg-cyan-500 text-slate-950 font-semibold text-[11px] flex items-center gap-1 cursor-pointer whitespace-nowrap"
                          >
                            {isLoading ? (
                              <Loader2 className="w-3 h-3 animate-spin" />
                            ) : (
                              <Eye className="w-3 h-3" />
                            )}
                            Viewer
                          </button>
                          {obs.cutoutPath && (
                            <a
                              href={`/api/spherex/download-fits?path=${encodeURIComponent(obs.cutoutPath)}&ra=${raDeg}&dec=${decDeg}&size=${cutoutSizeDeg}`}
                              className="px-2 py-1 rounded bg-[#07090E] border border-slate-700 text-slate-300 hover:text-white text-[11px] flex items-center gap-1 whitespace-nowrap"
                              title={t.downloadFits}
                            >
                              <Download className="w-3 h-3" />
                              FITS
                            </a>
                          )}
                          <button
                            type="button"
                            onClick={() => onSaveObservationToNotebook(obs)}
                            className="p-1 rounded bg-[#07090E] border border-slate-700 text-slate-300 hover:text-cyan-300 cursor-pointer"
                            aria-label={`Save ${obs.obsId} to Notebook`}
                            title={t.attachToNotebook}
                          >
                            <BookmarkPlus className="w-3.5 h-3.5" />
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
