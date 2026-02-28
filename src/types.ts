/**
 * Types for UCI engine communication.
 */

export interface AnalysisLine {
  depth: number;
  score: number | null; // centipawns (raw: from side-to-move's perspective)
  mate: number | null; // mate in N moves (raw: from side-to-move's perspective)
  pv: string[]; // principal variation (UCI moves)
  multipv: number; // line number (1, 2, 3 for MultiPV)
}

export interface AnalysisInfo {
  depth: number;
  score: number | null; // centipawns (raw: from side-to-move's perspective)
  mate: number | null; // mate in N moves (raw: from side-to-move's perspective)
  pv: string[]; // principal variation (UCI moves)
  bestMove: string | null; // best move in UCI format
  fen: string | null; // the position this analysis belongs to
  lines?: AnalysisLine[]; // MultiPV lines (when enabled)
}

export const INITIAL_ANALYSIS: AnalysisInfo = {
  depth: 0,
  score: null,
  mate: null,
  pv: [],
  bestMove: null,
  fen: null,
};

/** Callbacks for engine events. */
export interface SfEvalCallbacks {
  /** Called on each analysis update (new depth, new PV, bestmove). */
  onAnalysisUpdate?: (analysis: AnalysisInfo) => void;
  /** Called when the engine encounters an error or crashes. */
  onError?: (error: string) => void;
}

/** Configuration options for the SfEval constructor. */
export interface SfEvalOptions extends SfEvalCallbacks {
  /**
   * URL or path to the Stockfish WASM/JS worker script.
   * @default '/engine/stockfish.js'
   */
  workerPath?: string;

  /**
   * Number of principal variations the engine computes.
   * @default 3
   */
  multiPV?: number;

  /**
   * Minimum depth before analysis results are emitted.
   * Prevents the evaluation from jumping at low depths.
   * @default 12
   */
  stableDepthThreshold?: number;

  /**
   * Enable debug logging to console.
   * @default false
   */
  debug?: boolean;
}
