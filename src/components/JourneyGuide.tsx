import React from 'react';
import type { Language } from '../lib/i18n';

type Step = 'explorer' | 'observations' | 'temporal' | 'notebook';

interface JourneyGuideProps {
  lang: Language;
  activeTab: Step | 'about';
  observationCount: number;
  frameCount: number;
  onNavigate: (tab: Step) => void;
}

/** Short, predictable path for citizen scientists. Expert tools remain available inside each step. */
export function JourneyGuide({ lang, activeTab, observationCount, frameCount, onNavigate }: JourneyGuideProps) {
  const pt = lang === 'pt';
  const steps: { key: Step; title: string; hint: string }[] = pt
    ? [
        { key: 'explorer', title: 'Explorar o céu', hint: 'Escolha no mapa' },
        { key: 'observations', title: 'Selecionar imagens', hint: 'Compare datas e filtros' },
        { key: 'temporal', title: 'Ver mudanças', hint: 'Anime e marque objetos' },
        { key: 'notebook', title: 'Salvar descobertas', hint: 'Seu caderno local' },
      ]
    : [
        { key: 'explorer', title: 'Explore the sky', hint: 'Choose on the map' },
        { key: 'observations', title: 'Select images', hint: 'Compare dates and bands' },
        { key: 'temporal', title: 'Watch changes', hint: 'Animate and mark objects' },
        { key: 'notebook', title: 'Save discoveries', hint: 'Your local notebook' },
      ];

  return (
    <section className="mb-4 rounded-2xl border border-slate-800 bg-gradient-to-r from-[#111d30] via-[#101626] to-[#090d16] p-4 md:p-5" aria-label={pt ? 'Passos da exploração' : 'Exploration steps'}>
      <div className="flex flex-wrap justify-between items-center gap-3 mb-4">
        <div>
          <p className="text-[11px] uppercase tracking-[0.18em] text-cyan-300 font-semibold">URUTAU · SPHEREx</p>
          <h1 className="text-xl md:text-2xl font-semibold tracking-tight text-white">{pt ? 'Explore o universo, uma imagem de cada vez.' : 'Explore the universe, one image at a time.'}</h1>
          <p className="text-sm text-slate-400 mt-1">{pt ? 'Do mapa do céu à descoberta, sem precisar conhecer astronomia profissional.' : 'From a sky map to a discovery, no professional astronomy experience needed.'}</p>
        </div>
        <div className="text-xs flex flex-wrap gap-2">
          <span className="rounded-full border border-slate-700 bg-slate-900/70 px-3 py-1.5 text-slate-200">{observationCount} {pt ? 'observações listadas' : 'observations listed'}</span>
          <span className="rounded-full border border-slate-700 bg-slate-900/70 px-3 py-1.5 text-slate-200">{frameCount} {pt ? 'imagens carregadas' : 'frames loaded'}</span>
        </div>
      </div>
      <ol className="grid grid-cols-2 lg:grid-cols-4 gap-2">
        {steps.map((step, i) => {
          const selected = activeTab === step.key;
          return (
            <li key={step.key}>
              <button type="button" onClick={() => onNavigate(step.key)} aria-current={selected ? 'step' : undefined}
                className={selected
                  ? 'w-full h-full rounded-xl border border-cyan-400/70 bg-cyan-900/25 p-3 text-left flex items-start gap-3 focus-visible:outline-2 focus-visible:outline-cyan-300'
                  : 'w-full h-full rounded-xl border border-slate-700 bg-slate-950/40 hover:bg-slate-800 p-3 text-left flex items-start gap-3 focus-visible:outline-2 focus-visible:outline-cyan-300'}>
                <span className={selected ? 'rounded-full bg-cyan-400 text-slate-950 w-7 h-7 shrink-0 grid place-items-center text-xs font-bold' : 'rounded-full bg-slate-800 text-slate-300 w-7 h-7 shrink-0 grid place-items-center text-xs font-bold'}>{i + 1}</span>
                <span><span className="block text-sm font-semibold text-slate-100">{step.title}</span><span className="block text-xs text-slate-400 mt-0.5">{step.hint}</span></span>
              </button>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
