import { useState, useRef, useEffect } from 'react';
import { SfEval } from './sfeval';
import { INITIAL_ANALYSIS } from './types';
import type { AnalysisInfo } from './types';

export interface UseSfEvalOptions {
  /** FEN of the position to analyze. Pass null/undefined to pause analysis. */
  fen: string | null | undefined;
  /** Maximum search depth. @default 25 */
  maxDepth?: number;
  /** URL or path to the Stockfish WASM/JS worker script. @default '/engine/stockfish.js' */
  workerPath?: string;
  /** Number of principal variations. @default 3 */
  multiPV?: number;
  /** Minimum depth before results are emitted. @default 12 */
  stableDepthThreshold?: number;
  /** Enable debug logging. @default false */
  debug?: boolean;
  /** Called when the engine encounters an error. */
  onError?: (error: string) => void;
}

export interface UseSfEvalReturn {
  /** Current analysis state. Resets to INITIAL_ANALYSIS on fen change. */
  analysis: AnalysisInfo;
  /** The underlying SfEval engine instance, or null before init. */
  engine: SfEval | null;
  /** Whether the engine is initialized and ready to analyze. */
  isReady: boolean;
  /** Last error string from the engine, or null. */
  error: string | null;
}

export function useSfEval(options: UseSfEvalOptions): UseSfEvalReturn {
  const { fen, maxDepth } = options;

  const [analysis, setAnalysis] = useState<AnalysisInfo>(INITIAL_ANALYSIS);
  const [isReady, setIsReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const engineRef = useRef<SfEval | null>(null);
  const onErrorRef = useRef(options.onError);

  // Keep error callback ref fresh on every render
  onErrorRef.current = options.onError;

  // --- Engine lifecycle (mount/unmount) ---
  useEffect(() => {
    const engine = new SfEval({
      workerPath: options.workerPath,
      multiPV: options.multiPV,
      stableDepthThreshold: options.stableDepthThreshold,
      debug: options.debug,
      onAnalysisUpdate: (info) => setAnalysis(info),
      onError: (err) => {
        setError(err);
        onErrorRef.current?.(err);
      },
    });
    engineRef.current = engine;

    engine.init().then(() => {
      setIsReady(true);
    }).catch((err) => {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
      onErrorRef.current?.(msg);
    });

    return () => {
      engineRef.current = null;
      engine.destroy();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // --- Auto-analyze when fen or maxDepth changes ---
  useEffect(() => {
    if (!isReady || !engineRef.current) return;

    if (fen) {
      setAnalysis(INITIAL_ANALYSIS);
      engineRef.current.analyze(fen, maxDepth);
    } else {
      engineRef.current.stop();
      setAnalysis(INITIAL_ANALYSIS);
    }
  }, [fen, isReady, maxDepth]);

  return {
    analysis,
    engine: engineRef.current,
    isReady,
    error,
  };
}
