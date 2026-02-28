/**
 * Stockfish Web Worker wrapper.
 * Manages the engine lifecycle and UCI communication.
 */

import type { AnalysisInfo, AnalysisLine, SfEvalOptions, SfEvalCallbacks } from './types';
import { INITIAL_ANALYSIS } from './types';

export class SfEval {
  // Configuration
  private readonly workerPath: string;
  private multiPV: number; // not readonly — can change via setOption()
  private readonly stableDepthThreshold: number;
  private readonly debugEnabled: boolean;

  // Callbacks
  private onAnalysisUpdate: ((analysis: AnalysisInfo) => void) | null;
  private onError: ((error: string) => void) | null;

  // Engine state
  private worker: Worker | null = null;
  private isReady = false;
  private isDestroyed = false;
  private isAnalyzing = false;
  private isWaitingForBestmove = false; // Waiting for bestmove before we can send isready
  private isWaitingForReady = false;
  private pendingAnalysisData: AnalysisInfo = { ...INITIAL_ANALYSIS }; // Accumulates until stable
  private hasReachedStableDepth = false;
  private multiPvLines: Map<number, AnalysisLine> = new Map(); // Track MultiPV lines
  private onReady: (() => void) | null = null;
  private pendingAnalysis: { fen: string; maxDepth: number } | null = null;
  private pendingSetOption: { name: string; value: string | number } | null = null;
  private restoreAnalysisAfterOption: { fen: string; maxDepth: number } | null = null;
  private initPromise: Promise<void> | null = null;

  constructor(options: SfEvalOptions = {}) {
    this.workerPath = options.workerPath ?? '/engine/stockfish.js';
    this.multiPV = Math.max(1, options.multiPV ?? 3);
    this.stableDepthThreshold = Math.max(1, options.stableDepthThreshold ?? 12);
    this.debugEnabled = options.debug ?? false;
    this.onAnalysisUpdate = options.onAnalysisUpdate ?? null;
    this.onError = options.onError ?? null;
  }

  private log(...args: unknown[]): void {
    if (this.debugEnabled) console.log('[SfEval]', ...args);
  }

  /**
   * Initialize the Stockfish engine.
   * Returns a promise that resolves when the engine is ready.
   * Safe to call multiple times — returns the existing promise if init is in flight.
   */
  async init(): Promise<void> {
    if (typeof window === 'undefined') {
      throw new Error('SfEval can only run in browser');
    }

    // Already initialized and ready
    if (this.isReady && this.worker && !this.isDestroyed) {
      return;
    }

    // Init already in flight — return existing promise
    if (this.initPromise) {
      return this.initPromise;
    }

    // Reset destroyed flag on new init
    this.isDestroyed = false;

    this.initPromise = new Promise<void>((resolve, reject) => {
      try {
        // Create worker that loads Stockfish from configured path
        this.worker = new Worker(this.workerPath);

        this.worker.onmessage = (e) => {
          // Guard against messages after destruction
          if (this.isDestroyed) return;
          try {
            const line = typeof e.data === 'string' ? e.data : String(e.data);
            this.handleMessage(line);
          } catch (err) {
            this.log('MESSAGE HANDLER ERROR:', err);
            this.initPromise = null;
            this.markAsDestroyed('Message handler error');
          }
        };

        this.worker.onerror = (e) => {
          this.log('WORKER ERROR:', e.message, e.filename, e.lineno);
          const errorMsg = 'Worker error: ' + e.message;
          this.initPromise = null;
          this.markAsDestroyed(errorMsg);
          reject(new Error(errorMsg));
        };

        // Handle errors in message serialization
        this.worker.onmessageerror = (e) => {
          this.log('WORKER MESSAGE ERROR:', e);
          this.initPromise = null;
          this.markAsDestroyed('Message serialization error');
        };

        // Set up ready handler
        this.onReady = () => {
          this.log('init() complete - engine ready');
          this.isReady = true;
          resolve();
        };

        // Initialize UCI protocol
        this.send('uci');
      } catch (err) {
        this.initPromise = null;
        const errorMsg = err instanceof Error ? err.message : 'Failed to initialize engine';
        this.onError?.(errorMsg);
        reject(new Error(errorMsg));
      }
    });

    return this.initPromise;
  }

  /**
   * Send a UCI command to the engine.
   */
  private send(command: string): boolean {
    if (this.isDestroyed || !this.worker) {
      this.log('>>> SEND BLOCKED (destroyed):', command);
      return false;
    }
    this.log('>>> SEND:', command);
    try {
      this.worker.postMessage(command);
      return true;
    } catch (err) {
      this.log('SEND ERROR:', err);
      // Worker may have been terminated - mark as destroyed
      this.isDestroyed = true;
      return false;
    }
  }

