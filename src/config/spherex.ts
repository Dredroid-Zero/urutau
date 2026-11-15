import { DEFAULT_CAUTION_MASK, DEFAULT_REJECT_MASK, FLAG_BITS } from '../lib/astrometry';

export interface SpherexReleaseConfig {
  id: 'DR1' | 'QR3' | 'QR2' | 'DR2';
  label: string;
  collections: string[];
  available: boolean;
  searchable: boolean;
  surveyPeriod: string;
  notes: string;
}

export const SPHEREX_RELEASES: SpherexReleaseConfig[] = [
  {
    id: 'DR1',
    label: 'DR1 (Survey 1 & 2)',
    collections: ['spherex_dr1', 'spherex_dr1_deep', 'spherex_dr1_cube'],
    available: true,
    searchable: true,
    surveyPeriod: '2025-05-01 to 2026-05-15',
    notes: 'Reprocessed Survey 1 & 2 spectral images and All-Sky HiPS Cube (released Nov 2026).',
  },
  {
    id: 'QR3',
    label: 'QR3 (Survey 3 & 4, Weekly)',
    collections: ['spherex_qr3', 'spherex_qr3_deep'],
    available: true,
    searchable: true,
    surveyPeriod: '2026-05-16 onwards',
    notes: 'Weekly Quick Release 3 spectral images.',
  },
  {
    id: 'QR2',
    label: 'QR2 (Superseded)',
    collections: ['spherex_qr2'],
    available: true,
    searchable: false,
    surveyPeriod: 'Superseded by DR1/QR3',
    notes: 'Direct download only until Feb 2027; do not combine with DR1/QR3 without calibration warning.',
  },
  {
    id: 'DR2',
    label: 'DR2 (Planned Dec 2027)',
    collections: ['spherex_dr2', 'spherex_dr2_deep'],
    available: false,
    searchable: false,
    surveyPeriod: 'Planned Dec 2027',
    notes: 'Configuration placeholder for future Data Release 2.',
  },
];

export const SEARCHABLE_COLLECTIONS = [
  'spherex_dr1',
  'spherex_dr1_deep',
  'spherex_qr3',
  'spherex_qr3_deep',
] as const;

export const SPHEREX_ENDPOINTS = {
  irsaTapSync: 'https://irsa.ipac.caltech.edu/TAP/sync',
  irsaSia2: 'https://irsa.ipac.caltech.edu/SIA',
  irsaIbeBase: 'https://irsa.ipac.caltech.edu/ibe/data/spherex',
  irsaS3Bucket: 'https://nasa-irsa-spherex.s3.amazonaws.com',
  irsaHipsCube: 'https://irsa.ipac.caltech.edu/data/hips/SPHEREx/spherex_allsky_cube',
  irsaDataExplorerUi: 'https://irsa.ipac.caltech.edu/applications/spherex',
  simbadTapSync: 'https://simbad.cds.unistra.fr/simbad/sim-tap/sync',
  sesameMirrors: [
    'https://vizier.idia.ac.za/viz-bin/nph-sesame/-oxp',
    'https://cds.unistra.fr/cgi-bin/nph-sesame/-oxp',
  ],
  gaiaVizierMirror: 'https://vizier.idia.ac.za/viz-bin/asu-tsv',
  gaiaAriTapSync: 'https://gaia.ari.uni-heidelberg.de/tap/sync',
  gaiaEsacTapSync: 'https://gea.esac.esa.int/tap-server/tap/sync',
} as const;

export const TAP_SCHEMA_CONFIG = {
  schemaName: 'spherex',
  artifactTable: 'spherex.artifact',
  planeTable: 'spherex.plane',
  observationTable: 'spherex.observation',
} as const;

export const CUTOUT_DEFAULTS = {
  defaultFovDeg: 0.05,
  minFovDeg: 0.03,
  maxFovDeg: 0.2,
  pixelScaleArcsec: 6.15,
  psfFwhmArcsec: 7.5,
  maxConcurrentDownloads: 6,
  cutoutTimeoutMs: 120_000,
  tapTimeoutMs: 15_000,
  retryAttempts: 3,
  estimatedFullFileMb: 70,
  /** Empirical IRSA cutout MEF size at 0.05 deg (7 HDUs incl. 441-row EPSF + WCS-WAVE) ~ 3.96 MB */
  baseMefOverheadMb: 3.85,
  perPixelCutoutMb: 0.00013,
} as const;

export const FLAG_MASK_CONFIG = {
  defaultRejectMask: DEFAULT_REJECT_MASK,
  defaultCautionMask: DEFAULT_CAUTION_MASK,
  neverRejectBits: [FLAG_BITS.SOURCE] as readonly number[],
  provisionalNote:
    'Provisional defaults matching astrometry.ts; SOURCE (bit 21) is locked non-rejecting because it maps known catalogued pixels across most of the frame.',
} as const;

export function estimateCutoutTransfer(sizeDeg: number, frameCount: number): {
  pixelsPerSide: number;
  mbPerFrame: number;
  totalMb: number;
  estimatedSeconds: number;
} {
  const pixelsPerSide = Math.max(12, Math.round((sizeDeg * 3600) / CUTOUT_DEFAULTS.pixelScaleArcsec));
  const mbPerFrame =
    CUTOUT_DEFAULTS.baseMefOverheadMb +
    pixelsPerSide * pixelsPerSide * CUTOUT_DEFAULTS.perPixelCutoutMb;
  const totalMb = mbPerFrame * Math.max(0, frameCount);
  const batches = Math.max(1, Math.ceil(frameCount / CUTOUT_DEFAULTS.maxConcurrentDownloads));
  const estimatedSeconds = Math.round(batches * (1.8 + mbPerFrame * 0.45));
  return { pixelsPerSide, mbPerFrame, totalMb, estimatedSeconds };
}
