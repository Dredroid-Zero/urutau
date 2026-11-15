import type { Detection, MotionFit, SourceStatus, Track, WcsModel } from '../lib/astrometry';
import type { SpherexFlagSummary, TanSipWcs, WaveWcsTable } from '../lib/fits';

export type ObservationFetchStatus = 'listed' | 'retrieving' | 'retrieved' | 'failed';

export interface SpherexObservation {
  id: string;
  obsId: string;
  productId: string;
  planningPeriod?: string;
  version?: string;
  collection:
    | 'spherex_dr1'
    | 'spherex_dr1_deep'
    | 'spherex_qr3'
    | 'spherex_qr3_deep'
    | 'spherex_dr1_cube'
    | 'spherex_qr2'
    | 'spherex_dr2'
    | 'spherex_dr2_deep';
  release: 'DR1' | 'QR3' | 'QR2' | 'DR2';
  surveyMode: 'Wide' | 'Deep' | 'All-Sky Cube';
  detector: number;
  bandpassName: string;
  lambdaMinUm: number;
  lambdaMaxUm: number;
  targetWavelengthUm?: number;
  dateObs: string;
  mjdObs: number;
  ra: number;
  dec: number;
  exposureSec?: number;
  sRegion?: string;
  footprintPolygon?: [number, number][];
  estimatedSizeMb?: number;
  qualityStatus: string;
  accessUrl: string;
  cutoutPath: string;
  cloudAccess?: string;
  provenanceSource: 'IRSA-SIA2' | 'IRSA-TAP' | 'IRSA-CUTOUT-VERIFIED' | 'IRSA-HIPS5-CUBE' | 'IRSA-S3-INDEX';
  fetchStatus?: ObservationFetchStatus;
  fetchError?: string;
}

export interface ArchiveDiagnostics {
  tapStatus: 'ok' | 'upstream_error' | 'timeout' | 'skipped';
  tapMessage: string;
  tapColumnsCount?: number;
  siaStatus: 'ok' | 'upstream_error' | 'timeout' | 'skipped';
  siaMessage: string;
  cubeAvailable: boolean;
  cubeInfo: {
    order: number;
    ipix: number;
    dirId: number;
    cubeUrl: string;
    s3CubeUrl: string;
  };
  dedupRemovedCount?: number;
  queriedAt: string;
}

export interface RuntimeFlagDefinition {
  bit: number;
  mask: number;
  name: string;
  description: string;
}

export interface LoadedSpherexFrame {
  frameId: string;
  observation: SpherexObservation;
  width: number;
  height: number;
  /** Surface brightness in MJy/sr (row-major, height * width) */
  image: Float32Array;
  /** Variance in (MJy/sr)^2, if present */
  variance?: Float32Array;
  /** Modeled zodiacal background in MJy/sr, if present */
  zodi?: Float32Array;
  /** Per-pixel bitmask flags, if present */
  flags?: Uint32Array;
  flagSummary?: SpherexFlagSummary;
  flagDefinitions?: RuntimeFlagDefinition[];
  wcs: TanSipWcs | null;
  astrometryWcs?: WcsModel | null;
  waveWcs?: WaveWcsTable | null;
  /** Wavelength & bandwidth evaluated at cutout target sky position */
  targetWavelengthUm?: number;
  targetBandwidthUm?: number;
  /** Optional single wavelength for DR1 All-Sky Cube slice (um) */
  sliceWavelengthUm?: number;
  /** Spectral vs temporal distinction */
  isSpectralCubeSlice: boolean;
  isStacked?: boolean;
  stackedFromCount?: number;
  stackMethod?: 'median' | 'mean';
  psfFwhmArcsec?: number;
  version?: string;
  exposureSec?: number;
  l2DqaFlag?: string;
  contaminationFlags: {
    heAirglow: boolean;
    aurora: boolean;
    shuttleGlow: boolean;
  };
  headersSummary: Record<string, string | number | boolean>;
  cutoutCenterRa: number;
  cutoutCenterDec: number;
  cutoutSizeDeg: number;
}

export interface GaiaSource {
  sourceId: string;
  ra: number;
  dec: number;
  pmra: number; // mas/yr (includes cos(dec))
  pmdec: number; // mas/yr
  gMag?: number;
  epochYear: number; // 2016.0 for Gaia DR3
}

export interface ResolvedTargetInfo {
  query: string;
  name: string;
  ra: number;
  dec: number;
  pmRaMasYr: number;
  pmDecMasYr: number;
  epochYear: number;
  otype: string;
  source: string;
  resolvedAt: string;
}

export interface AstrometricDetectionRecord extends Detection {
  id: string;
  obsId: string;
  dateObs: string;
  release: string;
  version: string;
  wavelengthUm?: number;
  bandwidthUm?: number;
  rejectMaskUsed: number;
  cautionMaskUsed: number;
  systematicArcsec?: number;
  nearestGaiaId?: string;
  nearestGaiaSepArcsec?: number;
}

export interface AstrometricTrackRecord {
  id: string;
  detector: number;
  detections: AstrometricDetectionRecord[];
  fit?: MotionFit;
  status: SourceStatus;
}

/** Legacy v1 source type retained for backward compatibility with existing saved notebooks */
export interface DetectedSource {
  id: string;
  frameId: string;
  obsId: string;
  dateObs: string;
  mjdObs: number;
  detector: number;
  bandpassName: string;
  x: number;
  y: number;
  ra: number;
  dec: number;
  centroidErrorPx: number;
  astrometricUncertaintyArcsec: number;
  snr: number;
  peakFluxMJySr: number;
  apertureFluxMJySr: number;
  apertureFluxJy: number;
  fluxUncertaintyMJySr: number;
  zodiBackgroundMJySr: number;
  fwhmPx: number;
  wavelengthUm?: number;
  bandwidthUm?: number;
  flaggedPixelsInAperture: number;
  qualityNote: string;
  status: 'automatic_detection' | 'candidate_match' | 'user_confirmed';
}

export interface CrossEpochMotionCandidate {
  id: string;
  sourceA: DetectedSource;
  sourceB: DetectedSource;
  deltaTimeDays: number;
  deltaArcsec: number;
  deltaRaArcsec: number;
  deltaDecArcsec: number;
  positionAngleDeg: number;
  combinedUncertaintyArcsec: number;
  sigmaSignificance: number;
  apparentRateArcsecYr: number;
  sameBand: boolean;
  classification: 'consistent_with_noise' | 'candidate_motion' | 'bandpass_shift_caution';
  cautionNote: string;
}

export interface InvestigationRecord {
  id: string;
  title: string;
  targetName: string;
  raDeg: number;
  decDeg: number;
  regionRadiusDeg: number;
  hypothesis: string;
  conclusions: string;
  createdAt: string;
  updatedAt: string;
  observations: SpherexObservation[];
  detections: DetectedSource[];
  astrometryDetections?: AstrometricDetectionRecord[];
  astrometryTracks?: AstrometricTrackRecord[];
  processingSettings?: {
    snrThreshold: number;
    maxRateArcsecYr: number;
    rejectMask: number;
    cautionMask: number;
    extraScatterArcsec?: number;
    reprojectedToSkyGrid?: boolean;
  };
  motionCandidates: CrossEpochMotionCandidate[];
  epochNotes: {
    id: string;
    frameId: string;
    obsId: string;
    dateObs: string;
    note: string;
    createdAt: string;
  }[];
  snapshots: {
    id: string;
    label: string;
    dataUrl: string;
    createdAt: string;
  }[];
}

export type { Detection, MotionFit, SourceStatus, Track };