  /**
   * Handle messages from the Stockfish worker.
   */
  private handleMessage(line: string): void {
    if (typeof line !== 'string') return;

    // Log key messages (not spammy info lines)
    if (!line.startsWith('info') || line.includes('depth 1 ')) {
      this.log('<<< RECV:', line.substring(0, 100));
    }

    // Handle UCI initialization
    if (line === 'uciok') {
      this.log('STATE: uciok received, enabling MultiPV and sending isready');
      this.send(`setoption name MultiPV value ${this.multiPV}`);
      this.send('isready');
      return;
    }

    if (line === 'readyok') {
      this.log('STATE: readyok received, isWaitingForReady:', this.isWaitingForReady,
        'pendingSetOption:', !!this.pendingSetOption, 'pendingAnalysis:', !!this.pendingAnalysis);
      this.isWaitingForReady = false;

      // If there's a pending setoption, send it now (engine is idle after readyok)
      // then re-synchronize with another isready before starting any analysis.
      if (this.pendingSetOption) {
        const { name, value } = this.pendingSetOption;
        this.pendingSetOption = null;
        this.send(`setoption name ${name} value ${value}`);
        // If we interrupted an analysis for this option and no new analyze() was queued,
        // restore the interrupted analysis so it restarts after synchronization.
        if (this.restoreAnalysisAfterOption && !this.pendingAnalysis) {
          this.pendingAnalysis = this.restoreAnalysisAfterOption;
        }
        this.restoreAnalysisAfterOption = null;
        this.isWaitingForReady = true;
        this.send('isready');
        return;
      }

      // If we have a pending analysis, start it now
      if (this.pendingAnalysis) {
        const { fen, maxDepth } = this.pendingAnalysis;
        this.pendingAnalysis = null;
        // Reset pending data but keep currentAnalysis displayed until we reach stable depth
        // Include the FEN so we know which position this analysis belongs to
        this.pendingAnalysisData = { ...INITIAL_ANALYSIS, fen };
        this.hasReachedStableDepth = false;
        this.multiPvLines.clear(); // Clear MultiPV state for new position
        this.log('STATE: Starting analysis for FEN:', fen.substring(0, 30));
        this.send(`position fen ${fen}`);
        this.isAnalyzing = true;
        this.send(`go depth ${maxDepth}`);
      }
      // Fire and clear the one-shot init callback
      const cb = this.onReady;
      this.onReady = null;
      cb?.();
      return;
    }

    // Handle error messages
    if (line.startsWith('error:')) {
      this.log('ERROR from engine:', line);
      this.onError?.(line);
      return;
    }

    // Parse info lines (analysis updates)
    if (line.startsWith('info')) {
      this.parseInfoLine(line);
      return;
    }

    // Parse bestmove
    if (line.startsWith('bestmove')) {
      // If we were waiting for bestmove before starting new analysis
      if (this.isWaitingForBestmove) {
        this.log('STATE: bestmove received, now sending isready');
        this.isWaitingForBestmove = false;
        this.isAnalyzing = false;
        this.isWaitingForReady = true;
        this.send('isready');
        return;
      }
      this.log('STATE: bestmove received, setting isAnalyzing=false');
      this.parseBestMove(line);
      return;
    }
  }

