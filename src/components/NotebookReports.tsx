import React, { useRef, useState } from 'react';
import {
  Download,
  FileCode2,
  FileSpreadsheet,
  FileText,
  FolderPlus,
  Trash2,
  Upload,
} from 'lucide-react';
import { degToDms, degToHms } from '../lib/astronomy';
import {
  exportInvestigationCsv,
  exportInvestigationEcsv,
  exportInvestigationJson,
  generateInvestigationPdf,
  parseImportedNotebookJson,
  triggerTextDownload,
} from '../lib/exports';
import type { Language } from '../lib/i18n';
import { TRANSLATIONS } from '../lib/i18n';
import type { InvestigationRecord } from '../types/spherex';

interface NotebookReportsProps {
  lang: Language;
  investigations: InvestigationRecord[];
  activeId: string;
  onSelectInvestigation: (id: string) => void;
  onCreateInvestigation: () => void;
  onImportInvestigation: (inv: InvestigationRecord) => void;
  onDeleteInvestigation: (id: string) => void;
  onUpdateActive: (patch: Partial<InvestigationRecord>) => void;
  onAttachCurrentRegion: () => void;
}

export const NotebookReports: React.FC<NotebookReportsProps> = ({
  lang,
  investigations,
  activeId,
  onSelectInvestigation,
  onCreateInvestigation,
  onImportInvestigation,
  onDeleteInvestigation,
  onUpdateActive,
  onAttachCurrentRegion,
}) => {
  const t = TRANSLATIONS[lang];
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const active = investigations.find((i) => i.id === activeId) ?? investigations[0] ?? null;

  const handleImportFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setImportError(null);
    try {
      const text = await file.text();
      const parsed = parseImportedNotebookJson(text);
      onImportInvestigation(parsed);
    } catch (err) {
      setImportError((err as Error).message || 'Could not import notebook JSON.');
    }
  };

  return (
    <div className="grid grid-cols-1 lg:grid-cols-12 gap-4">
      {/* Left Investigation List */}
      <aside className="lg:col-span-4 bg-[#0B0E17] border border-slate-800 rounded-md p-4 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm font-semibold text-slate-100">{t.notebookTitle}</h2>
          <div className="flex items-center gap-1.5">
            <input
              ref={fileInputRef}
              type="file"
              accept="application/json,.json"
              onChange={handleImportFile}
              className="hidden"
            />
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="px-2 py-1.5 rounded bg-[#07090E] hover:bg-slate-800 border border-slate-700 text-slate-200 text-xs flex items-center gap-1 cursor-pointer whitespace-nowrap"
            >
              <Upload className="w-3.5 h-3.5" />
              {t.importNotebookJson}
            </button>
            <button
              type="button"
              onClick={onCreateInvestigation}
              className="px-2.5 py-1.5 rounded bg-cyan-600 hover:bg-cyan-500 text-slate-950 text-xs font-semibold flex items-center gap-1 cursor-pointer whitespace-nowrap"
            >
              <FolderPlus className="w-3.5 h-3.5" />
              {t.createInvestigation}
            </button>
          </div>
        </div>

        <p className="text-[11px] text-slate-400">
          {t.notebookLocalHint}
        </p>
        {importError && <p className="text-xs text-rose-400">{importError}</p>}

        <div className="space-y-2 max-h-[540px] overflow-y-auto">
          {investigations.map((inv) => {
            const isSel = inv.id === active?.id;
            const detCount = inv.astrometryDetections?.length ?? inv.detections.length;
            const trackCount = inv.astrometryTracks?.length ?? 0;
            return (
              <div
                key={inv.id}
                className={`border rounded p-3 transition-colors ${
                  isSel
                    ? 'bg-cyan-950/30 border-cyan-500/50'
                    : 'bg-[#07090E] border-slate-800 hover:border-slate-700'
                }`}
              >
                <div className="flex items-start justify-between gap-2">
                  <button
                    type="button"
                    onClick={() => onSelectInvestigation(inv.id)}
                    className="text-left flex-1 cursor-pointer"
                  >
                    <div className="text-xs font-semibold text-slate-100">
                      {inv.title || 'Untitled Investigation'}
                    </div>
                    <div className="text-[11px] font-mono text-slate-400 mt-0.5 tabular-nums">
                      {inv.targetName} · {inv.observations.length} obs · {detCount} det · {trackCount} tracks
                    </div>
                  </button>
                  {investigations.length > 1 && (
                    <button
                      type="button"
                      onClick={() => onDeleteInvestigation(inv.id)}
                      aria-label={`Delete ${inv.title}`}
                      className="p-1 text-slate-500 hover:text-rose-400 cursor-pointer"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </aside>

      {/* Right Active Investigation Editor & Exports */}
      <div className="lg:col-span-8 space-y-4">
        {!active ? (
          <div className="bg-[#0B0E17] border border-slate-800 rounded-md p-8 text-center text-xs text-slate-400">
            Create an investigation to begin recording astronomical notes, measurements, and exports.
          </div>
        ) : (
          <>
            <div className="bg-[#0B0E17] border border-slate-800 rounded-md p-4 space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="text-xs font-mono text-cyan-300 tabular-nums">
                  Region: {active.targetName} · {degToHms(active.raDeg, 3)} {degToDms(active.decDeg, 2)} (r={active.regionRadiusDeg}°)
                </div>
                <button
                  type="button"
                  onClick={onAttachCurrentRegion}
                  className="px-2.5 py-1 rounded bg-[#07090E] border border-slate-700 text-xs text-slate-300 hover:text-white cursor-pointer"
                >
                  {t.syncRegionBtn}
                </button>
              </div>

              <label className="block space-y-1">
                <span className="text-xs font-medium text-slate-300">{t.investigationTitle}</span>
                <input
                  type="text"
                  value={active.title}
                  onChange={(e) => onUpdateActive({ title: e.target.value })}
                  className="w-full bg-[#07090E] border border-slate-700 focus:border-cyan-500 rounded px-3 py-2 text-sm text-slate-100 focus:outline-none"
                />
              </label>

              <label className="block space-y-1">
                <span className="text-xs font-medium text-slate-300">{t.hypothesis}</span>
                <textarea
                  rows={3}
                  value={active.hypothesis}
                  onChange={(e) => onUpdateActive({ hypothesis: e.target.value })}
                  placeholder="Describe the physical hypothesis (e.g. expected proper motion rate or dust-induced infrared dimming)..."
                  className="w-full bg-[#07090E] border border-slate-700 focus:border-cyan-500 rounded px-3 py-2 text-xs text-slate-100 placeholder:text-slate-500 focus:outline-none"
                />
              </label>

              <label className="block space-y-1">
                <span className="text-xs font-medium text-slate-300">{t.conclusions}</span>
                <textarea
                  rows={3}
                  value={active.conclusions}
                  onChange={(e) => onUpdateActive({ conclusions: e.target.value })}
                  placeholder="Record verified findings, measurement uncertainties, and open limitations..."
                  className="w-full bg-[#07090E] border border-slate-700 focus:border-cyan-500 rounded px-3 py-2 text-xs text-slate-100 placeholder:text-slate-500 focus:outline-none"
                />
              </label>
            </div>

            {/* Saved Observations, Epoch Notes & Snapshots */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="bg-[#0B0E17] border border-slate-800 rounded-md p-4 space-y-2">
                <h3 className="text-xs font-semibold text-slate-300 uppercase tracking-wider">
                  {t.savedNotes} ({active.epochNotes.length})
                </h3>
                {active.epochNotes.length === 0 ? (
                  <p className="text-xs text-slate-500">
                    No epoch notes saved yet. Add notes directly below any frame in Temporal Lab.
                  </p>
                ) : (
                  <div className="space-y-2 max-h-[200px] overflow-y-auto">
                    {active.epochNotes.map((n) => (
                      <div key={n.id} className="bg-[#07090E] border border-slate-800 rounded p-2.5 text-xs">
                        <div className="font-mono text-[11px] text-cyan-300">
                          {n.obsId} · {n.dateObs.slice(0, 19)}
                        </div>
                        <p className="text-slate-200 mt-1">{n.note}</p>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <div className="bg-[#0B0E17] border border-slate-800 rounded-md p-4 space-y-2">
                <h3 className="text-xs font-semibold text-slate-300 uppercase tracking-wider">
                  {t.savedSnapshots} ({active.snapshots.length})
                </h3>
                {active.snapshots.length === 0 ? (
                  <p className="text-xs text-slate-500">
                    Capture visual frames from the Temporal Viewer to include them in PDF reports.
                  </p>
                ) : (
                  <div className="grid grid-cols-2 gap-2 max-h-[200px] overflow-y-auto">
                    {active.snapshots.map((s) => (
                      <div key={s.id} className="bg-[#07090E] border border-slate-800 rounded p-1.5">
                        <img
                          src={s.dataUrl}
                          alt={s.label}
                          className="w-full h-24 object-cover rounded"
                        />
                        <div className="text-[10px] font-mono text-slate-400 truncate mt-1">
                          {s.label}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>

            {/* Reports & Exports */}
            <div className="bg-[#0B0E17] border border-slate-800 rounded-md p-4 space-y-3">
              <div>
                <h3 className="text-sm font-semibold text-slate-100">{t.exportReportsTitle}</h3>
                <p className="text-xs text-slate-400 mt-0.5">
                  All exports preserve target coordinates, observation identifiers, epochs, spectral bands, uncertainties, and scientific limitations.
                </p>
              </div>

              <div className="flex flex-wrap gap-2.5">
                <button
                  type="button"
                  onClick={() =>
                    triggerTextDownload(
                      `urutau-${active.id}.csv`,
                      exportInvestigationCsv(active),
                      'text/csv;charset=utf-8',
                    )
                  }
                  className="px-3 py-2 rounded bg-[#07090E] hover:bg-slate-800 border border-slate-700 text-xs font-medium text-slate-100 flex items-center gap-1.5 cursor-pointer"
                >
                  <FileSpreadsheet className="w-3.5 h-3.5 text-cyan-400" />
                  {t.exportCsv}
                </button>

                <button
                  type="button"
                  onClick={() =>
                    triggerTextDownload(
                      `urutau-${active.id}.ecsv`,
                      exportInvestigationEcsv(active),
                      'text/plain;charset=utf-8',
                    )
                  }
                  className="px-3 py-2 rounded bg-[#07090E] hover:bg-slate-800 border border-slate-700 text-xs font-medium text-slate-100 flex items-center gap-1.5 cursor-pointer"
                >
                  <FileCode2 className="w-3.5 h-3.5 text-cyan-400" />
                  {t.exportEcsv} (IVOA / Astropy)
                </button>

                <button
                  type="button"
                  onClick={() =>
                    triggerTextDownload(
                      `urutau-${active.id}-provenance.json`,
                      exportInvestigationJson(active),
                      'application/json;charset=utf-8',
                    )
                  }
                  className="px-3 py-2 rounded bg-[#07090E] hover:bg-slate-800 border border-slate-700 text-xs font-medium text-slate-100 flex items-center gap-1.5 cursor-pointer"
                >
                  <Download className="w-3.5 h-3.5 text-cyan-400" />
                  {t.exportJson}
                </button>

                <button
                  type="button"
                  onClick={() => generateInvestigationPdf(active)}
                  className="px-3.5 py-2 rounded bg-cyan-600 hover:bg-cyan-500 text-slate-950 text-xs font-semibold flex items-center gap-1.5 cursor-pointer"
                >
                  <FileText className="w-3.5 h-3.5" />
                  {t.exportPdf}
                </button>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
};
