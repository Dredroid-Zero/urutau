import type { ResolvedTargetInfo } from '../types/spherex';

export interface ChallengeTarget {
  id: string;
  name: string;
  namePt: string;
  category: 'high-pm' | 'variable' | 'reference';
  /** Only WISE 0855 (challenge text) and IRSA QR3 calibration pointing have preset coordinates; others resolve live via SIMBAD. */
  simbadResolveRequired: boolean;
  simbadId: string;
  raDeg: number | null;
  decDeg: number | null;
  raDisplay: string;
  decDisplay: string;
  coordEpochNote: string;
  pmRaMasYr: number | null;
  pmDecMasYr: number | null;
  epochYear: number | null;
  resolvedInfo?: ResolvedTargetInfo;
  summaryEn: string;
  summaryPt: string;
  scienceGoalEn: string;
  scienceGoalPt: string;
  resolutionNoteEn?: string;
  resolutionNotePt?: string;
}

export const CHALLENGE_TARGETS: ChallengeTarget[] = [
  {
    id: 'wise-0855',
    name: 'WISE 0855',
    namePt: 'WISE 0855',
    category: 'high-pm',
    simbadResolveRequired: false,
    simbadId: 'WISE J085510.83-071442.5',
    // Exact challenge prompt coordinates: RA 08h55m10.831s, Dec -07°14'42.53"
    raDeg: 133.7951292,
    decDeg: -7.2451472,
    raDisplay: '08h55m10.831s',
    decDisplay: '-07°14\'42.53"',
    coordEpochNote: 'Challenge text position (epoch not stated; discovery ~2014). Use FoV >= 0.05° for several arcsec of drift; expect possible non-detections in single exposures.',
    pmRaMasYr: null,
    pmDecMasYr: null,
    epochYear: 2014,
    summaryEn: 'Coldest known Y-dwarf brown dwarf (~250 K) and fast mover. Extremely red and faint; single exposures may yield non-detections (try per-detector stacking).',
    summaryPt: 'Anã marrom tipo Y mais fria conhecida (~250 K) e de rápido movimento próprio. Extremamente vermelha e tênue; exposições únicas podem não detectá-la (tente empilhamento por detector).',
    scienceGoalEn: 'Check per-detector coverage and stack Band 5–6 exposures if undetected in single frames.',
    scienceGoalPt: 'Verificar cobertura por detector e empilhar exposições das Bandas 5–6 se não detectada em quadros individuais.',
  },
  {
    id: 'barnards-star',
    name: "Barnard's Star",
    namePt: 'Estrela de Barnard',
    category: 'high-pm',
    simbadResolveRequired: true,
    simbadId: "Barnard's Star",
    raDeg: null,
    decDeg: null,
    raDisplay: 'Resolve via SIMBAD',
    decDisplay: 'ICRS / PM live',
    coordEpochNote: 'Fetched at runtime from SIMBAD / CDS Sesame; compare with Gaia DR3 epoch 2016.0 propagated to SPHEREx observation epochs.',
    pmRaMasYr: null,
    pmDecMasYr: null,
    epochYear: null,
    summaryEn: 'Very high proper motion (~10.3"/yr). Propagate Gaia DR3 epoch 2016.0 to SPHEREx epochs to verify the expected ~1.5 px/yr shift.',
    summaryPt: 'Movimento próprio muito alto (~10,3"/ano). Propague a época 2016.0 do Gaia DR3 para as épocas do SPHEREx para verificar o deslocamento de ~1,5 px/ano.',
    scienceGoalEn: 'Measure sub-year motion across reprojected single-detector frames and compare against Gaia DR3.',
    scienceGoalPt: 'Medir o movimento subanual entre quadros reprojetados de um único detector e comparar com o Gaia DR3.',
  },
  {
    id: 'epsilon-indi-b',
    name: 'Epsilon Indi B',
    namePt: 'Épsilon Indi B',
    category: 'high-pm',
    simbadResolveRequired: true,
    simbadId: 'eps Ind B',
    raDeg: null,
    decDeg: null,
    raDisplay: 'Resolve via SIMBAD',
    decDisplay: 'ICRS / PM live',
    coordEpochNote: 'Fetched at runtime from SIMBAD / CDS Sesame. Note bright primary Epsilon Indi A nearby.',
    pmRaMasYr: null,
    pmDecMasYr: null,
    epochYear: null,
    summaryEn: 'Binary brown-dwarf pair (T1/T6) with high southern-sky proper motion; bright primary nearby.',
    summaryPt: 'Par binário de anãs marrons (T1/T6) com alto movimento próprio austral; estrela primária brilhante próxima.',
    scienceGoalEn: 'Inspect blended infrared PSF and check proper motion vector against Gaia DR3.',
    scienceGoalPt: 'Inspecionar a PSF infravermelha combinada e verificar o vetor de movimento próprio com o Gaia DR3.',
    resolutionNoteEn: 'Resolution Reality Check: At SPHEREx plate scale (~6.15"/px, PSF FWHM ~7.5"), the Epsilon Indi B binary pair (~0.7" separation) is completely unresolved.',
    resolutionNotePt: 'Checagem de Resolução: Na escala do SPHEREx (~6,15"/px, PSF FWHM ~7,5"), o par binário Épsilon Indi B (~0,7") não é resolvido.',
  },
  {
    id: 'rw-aurigae',
    name: 'RW Aurigae',
    namePt: 'RW Aurigae',
    category: 'variable',
    simbadResolveRequired: true,
    simbadId: 'RW Aur',
    raDeg: null,
    decDeg: null,
    raDisplay: 'Resolve via SIMBAD',
    decDisplay: 'ICRS / PM live',
    coordEpochNote: 'Fetched at runtime from SIMBAD / CDS Sesame.',
    pmRaMasYr: null,
    pmDecMasYr: null,
    epochYear: null,
    summaryEn: 'Classical T Tauri variable star. Always compare brightness within the same detector and a narrow wavelength window (±3%).',
    summaryPt: 'Estrela variável T Tauri clássica. Sempre compare o brilho dentro do mesmo detector e janela estreita de comprimento de onda (±3%).',
    scienceGoalEn: 'Track same-detector photometry across epochs while guarding against LVF wavelength shifts.',
    scienceGoalPt: 'Acompanhar fotometria no mesmo detector entre épocas evitando efeitos espectrais do LVF.',
  },
  {
    id: 'r-draconis',
    name: 'R Draconis',
    namePt: 'R Draconis',
    category: 'variable',
    simbadResolveRequired: true,
    simbadId: 'R Dra',
    raDeg: null,
    decDeg: null,
    raDisplay: 'Resolve via SIMBAD',
    decDisplay: 'ICRS / PM live',
    coordEpochNote: 'Fetched at runtime from SIMBAD / CDS Sesame.',
    pmRaMasYr: null,
    pmDecMasYr: null,
    epochYear: null,
    summaryEn: 'Mira-type AGB variable star near the North Ecliptic Pole; compare brightness only within same detector and wavelength window.',
    summaryPt: 'Estrela variável tipo Mira próxima ao Polo Eclíptico Norte; compare brilho apenas no mesmo detector e janela espectral.',
    scienceGoalEn: 'Monitor pulsation amplitude in consistent SPHEREx band/wavelength epochs.',
    scienceGoalPt: 'Monitorar amplitude de pulsação em épocas consistentes de banda e comprimento de onda.',
  },
  {
    id: 'spherex-qr3-cal',
    name: 'SPHEREx QR3 Field',
    namePt: 'Campo QR3 SPHEREx',
    category: 'reference',
    simbadResolveRequired: false,
    simbadId: '223130.80-051121.0',
    raDeg: 337.8783221,
    decDeg: -5.1891588,
    raDisplay: '22h31m30.797s',
    decDisplay: '-05°11\'20.97"',
    coordEpochNote: 'IRSA SPHEREx Archive Documentation tutorial multi-slew pointing (2026W21_2A_0001_2D1..4D1).',
    pmRaMasYr: 0,
    pmDecMasYr: 0,
    epochYear: 2026.39,
    summaryEn: 'Verified IRSA SPHEREx QR3 consecutive slew pointing with direct IBE cutouts (Detector 1) for WCS reprojection and Gaia DR3 cross-checks.',
    summaryPt: 'Apontamento verificado do SPHEREx QR3 no IRSA com recortes IBE diretos (Detector 1) para reprojeção WCS e comparação com Gaia DR3.',
    scienceGoalEn: 'Verify WCS-WAVE interpolation, sky-aligned reprojection (< 1" static star residual), and Gaia DR3 cross-matching.',
    scienceGoalPt: 'Verificar interpolação WCS-WAVE, reprojeção celeste (< 1" em estrela estática) e comparação com Gaia DR3.',
  },
];