  /**
   * Parse a UCI info line and update analysis state.
   * Handles MultiPV lines (multipv 1, 2, 3).
   */
  private parseInfoLine(line: string): void {
    // Skip free-form diagnostic strings (e.g. "info string NNUE evaluation using ...")
    if (line.startsWith('info string')) return;

    // Ignore info lines if we're transitioning between searches
    // These would be stale data from the search we just stopped
    if (this.isWaitingForBestmove || this.isWaitingForReady) {
      return;
    }

    // Only parse evaluation lines (must have depth and score).
    // Progress lines like "info depth 20 currmove e2e4" have no score and must be skipped
    // to avoid overwriting valid evaluations in the MultiPV map.
    const depthMatch = line.match(/\bdepth\s+(\d+)/);
    if (!depthMatch) return;

    // Capture score and optionally detect aspiration window bounds in one pass
    const scoreMatch = line.match(/\bscore\s+(cp|mate)\s+(-?\d+)(?:\s+(lowerbound|upperbound))?/);
    if (!scoreMatch) return;

    // Skip aspiration window bound scores — these are intermediate, unreliable
    // evaluations that would cause eval flickering if treated as exact.
    if (scoreMatch[3]) return;

    const depth = parseInt(depthMatch[1], 10);

    // Parse multipv indicator (defaults to 1 for backward compatibility)
    const multipvMatch = line.match(/\bmultipv\s+(\d+)/);
    const multipv = multipvMatch ? parseInt(multipvMatch[1], 10) : 1;

    // Parse score (cp or mate)
    let score: number | null = null;
    let mate: number | null = null;
    const value = parseInt(scoreMatch[2], 10);
    if (scoreMatch[1] === 'cp') {
      score = value;
    } else {
      mate = value;
    }

    // Parse principal variation
    const pvMatch = line.match(/\bpv\s+(.+)/);
    const pv = pvMatch ? pvMatch[1].trim().split(/\s+/).slice(0, 10) : [];

    // Store this line in the MultiPV map
    this.multiPvLines.set(multipv, { depth, score, mate, pv, multipv });

    // Update main analysis from line 1 (best line)
    const mainLine = this.multiPvLines.get(1);
    if (mainLine) {
      this.pendingAnalysisData.depth = mainLine.depth;
      this.pendingAnalysisData.score = mainLine.score;
      this.pendingAnalysisData.mate = mainLine.mate;
      this.pendingAnalysisData.pv = mainLine.pv;

      // Check if we've reached stable depth
      if (!this.hasReachedStableDepth && mainLine.depth >= this.stableDepthThreshold) {
        this.hasReachedStableDepth = true;
        this.log('STATE: Reached stable depth', mainLine.depth);
      }

      // Only emit once all MultiPV lines are at the same depth to avoid
      // a mixed-depth lines array (e.g. line 1 at depth N, line 3 still at N-1)
      let allSameDepth = true;
      for (const l of this.multiPvLines.values()) {
        if (l.depth !== mainLine.depth) { allSameDepth = false; break; }
      }
      if (this.hasReachedStableDepth && this.multiPvLines.size >= this.multiPV && allSameDepth) {
        this.pendingAnalysisData.lines = Array.from(this.multiPvLines.values()).sort((a, b) => a.multipv - b.multipv);
        this.onAnalysisUpdate?.({ ...this.pendingAnalysisData });
      }
    }
  }

  /**
   * Parse the bestmove line.
   */
  private parseBestMove(line: string): void {
    const match = line.match(/^bestmove\s+(\S+)/);
    if (match) {
      const move = match[1];
      // Stockfish emits "bestmove (none)" for checkmate/stalemate or spurious stop
      if (move === '(none)' || move === 'null' || move === '0000') {
        this.isAnalyzing = false;
        return;
      }
      this.pendingAnalysisData.bestMove = move;
      // Only emit if stable depth was reached (honor stableDepthThreshold)
      if (this.hasReachedStableDepth) {
        this.onAnalysisUpdate?.({ ...this.pendingAnalysisData });
      }
    }
    this.isAnalyzing = false;
  }

  /**
   * Start analyzing a position.
   * Uses proper UCI sequencing: stop -> isready -> readyok -> position -> go.
   * Safe to call while already analyzing — the new position is queued.
   */
  analyze(fen: string, maxDepth: number = 25): void {
    const clampedDepth = Math.max(1, Math.min(100, maxDepth));

    this.log('analyze() called, isReady:', this.isReady, 'isAnalyzing:', this.isAnalyzing, 'isWaitingForReady:', this.isWaitingForReady, 'isWaitingForBestmove:', this.isWaitingForBestmove);

    if (!this.isReady || !this.worker || this.isDestroyed) {
      this.log('analyze() early return - not ready or destroyed');
      return;
    }

    // Store pending analysis
    this.pendingAnalysis = { fen, maxDepth: clampedDepth };

    // If already in the middle of transitioning, just update pending
    if (this.isWaitingForReady || this.isWaitingForBestmove) {
      this.log('analyze() - already transitioning, just updated pendingAnalysis');
      return;
    }

    // If currently analyzing, stop and wait for bestmove before isready
    if (this.isAnalyzing) {
      this.log('analyze() - stopping current analysis, waiting for bestmove');
      this.isWaitingForBestmove = true;
      this.send('stop');
      return;
    }

    // Not analyzing, can go straight to isready
    this.isWaitingForReady = true;
    this.log('analyze() - sending isready');
    this.send('isready');
  }

