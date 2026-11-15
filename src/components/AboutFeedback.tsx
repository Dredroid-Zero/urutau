import React, { useState } from 'react';
import { BookOpen, CheckCircle2, Download, ExternalLink, Mail, Send } from 'lucide-react';
import { triggerTextDownload } from '../lib/exports';
import type { Language } from '../lib/i18n';
import { TRANSLATIONS } from '../lib/i18n';

interface AboutFeedbackProps {
  lang: Language;
}

export const AboutFeedback: React.FC<AboutFeedbackProps> = ({ lang }) => {
  const t = TRANSLATIONS[lang];
  const [name, setName] = useState('');
  const [affiliation, setAffiliation] = useState('');
  const [category, setCategory] = useState('scientific');
  const [message, setMessage] = useState('');
  const [status, setStatus] = useState<'idle' | 'submitting' | 'sent' | 'error'>('idle');
  const [errorMsg, setErrorMsg] = useState('');

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (message.trim().length < 5) {
      setStatus('error');
      setErrorMsg('Please enter at least 5 characters.');
      return;
    }
    setStatus('submitting');
    setErrorMsg('');
    try {
      const resp = await fetch('/api/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, affiliation, category, message }),
      });
      const data = await resp.json();
      if (!resp.ok) {
        setStatus('error');
        setErrorMsg(data.error || 'Submission failed.');
      } else {
        setStatus('sent');
        setMessage('');
      }
    } catch {
      setStatus('error');
      setErrorMsg('Network error submitting feedback.');
    }
  };

  const handleDownloadJson = () => {
    const payload = {
      application: 'URUTAU: The Sky in Motion (GEPPAA / UNILAB)',
      exportedAt: new Date().toISOString(),
      name: name || 'Anonymous',
      affiliation,
      category,
      message,
    };
    triggerTextDownload(
      `urutau-feedback-${Date.now()}.json`,
      JSON.stringify(payload, null, 2),
      'application/json;charset=utf-8',
    );
  };

  const mailtoHref = `mailto:geppaa@unilab.edu.br?subject=${encodeURIComponent(
    `[URUTAU Feedback] ${category}`,
  )}&body=${encodeURIComponent(
    `Name: ${name || 'Anonymous'}\nAffiliation: ${affiliation}\nCategory: ${category}\n\n${message}`,
  )}`;

  return (
    <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
      <div className="lg:col-span-7 space-y-5">
        {/* About URUTAU */}
        <section className="bg-[#0B0E17] border border-slate-800 rounded-md p-6 space-y-3">
          <h2 className="text-lg font-semibold text-slate-100">{t.aboutTitle}</h2>
          <p className="text-sm text-slate-300 leading-relaxed">{t.aboutLead}</p>
          <p className="text-xs text-slate-400 leading-relaxed">{t.aboutIntegrity}</p>
        </section>

        {/* SPHEREx Mission */}
        <section className="bg-[#0B0E17] border border-slate-800 rounded-md p-6 space-y-3">
          <h3 className="text-sm font-semibold text-slate-100">{t.missionTitle}</h3>
          <p className="text-xs text-slate-300 leading-relaxed">{t.missionDesc}</p>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 pt-2 text-[11px] font-mono text-slate-300 tabular-nums">
            <div className="bg-[#07090E] border border-slate-800 rounded p-2">Band 1 · 0.75–1.09 µm (R=39)</div>
            <div className="bg-[#07090E] border border-slate-800 rounded p-2">Band 2 · 1.10–1.62 µm (R=41)</div>
            <div className="bg-[#07090E] border border-slate-800 rounded p-2">Band 3 · 1.63–2.41 µm (R=41)</div>
            <div className="bg-[#07090E] border border-slate-800 rounded p-2">Band 4 · 2.42–3.82 µm (R=35)</div>
            <div className="bg-[#07090E] border border-slate-800 rounded p-2">Band 5 · 3.83–4.41 µm (R=112)</div>
            <div className="bg-[#07090E] border border-slate-800 rounded p-2">Band 6 · 4.42–5.00 µm (R=128)</div>
          </div>
        </section>

        {/* GEPPAA / UNILAB Credits & References */}
        <section className="bg-[#0B0E17] border border-slate-800 rounded-md p-6 space-y-3">
          <h3 className="text-sm font-semibold text-slate-100">{t.creditsTitle}</h3>
          <p className="text-xs text-slate-300 leading-relaxed">{t.creditsDesc}</p>
          <div className="border-t border-slate-800 pt-3 space-y-1.5 text-xs text-slate-400">
            <div className="font-semibold text-slate-300 flex items-center gap-1.5">
              <BookOpen className="w-3.5 h-3.5 text-cyan-400" />
              {t.acknowledgementsTitle}
            </div>
            <p className="text-[11px] leading-relaxed">{t.acknowledgementsDesc}</p>
            <ul className="space-y-1 text-[11px] font-mono pt-1">
              <li>
                <a
                  href="https://irsa.ipac.caltech.edu/Missions/spherex.html"
                  target="_blank"
                  rel="noreferrer"
                  className="text-cyan-400 hover:underline inline-flex items-center gap-1"
                >
                  NASA/IPAC IRSA SPHEREx Archive <ExternalLink className="w-3 h-3" />
                </a>
              </li>
              <li>
                <a
                  href="https://irsa.ipac.caltech.edu/spherex-archive-documentation/"
                  target="_blank"
                  rel="noreferrer"
                  className="text-cyan-400 hover:underline inline-flex items-center gap-1"
                >
                  SPHEREx Archive User Guide & Explanatory Supplement <ExternalLink className="w-3 h-3" />
                </a>
              </li>
              <li>Mission: Bock et al. (2026) · Pipeline: Akeson et al. (2026) · Calibration: Korngut et al. (2026)</li>
            </ul>
          </div>
        </section>
      </div>

      {/* Right Feedback Form */}
      <div className="lg:col-span-5">
        <section className="bg-[#0B0E17] border border-slate-800 rounded-md p-6 space-y-4">
          <h3 className="text-sm font-semibold text-slate-100">{t.feedbackTitle}</h3>
          <p className="text-xs text-slate-400">{t.feedbackDesc}</p>

          <form onSubmit={handleSubmit} className="space-y-3">
            <label className="block space-y-1">
              <span className="text-xs text-slate-300">{t.feedbackName}</span>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Dr. Ana Silva"
                className="w-full bg-[#07090E] border border-slate-700 rounded px-3 py-2 text-xs text-slate-100"
              />
            </label>

            <label className="block space-y-1">
              <span className="text-xs text-slate-300">{t.feedbackAffiliation}</span>
              <input
                type="text"
                value={affiliation}
                onChange={(e) => setAffiliation(e.target.value)}
                placeholder="UNILAB / GEPPAA"
                className="w-full bg-[#07090E] border border-slate-700 rounded px-3 py-2 text-xs text-slate-100"
              />
            </label>

            <label className="block space-y-1">
              <span className="text-xs text-slate-300">{t.feedbackCategory}</span>
              <select
                value={category}
                onChange={(e) => setCategory(e.target.value)}
                className="w-full bg-[#07090E] border border-slate-700 rounded px-3 py-2 text-xs text-slate-100"
              >
                <option value="scientific">Scientific Accuracy / Astrometry</option>
                <option value="archive">IRSA SPHEREx Archive Access</option>
                <option value="usability">UI / Workflow Usability</option>
                <option value="bug">Bug Report</option>
              </select>
            </label>

            <label className="block space-y-1">
              <span className="text-xs text-slate-300">{t.feedbackMessage}</span>
              <textarea
                rows={4}
                required
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                placeholder="Describe your observation or suggestion..."
                className="w-full bg-[#07090E] border border-slate-700 rounded px-3 py-2 text-xs text-slate-100"
              />
            </label>

            {status === 'error' && <p className="text-xs text-rose-400">{errorMsg}</p>}
            {status === 'sent' && (
              <div className="text-xs text-emerald-300 flex items-center gap-1.5">
                <CheckCircle2 className="w-4 h-4" />
                {t.feedbackSuccess}
              </div>
            )}

            <button
              type="submit"
              disabled={status === 'submitting'}
              className="w-full bg-cyan-600 hover:bg-cyan-500 text-slate-950 text-xs font-semibold py-2.5 px-4 rounded flex items-center justify-center gap-1.5 cursor-pointer"
            >
              <Send className="w-3.5 h-3.5" />
              {status === 'submitting' ? 'Saving...' : t.submitFeedback}
            </button>

            <div className="grid grid-cols-2 gap-2 pt-1">
              <button
                type="button"
                onClick={handleDownloadJson}
                className="px-3 py-2 rounded bg-[#07090E] hover:bg-slate-800 border border-slate-700 text-xs text-slate-200 flex items-center justify-center gap-1.5 cursor-pointer"
              >
                <Download className="w-3.5 h-3.5 text-cyan-400" />
                {t.exportFeedbackJson}
              </button>
              <a
                href={mailtoHref}
                className="px-3 py-2 rounded bg-[#07090E] hover:bg-slate-800 border border-slate-700 text-xs text-slate-200 flex items-center justify-center gap-1.5"
              >
                <Mail className="w-3.5 h-3.5 text-cyan-400" />
                {t.emailFeedback}
              </a>
            </div>
          </form>
        </section>
      </div>
    </div>
  );
};