  /**
   * Stop the current analysis.
   */
  stop(): void {
    this.log('stop() called');
    this.pendingAnalysis = null;
    this.pendingSetOption = null;
    this.restoreAnalysisAfterOption = null;
    this.multiPvLines.clear();
    if (!this.isDestroyed && (this.isAnalyzing || this.isWaitingForBestmove)) {
      // A search is in flight — send stop and drain the expected bestmove silently
      this.isWaitingForBestmove = true;
      this.send('stop');
    } else {
      this.isWaitingForBestmove = false;
    }
    this.isAnalyzing = false;
    this.isWaitingForReady = false;
  }

  /**
   * Null out worker event handlers, terminate, and release the reference.
   */
  private terminateWorker(): void {
    if (!this.worker) return;
    this.worker.onmessage = null;
    this.worker.onerror = null;
    this.worker.onmessageerror = null;
    try { this.worker.terminate(); } catch { /* already terminated */ }
    this.worker = null;
  }

  /**
   * Mark the worker as destroyed and notify error handlers.
   * Called when the worker crashes or enters an invalid state.
   */
  private markAsDestroyed(reason: string): void {
    if (this.isDestroyed) return;
    this.log('Marking worker as destroyed:', reason);
    this.isDestroyed = true;
    this.isReady = false;
    this.initPromise = null;
    this.onError?.(reason);
    this.terminateWorker();
  }

  /**
   * Set a UCI engine option at runtime.
   * The engine must be initialized before calling this method.
   * Per UCI spec, setoption must only be sent when the engine is idle.
   * If the engine is searching, it will be stopped first and analysis restarted after.
   * Common options: Threads, Hash, MultiPV, Skill Level.
   */
  setOption(name: string, value: string | number): void {
    if (!this.isReady || this.isDestroyed) {
      this.log('setOption() ignored - engine not ready');
      return;
    }

    // Keep internal state in sync for MultiPV
    if (name === 'MultiPV') {
      const numValue = typeof value === 'number' ? value : parseInt(String(value), 10);
      if (!isNaN(numValue) && numValue >= 1) {
        this.multiPV = numValue;
      }
    }

    // Engine is idle — send immediately with isready synchronization
    if (!this.isAnalyzing && !this.isWaitingForBestmove && !this.isWaitingForReady) {
      this.send(`setoption name ${name} value ${value}`);
      this.isWaitingForReady = true;
      this.send('isready');
      return;
    }

    // Engine is busy — queue the option for when it becomes idle
    this.pendingSetOption = { name, value };

    // If actively analyzing (not already transitioning), stop the search.
    // Save the current analysis so it can restart after the option is applied.
    if (this.isAnalyzing && !this.isWaitingForBestmove) {
      if (!this.pendingAnalysis && this.pendingAnalysisData.fen) {
        this.restoreAnalysisAfterOption = {
          fen: this.pendingAnalysisData.fen,
          maxDepth: 25,
        };
      }
      this.isWaitingForBestmove = true;
      this.send('stop');
    }
  }

  /**
   * Update event callbacks. Useful when callback closures change
   * (e.g., on React re-render).
   */
  updateCallbacks(callbacks: SfEvalCallbacks): void {
    if (callbacks.onAnalysisUpdate !== undefined) {
      this.onAnalysisUpdate = callbacks.onAnalysisUpdate;
    }
    if (callbacks.onError !== undefined) {
      this.onError = callbacks.onError;
    }
  }

  /**
   * Check if the engine is initialized and ready.
   */
  getIsReady(): boolean {
    return this.isReady && !this.isDestroyed;
  }

  /**
   * Check if the worker has been destroyed.
   */
  getIsDestroyed(): boolean {
    return this.isDestroyed;
  }

  /**
   * Terminate the worker and clean up all resources.
   * Safe to call multiple times. After calling destroy(),
   * a new init() can be used to restart the engine.
   */
  destroy(): void {
    // Mark as destroyed first to prevent any further sends
    this.isDestroyed = true;
    this.terminateWorker();
    this.isReady = false;
    this.isAnalyzing = false;
    this.isWaitingForBestmove = false;
    this.isWaitingForReady = false;
    this.hasReachedStableDepth = false;
    this.pendingAnalysis = null;
    this.pendingSetOption = null;
    this.restoreAnalysisAfterOption = null;
    this.pendingAnalysisData = { ...INITIAL_ANALYSIS };
    this.multiPvLines.clear();
    this.onAnalysisUpdate = null;
    this.onReady = null;
    this.onError = null;
    this.initPromise = null;
  }
}
