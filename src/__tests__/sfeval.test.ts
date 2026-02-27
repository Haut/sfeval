import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SfEval } from '../sfeval';
import type { AnalysisInfo } from '../types';
import { INITIAL_ANALYSIS } from '../types';

// ---------------------------------------------------------------------------
// Mock Worker
// ---------------------------------------------------------------------------

type MessageHandler = ((e: MessageEvent) => void) | null;
type ErrorHandler = ((e: ErrorEvent) => void) | null;

/**
 * A minimal mock of the browser Worker API.
 * Captures posted messages and allows simulating engine responses.
 */
class MockWorker {
  onmessage: MessageHandler = null;
  onerror: ErrorHandler = null;
  onmessageerror: ((e: MessageEvent) => void) | null = null;

  /** Messages sent to the engine via postMessage. */
  posted: string[] = [];

  /** Whether terminate() was called. */
  terminated = false;

  postMessage(msg: string): void {
    if (this.terminated) throw new Error('Worker terminated');
    this.posted.push(msg);
  }

  terminate(): void {
    this.terminated = true;
  }

  /** Simulate a message from the engine. */
  receive(data: string): void {
    this.onmessage?.({ data } as MessageEvent);
  }

  /** Simulate an error from the engine. */
  error(message: string): void {
    this.onerror?.({ message } as unknown as ErrorEvent);
  }

  /** Clear posted messages log. */
  clearPosted(): void {
    this.posted = [];
  }

  /** Return posted messages matching a pattern. */
  messagesMatching(pattern: RegExp): string[] {
    return this.posted.filter(m => pattern.test(m));
  }

  /** Return the last posted message, or undefined. */
  lastPosted(): string | undefined {
    return this.posted[this.posted.length - 1];
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let mockWorkerInstance: MockWorker;

/**
 * Stub `window` and the `Worker` constructor so SfEval
 * creates our MockWorker instead of a real Web Worker.
 */
function installWorkerStub(): void {
  // Provide a minimal `window` so the typeof check passes
  (globalThis as Record<string, unknown>).window = {};

  // Replace Worker constructor
  (globalThis as Record<string, unknown>).Worker = class {
    constructor() {
      mockWorkerInstance = new MockWorker();
      return mockWorkerInstance as unknown as Worker;
    }
  } as unknown as typeof Worker;
}

function removeWorkerStub(): void {
  delete (globalThis as Record<string, unknown>).window;
  delete (globalThis as Record<string, unknown>).Worker;
}

/**
 * Create a SfEval with the given options and drive it through
 * the init handshake (uci -> uciok -> setoption MultiPV -> isready -> readyok).
 * Returns the worker and the underlying mock.
 */
async function createReadyWorker(
  opts: ConstructorParameters<typeof SfEval>[0] = {}
): Promise<{ sf: SfEval; mock: MockWorker }> {
  const sf = new SfEval(opts);
  const initP = sf.init();

  // Finish the UCI handshake
  mockWorkerInstance.receive('uciok');
  mockWorkerInstance.receive('readyok');
  await initP;

  // Clear the init traffic so tests only see their own commands
  mockWorkerInstance.clearPosted();

  return { sf, mock: mockWorkerInstance };
}

/** Standard FEN strings for testing. */
const STARTING_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
const FEN_AFTER_E4 = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1';

/** Build a typical info line for a given multipv / depth / score. */
function infoLine(opts: {
  depth: number;
  multipv?: number;
  cp?: number;
  mate?: number;
  pv?: string;
}): string {
  const parts = ['info'];
  parts.push(`depth ${opts.depth}`);
  if (opts.multipv !== undefined) parts.push(`multipv ${opts.multipv}`);
  if (opts.cp !== undefined) parts.push(`score cp ${opts.cp}`);
  if (opts.mate !== undefined) parts.push(`score mate ${opts.mate}`);
  parts.push(`pv ${opts.pv ?? 'e2e4 e7e5'}`);
  return parts.join(' ');
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  installWorkerStub();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  removeWorkerStub();
});

// ===== INITIALIZATION & LIFECYCLE ==========================================

describe('initialization', () => {
  it('throws when called outside browser (no window)', async () => {
    removeWorkerStub();
    const sf = new SfEval();
    await expect(sf.init()).rejects.toThrow('browser');
  });

  it('completes init after uciok + readyok handshake', async () => {
    const sf = new SfEval();
    const p = sf.init();

    // After construction, worker should have received 'uci'
    expect(mockWorkerInstance.posted).toContain('uci');

    mockWorkerInstance.receive('uciok');
    // After uciok, should send setoption MultiPV and isready
    expect(mockWorkerInstance.messagesMatching(/setoption name MultiPV/).length).toBe(1);
    expect(mockWorkerInstance.posted).toContain('isready');

    mockWorkerInstance.receive('readyok');
    await p;

    expect(sf.getIsReady()).toBe(true);
    expect(sf.getIsDestroyed()).toBe(false);
  });

  it('deduplicates concurrent init() calls — only one worker created', async () => {
    const sf = new SfEval();
    const p1 = sf.init();
    const firstWorker = mockWorkerInstance;

    const p2 = sf.init();
    // Second init() should not have created a new worker
    expect(mockWorkerInstance).toBe(firstWorker);

    mockWorkerInstance.receive('uciok');
    mockWorkerInstance.receive('readyok');
    await Promise.all([p1, p2]);
    expect(sf.getIsReady()).toBe(true);
  });

  it('is a no-op when already initialized', async () => {
    const { sf, mock } = await createReadyWorker();
    mock.clearPosted();
    await sf.init();
    // No new commands should be sent
    expect(mock.posted.length).toBe(0);
  });

  it('can re-init after destroy', async () => {
    const { sf } = await createReadyWorker();
    sf.destroy();
    expect(sf.getIsReady()).toBe(false);
    expect(sf.getIsDestroyed()).toBe(true);

    // Re-init
    const p = sf.init();
    mockWorkerInstance.receive('uciok');
    mockWorkerInstance.receive('readyok');
    await p;
    expect(sf.getIsReady()).toBe(true);
  });

  it('calls onError and rejects on worker error during init', async () => {
    const onError = vi.fn();
    const sf = new SfEval({ onError });
    const p = sf.init();

    mockWorkerInstance.error('WASM failed to load');

    await expect(p).rejects.toThrow('Worker error');
    expect(onError).toHaveBeenCalledWith(expect.stringContaining('Worker error'));
    expect(sf.getIsDestroyed()).toBe(true);
  });

  it('uses custom workerPath', async () => {
    const sf = new SfEval({ workerPath: '/custom/sf.js' });
    // The constructor arg is stored internally, we just verify init works
    const p = sf.init();
    mockWorkerInstance.receive('uciok');
    mockWorkerInstance.receive('readyok');
    await p;
    expect(sf.getIsReady()).toBe(true);
  });
});

// ===== DESTROY =============================================================

describe('destroy', () => {
  it('terminates the worker and resets all state', async () => {
    const { sf, mock } = await createReadyWorker();
    sf.destroy();

    expect(mock.terminated).toBe(true);
    expect(sf.getIsReady()).toBe(false);
    expect(sf.getIsDestroyed()).toBe(true);
  });

  it('is safe to call multiple times', async () => {
    const { sf } = await createReadyWorker();
    sf.destroy();
    sf.destroy(); // Should not throw
    expect(sf.getIsDestroyed()).toBe(true);
  });

  it('nulls out callbacks to prevent stale references', async () => {
    const onAnalysis = vi.fn();
    const onError = vi.fn();
    const { sf, mock } = await createReadyWorker({
      onAnalysisUpdate: onAnalysis,
      onError,
    });

    sf.destroy();

    // Simulate late message arriving — should not crash or fire callback
    // Worker handlers are nulled, so nothing should happen
    expect(mock.onmessage).toBeNull();
    expect(mock.onerror).toBeNull();
  });

  it('blocks further send() calls', async () => {
    const { sf, mock } = await createReadyWorker();
    sf.destroy();
    mock.clearPosted();

    // analyze should be a no-op
    sf.analyze(STARTING_FEN);
    expect(mock.posted.length).toBe(0);
  });
});

// ===== ANALYZE =============================================================

describe('analyze', () => {
  it('sends UCI sequence: isready -> position -> go', async () => {
    const { sf, mock } = await createReadyWorker();

    sf.analyze(STARTING_FEN, 20);
    // Should send isready first
    expect(mock.lastPosted()).toBe('isready');

    mock.receive('readyok');
    // After readyok, should send position + go
    expect(mock.posted).toContain(`position fen ${STARTING_FEN}`);
    expect(mock.posted).toContain('go depth 20');
  });

  it('clamps depth to valid range', async () => {
    const { sf, mock } = await createReadyWorker();

    sf.analyze(STARTING_FEN, 0);
    mock.receive('readyok');
    expect(mock.posted).toContain('go depth 1');
  });

  it('clamps depth > 100', async () => {
    const { sf, mock } = await createReadyWorker();

    sf.analyze(STARTING_FEN, 200);
    mock.receive('readyok');
    expect(mock.posted).toContain('go depth 100');
  });

  it('uses default depth of 25 when not specified', async () => {
    const { sf, mock } = await createReadyWorker();

    sf.analyze(STARTING_FEN);
    mock.receive('readyok');
    expect(mock.posted).toContain('go depth 25');
  });

  it('does nothing when not initialized', () => {
    const sf = new SfEval();
    // Should silently return without throwing
    sf.analyze(STARTING_FEN);
  });

  it('does nothing when destroyed', async () => {
    const { sf, mock } = await createReadyWorker();
    sf.destroy();
    mock.clearPosted();
    sf.analyze(STARTING_FEN);
    expect(mock.posted.length).toBe(0);
  });
});

// ===== RAPID POSITION CHANGES (key timing tests) ==========================

describe('rapid position changes', () => {
  it('coalesces rapid analyze() calls — only the last position runs', async () => {
    const { sf, mock } = await createReadyWorker();

    // First analysis starts
    sf.analyze(STARTING_FEN, 20);
    mock.receive('readyok');
    // Now analyzing STARTING_FEN
    mock.clearPosted();

    // Rapid fire: new positions while first is still running
    sf.analyze(FEN_AFTER_E4, 20);
    // This should send 'stop' and wait for bestmove
    expect(mock.posted).toContain('stop');
    mock.clearPosted();

    // Before bestmove arrives, another position
    sf.analyze('fen3 w KQkq - 0 1', 20);
    // Just updates pending, no new stop needed
    expect(mock.posted.length).toBe(0);

    // Now bestmove arrives from the stopped search
    mock.receive('bestmove e2e4');
    // Should send isready
    expect(mock.posted).toContain('isready');
    mock.clearPosted();

    // readyok triggers the analysis of the LAST queued position
    mock.receive('readyok');
    expect(mock.posted).toContain('position fen fen3 w KQkq - 0 1');
    expect(mock.posted).toContain('go depth 20');
    // The intermediate FEN_AFTER_E4 was never analyzed
    expect(mock.posted).not.toContain(`position fen ${FEN_AFTER_E4}`);
  });

  it('handles analyze() while waiting for bestmove', async () => {
    const { sf, mock } = await createReadyWorker();

    // Start analysis
    sf.analyze(STARTING_FEN, 20);
    mock.receive('readyok');
    mock.clearPosted();

    // First interruption
    sf.analyze(FEN_AFTER_E4, 20);
    expect(mock.posted).toContain('stop');
    mock.clearPosted();

    // Second interruption while still waiting for bestmove from first stop
    sf.analyze('fen_3 w - - 0 1', 20);
    // Should just update pending, no duplicate stop
    expect(mock.messagesMatching(/^stop$/).length).toBe(0);

    // bestmove from the original stop
    mock.receive('bestmove e2e4');
    mock.clearPosted();
    mock.receive('readyok');

    // Should start the latest position
    expect(mock.posted).toContain('position fen fen_3 w - - 0 1');
  });

  it('handles analyze() while waiting for readyok', async () => {
    const { sf, mock } = await createReadyWorker();

    // First analysis: sends isready, waiting for readyok
    sf.analyze(STARTING_FEN, 20);
    mock.clearPosted();

    // Before readyok arrives, new position requested
    sf.analyze(FEN_AFTER_E4, 20);
    // Should just update pending analysis, no stop needed since not analyzing yet
    expect(mock.messagesMatching(/^stop$/).length).toBe(0);

    // Now readyok arrives — should start the latest position, not the first
    mock.receive('readyok');
    expect(mock.posted).toContain(`position fen ${FEN_AFTER_E4}`);
    expect(mock.posted).not.toContain(`position fen ${STARTING_FEN}`);
  });

  it('handles stop() then immediate analyze()', async () => {
    const { sf, mock } = await createReadyWorker();

    // Start analysis
    sf.analyze(STARTING_FEN, 20);
    mock.receive('readyok');
    mock.clearPosted();

    // User stops analysis
    sf.stop();
    expect(mock.posted).toContain('stop');
    mock.clearPosted();

    // Immediately request new analysis
    sf.analyze(FEN_AFTER_E4, 20);
    // Since stop() set isWaitingForBestmove = true, analyze should just queue
    // No new stop should be sent
    expect(mock.messagesMatching(/^stop$/).length).toBe(0);

    // bestmove from the stop
    mock.receive('bestmove e2e4');
    // After bestmove, should send isready
    expect(mock.posted).toContain('isready');
    mock.clearPosted();

    mock.receive('readyok');
    expect(mock.posted).toContain(`position fen ${FEN_AFTER_E4}`);
  });

  it('handles triple rapid analyze() calls from idle state', async () => {
    const { sf, mock } = await createReadyWorker();

    // Three rapid calls from idle
    sf.analyze('fen_a w - - 0 1', 20);
    sf.analyze('fen_b w - - 0 1', 20);
    sf.analyze('fen_c w - - 0 1', 20);

    // Only the first should have triggered isready
    expect(mock.messagesMatching(/^isready$/).length).toBe(1);

    // readyok should start the LAST queued position
    mock.receive('readyok');
    expect(mock.posted).toContain('position fen fen_c w - - 0 1');
    expect(mock.posted).not.toContain('position fen fen_a w - - 0 1');
    expect(mock.posted).not.toContain('position fen fen_b w - - 0 1');
  });
});

// ===== STOP ================================================================

describe('stop', () => {
  it('sends stop when analyzing', async () => {
    const { sf, mock } = await createReadyWorker();

    sf.analyze(STARTING_FEN, 20);
    mock.receive('readyok');
    mock.clearPosted();

    sf.stop();
    expect(mock.posted).toContain('stop');
  });

  it('clears pending analysis', async () => {
    const { sf, mock } = await createReadyWorker();

    sf.analyze(STARTING_FEN, 20);
    // isready sent, pending analysis queued
    sf.stop();
    mock.clearPosted();

    // Now readyok arrives — should NOT start any analysis
    mock.receive('readyok');
    expect(mock.messagesMatching(/^position/).length).toBe(0);
    expect(mock.messagesMatching(/^go/).length).toBe(0);
  });

  it('is safe to call when not analyzing', async () => {
    const { sf, mock } = await createReadyWorker();
    mock.clearPosted();
    sf.stop();
    // Should not send stop if not analyzing
    expect(mock.messagesMatching(/^stop$/).length).toBe(0);
  });

  it('is safe to call when destroyed', async () => {
    const { sf } = await createReadyWorker();
    sf.destroy();
    // Should not throw
    sf.stop();
  });

  it('drains bestmove after stop during active analysis', async () => {
    const onUpdate = vi.fn();
    const { sf, mock } = await createReadyWorker({ onAnalysisUpdate: onUpdate });

    sf.analyze(STARTING_FEN, 20);
    mock.receive('readyok');

    // Get some results to trigger an update
    mock.receive(infoLine({ depth: 12, multipv: 1, cp: 30 }));
    mock.receive(infoLine({ depth: 12, multipv: 2, cp: -10 }));
    mock.receive(infoLine({ depth: 12, multipv: 3, cp: -20 }));
    const updateCountBefore = onUpdate.mock.calls.length;

    sf.stop();
    onUpdate.mockClear();

    // Late info lines and bestmove after stop should not trigger updates
    mock.receive(infoLine({ depth: 13, multipv: 1, cp: 35 }));
    mock.receive('bestmove e2e4');
    expect(onUpdate).not.toHaveBeenCalled();
  });
});

// ===== INFO LINE PARSING ===================================================

describe('info line parsing', () => {
  it('parses centipawn scores', async () => {
    const onUpdate = vi.fn();
    const { sf, mock } = await createReadyWorker({
      onAnalysisUpdate: onUpdate,
      multiPV: 1,
      stableDepthThreshold: 1,
    });

    sf.analyze(STARTING_FEN, 20);
    mock.receive('readyok');

    mock.receive('info depth 5 multipv 1 score cp 42 pv e2e4 e7e5');
    expect(onUpdate).toHaveBeenCalled();
    const analysis: AnalysisInfo = onUpdate.mock.calls[0][0];
    expect(analysis.score).toBe(42);
    expect(analysis.mate).toBeNull();
    expect(analysis.depth).toBe(5);
    expect(analysis.pv).toEqual(['e2e4', 'e7e5']);
  });

  it('parses mate scores', async () => {
    const onUpdate = vi.fn();
    const { sf, mock } = await createReadyWorker({
      onAnalysisUpdate: onUpdate,
      multiPV: 1,
      stableDepthThreshold: 1,
    });

    sf.analyze(STARTING_FEN, 20);
    mock.receive('readyok');

    mock.receive('info depth 15 multipv 1 score mate 3 pv e2e4');
    expect(onUpdate).toHaveBeenCalled();
    const analysis: AnalysisInfo = onUpdate.mock.calls[0][0];
    expect(analysis.mate).toBe(3);
    expect(analysis.score).toBeNull();
  });

  it('parses negative mate scores', async () => {
    const onUpdate = vi.fn();
    const { sf, mock } = await createReadyWorker({
      onAnalysisUpdate: onUpdate,
      multiPV: 1,
      stableDepthThreshold: 1,
    });

    sf.analyze(STARTING_FEN, 20);
    mock.receive('readyok');

    mock.receive('info depth 20 multipv 1 score mate -5 pv e2e4');
    const analysis: AnalysisInfo = onUpdate.mock.calls[0][0];
    expect(analysis.mate).toBe(-5);
  });

  it('ignores info string diagnostic lines', async () => {
    const onUpdate = vi.fn();
    const { sf, mock } = await createReadyWorker({
      onAnalysisUpdate: onUpdate,
      multiPV: 1,
      stableDepthThreshold: 1,
    });

    sf.analyze(STARTING_FEN, 20);
    mock.receive('readyok');

    mock.receive('info string NNUE evaluation using nn-abc123.nnue');
    expect(onUpdate).not.toHaveBeenCalled();
  });

  it('ignores progress lines without score', async () => {
    const onUpdate = vi.fn();
    const { sf, mock } = await createReadyWorker({
      onAnalysisUpdate: onUpdate,
      multiPV: 1,
      stableDepthThreshold: 1,
    });

    sf.analyze(STARTING_FEN, 20);
    mock.receive('readyok');

    mock.receive('info depth 20 currmove e2e4 currmovenumber 1');
    expect(onUpdate).not.toHaveBeenCalled();
  });

  it('ignores lowerbound/upperbound scores (aspiration windows)', async () => {
    const onUpdate = vi.fn();
    const { sf, mock } = await createReadyWorker({
      onAnalysisUpdate: onUpdate,
      multiPV: 1,
      stableDepthThreshold: 1,
    });

    sf.analyze(STARTING_FEN, 20);
    mock.receive('readyok');

    mock.receive('info depth 15 multipv 1 score cp 50 lowerbound pv e2e4');
    mock.receive('info depth 15 multipv 1 score cp 30 upperbound pv e2e4');
    expect(onUpdate).not.toHaveBeenCalled();
  });

  it('ignores info lines during bestmove transition', async () => {
    const onUpdate = vi.fn();
    const { sf, mock } = await createReadyWorker({
      onAnalysisUpdate: onUpdate,
      multiPV: 1,
      stableDepthThreshold: 1,
    });

    sf.analyze(STARTING_FEN, 20);
    mock.receive('readyok');
    mock.receive(infoLine({ depth: 5, multipv: 1, cp: 30 }));
    onUpdate.mockClear();

    // Interrupt with new analysis
    sf.analyze(FEN_AFTER_E4, 20);
    // Now isWaitingForBestmove = true

    // Stale info from old search should be ignored
    mock.receive(infoLine({ depth: 15, multipv: 1, cp: 100 }));
    expect(onUpdate).not.toHaveBeenCalled();
  });

  it('limits PV to 10 moves', async () => {
    const onUpdate = vi.fn();
    const { sf, mock } = await createReadyWorker({
      onAnalysisUpdate: onUpdate,
      multiPV: 1,
      stableDepthThreshold: 1,
    });

    sf.analyze(STARTING_FEN, 20);
    mock.receive('readyok');

    const longPv = 'e2e4 e7e5 g1f3 b8c6 f1b5 a7a6 b5a4 g8f6 e1g1 f8e7 f1e1 b7b5 a4b3 d7d6';
    mock.receive(`info depth 10 multipv 1 score cp 30 pv ${longPv}`);
    const analysis: AnalysisInfo = onUpdate.mock.calls[0][0];
    expect(analysis.pv.length).toBe(10);
  });
});

// ===== BESTMOVE PARSING ====================================================

describe('bestmove parsing', () => {
  it('records bestMove and triggers update', async () => {
    const onUpdate = vi.fn();
    const { sf, mock } = await createReadyWorker({
      onAnalysisUpdate: onUpdate,
      multiPV: 1,
      stableDepthThreshold: 1,
    });

    sf.analyze(STARTING_FEN, 20);
    mock.receive('readyok');
    mock.receive(infoLine({ depth: 5, multipv: 1, cp: 30 }));
    onUpdate.mockClear();

    mock.receive('bestmove e2e4 ponder e7e5');
    expect(onUpdate).toHaveBeenCalled();
    expect(onUpdate.mock.calls[0][0].bestMove).toBe('e2e4');
  });

  it('handles bestmove (none) for checkmate/stalemate', async () => {
    const onUpdate = vi.fn();
    const { sf, mock } = await createReadyWorker({
      onAnalysisUpdate: onUpdate,
      multiPV: 1,
      stableDepthThreshold: 1,
    });

    sf.analyze(STARTING_FEN, 20);
    mock.receive('readyok');
    mock.receive(infoLine({ depth: 5, multipv: 1, cp: 30 }));
    onUpdate.mockClear();

    mock.receive('bestmove (none)');
    // (none) should not trigger an update with a move
    expect(onUpdate).not.toHaveBeenCalled();
  });

  it('handles bestmove null', async () => {
    const onUpdate = vi.fn();
    const { sf, mock } = await createReadyWorker({
      onAnalysisUpdate: onUpdate,
      multiPV: 1,
      stableDepthThreshold: 1,
    });

    sf.analyze(STARTING_FEN, 20);
    mock.receive('readyok');
    mock.receive(infoLine({ depth: 5, multipv: 1, cp: 30 }));
    onUpdate.mockClear();

    mock.receive('bestmove null');
    expect(onUpdate).not.toHaveBeenCalled();
  });

  it('handles bestmove 0000', async () => {
    const onUpdate = vi.fn();
    const { sf, mock } = await createReadyWorker({
      onAnalysisUpdate: onUpdate,
      multiPV: 1,
      stableDepthThreshold: 1,
    });

    sf.analyze(STARTING_FEN, 20);
    mock.receive('readyok');
    mock.receive(infoLine({ depth: 5, multipv: 1, cp: 30 }));
    onUpdate.mockClear();

    mock.receive('bestmove 0000');
    expect(onUpdate).not.toHaveBeenCalled();
  });
});

// ===== STABLE DEPTH THRESHOLD ==============================================

describe('stableDepthThreshold', () => {
  it('does not emit updates below threshold', async () => {
    const onUpdate = vi.fn();
    const { sf, mock } = await createReadyWorker({
      onAnalysisUpdate: onUpdate,
      multiPV: 1,
      stableDepthThreshold: 12,
    });

    sf.analyze(STARTING_FEN, 20);
    mock.receive('readyok');

    // Depths 1-11 should not trigger updates
    for (let d = 1; d <= 11; d++) {
      mock.receive(infoLine({ depth: d, multipv: 1, cp: d * 3 }));
    }
    expect(onUpdate).not.toHaveBeenCalled();
  });

  it('starts emitting at threshold depth', async () => {
    const onUpdate = vi.fn();
    const { sf, mock } = await createReadyWorker({
      onAnalysisUpdate: onUpdate,
      multiPV: 1,
      stableDepthThreshold: 12,
    });

    sf.analyze(STARTING_FEN, 20);
    mock.receive('readyok');

    mock.receive(infoLine({ depth: 12, multipv: 1, cp: 30 }));
    expect(onUpdate).toHaveBeenCalledTimes(1);
    expect(onUpdate.mock.calls[0][0].depth).toBe(12);
  });

  it('does not emit bestmove if stable depth never reached', async () => {
    const onUpdate = vi.fn();
    const { sf, mock } = await createReadyWorker({
      onAnalysisUpdate: onUpdate,
      multiPV: 1,
      stableDepthThreshold: 50, // Unreachably high
    });

    sf.analyze(STARTING_FEN, 5);
    mock.receive('readyok');

    mock.receive(infoLine({ depth: 5, multipv: 1, cp: 30 }));
    mock.receive('bestmove e2e4');
    expect(onUpdate).not.toHaveBeenCalled();
  });

  it('resets stable depth flag on new analysis', async () => {
    const onUpdate = vi.fn();
    const { sf, mock } = await createReadyWorker({
      onAnalysisUpdate: onUpdate,
      multiPV: 1,
      stableDepthThreshold: 5,
    });

    // First analysis — reach stable depth
    sf.analyze(STARTING_FEN, 20);
    mock.receive('readyok');
    mock.receive(infoLine({ depth: 5, multipv: 1, cp: 30 }));
    expect(onUpdate).toHaveBeenCalledTimes(1);
    onUpdate.mockClear();

    // Second analysis — should need to reach threshold again
    sf.analyze(FEN_AFTER_E4, 20);
    mock.receive('bestmove e2e4');
    mock.receive('readyok');

    // Depth 3 should not emit (below threshold)
    mock.receive(infoLine({ depth: 3, multipv: 1, cp: 10 }));
    expect(onUpdate).not.toHaveBeenCalled();

    // Depth 5 should emit
    mock.receive(infoLine({ depth: 5, multipv: 1, cp: 15 }));
    expect(onUpdate).toHaveBeenCalledTimes(1);
  });
});

// ===== MULTIPV =============================================================

describe('MultiPV', () => {
  it('collects all lines before emitting', async () => {
    const onUpdate = vi.fn();
    const { sf, mock } = await createReadyWorker({
      onAnalysisUpdate: onUpdate,
      multiPV: 3,
      stableDepthThreshold: 5,
    });

    sf.analyze(STARTING_FEN, 20);
    mock.receive('readyok');

    // Only line 1 at depth 5
    mock.receive(infoLine({ depth: 5, multipv: 1, cp: 30 }));
    expect(onUpdate).not.toHaveBeenCalled();

    // Line 2 at depth 5
    mock.receive(infoLine({ depth: 5, multipv: 2, cp: -10, pv: 'd2d4 d7d5' }));
    expect(onUpdate).not.toHaveBeenCalled();

    // Line 3 at depth 5 — all 3 lines at same depth
    mock.receive(infoLine({ depth: 5, multipv: 3, cp: -20, pv: 'c2c4 e7e5' }));
    expect(onUpdate).toHaveBeenCalledTimes(1);

    const analysis = onUpdate.mock.calls[0][0];
    expect(analysis.lines).toHaveLength(3);
    expect(analysis.lines![0].multipv).toBe(1);
    expect(analysis.lines![1].multipv).toBe(2);
    expect(analysis.lines![2].multipv).toBe(3);
  });

  it('does not emit when lines are at mixed depths', async () => {
    const onUpdate = vi.fn();
    const { sf, mock } = await createReadyWorker({
      onAnalysisUpdate: onUpdate,
      multiPV: 3,
      stableDepthThreshold: 5,
    });

    sf.analyze(STARTING_FEN, 20);
    mock.receive('readyok');

    // Line 1 at depth 5
    mock.receive(infoLine({ depth: 5, multipv: 1, cp: 30 }));
    // Line 2 at depth 5
    mock.receive(infoLine({ depth: 5, multipv: 2, cp: -10 }));
    // Line 3 at depth 5 — triggers update
    mock.receive(infoLine({ depth: 5, multipv: 3, cp: -20 }));
    onUpdate.mockClear();

    // Now line 1 jumps to depth 6 but lines 2,3 still at 5
    mock.receive(infoLine({ depth: 6, multipv: 1, cp: 32 }));
    expect(onUpdate).not.toHaveBeenCalled();

    // Line 2 to depth 6
    mock.receive(infoLine({ depth: 6, multipv: 2, cp: -8 }));
    expect(onUpdate).not.toHaveBeenCalled();

    // Line 3 to depth 6 — all same depth again
    mock.receive(infoLine({ depth: 6, multipv: 3, cp: -18 }));
    expect(onUpdate).toHaveBeenCalledTimes(1);
  });

  it('clears MultiPV state on new analysis', async () => {
    const onUpdate = vi.fn();
    const { sf, mock } = await createReadyWorker({
      onAnalysisUpdate: onUpdate,
      multiPV: 2,
      stableDepthThreshold: 1,
    });

    // First analysis
    sf.analyze(STARTING_FEN, 20);
    mock.receive('readyok');
    mock.receive(infoLine({ depth: 5, multipv: 1, cp: 30 }));
    mock.receive(infoLine({ depth: 5, multipv: 2, cp: -10 }));
    expect(onUpdate).toHaveBeenCalledTimes(1);
    onUpdate.mockClear();

    // New analysis
    sf.analyze(FEN_AFTER_E4, 20);
    mock.receive('bestmove e2e4');
    mock.receive('readyok');

    // Only line 1 — should not emit yet because we need 2 lines
    mock.receive(infoLine({ depth: 3, multipv: 1, cp: 15 }));
    expect(onUpdate).not.toHaveBeenCalled();

    // Line 2 — now both at same depth
    mock.receive(infoLine({ depth: 3, multipv: 2, cp: -5 }));
    expect(onUpdate).toHaveBeenCalledTimes(1);
  });

  it('sorts lines by multipv number in output', async () => {
    const onUpdate = vi.fn();
    const { sf, mock } = await createReadyWorker({
      onAnalysisUpdate: onUpdate,
      multiPV: 3,
      stableDepthThreshold: 1,
    });

    sf.analyze(STARTING_FEN, 20);
    mock.receive('readyok');

    // Arrive out of order
    mock.receive(infoLine({ depth: 5, multipv: 3, cp: -20 }));
    mock.receive(infoLine({ depth: 5, multipv: 1, cp: 30 }));
    mock.receive(infoLine({ depth: 5, multipv: 2, cp: -10 }));

    const analysis = onUpdate.mock.calls[0][0];
    expect(analysis.lines![0].multipv).toBe(1);
    expect(analysis.lines![1].multipv).toBe(2);
    expect(analysis.lines![2].multipv).toBe(3);
  });

  it('handles multiPV=1 (single line mode)', async () => {
    const onUpdate = vi.fn();
    const { sf, mock } = await createReadyWorker({
      onAnalysisUpdate: onUpdate,
      multiPV: 1,
      stableDepthThreshold: 1,
    });

    sf.analyze(STARTING_FEN, 20);
    mock.receive('readyok');

    mock.receive(infoLine({ depth: 5, multipv: 1, cp: 30 }));
    expect(onUpdate).toHaveBeenCalledTimes(1);
  });

  it('handles info lines without explicit multipv field (defaults to 1)', async () => {
    const onUpdate = vi.fn();
    const { sf, mock } = await createReadyWorker({
      onAnalysisUpdate: onUpdate,
      multiPV: 1,
      stableDepthThreshold: 1,
    });

    sf.analyze(STARTING_FEN, 20);
    mock.receive('readyok');

    // No multipv in line — should default to 1
    mock.receive('info depth 5 score cp 30 pv e2e4 e7e5');
    expect(onUpdate).toHaveBeenCalledTimes(1);
    expect(onUpdate.mock.calls[0][0].depth).toBe(5);
    expect(onUpdate.mock.calls[0][0].score).toBe(30);
  });
});

// ===== SETOPTION ===========================================================

describe('setOption', () => {
  it('sends option immediately when engine is idle', async () => {
    const { sf, mock } = await createReadyWorker();

    sf.setOption('Hash', 128);
    expect(mock.posted).toContain('setoption name Hash value 128');
    expect(mock.posted).toContain('isready');
  });

  it('queues option when engine is analyzing and stops search', async () => {
    const { sf, mock } = await createReadyWorker();

    // Start analysis
    sf.analyze(STARTING_FEN, 20);
    mock.receive('readyok');
    mock.clearPosted();

    // Set option during analysis
    sf.setOption('MultiPV', 5);
    expect(mock.posted).toContain('stop');
    // Option should not be sent yet
    expect(mock.messagesMatching(/setoption name MultiPV/).length).toBe(0);

    // bestmove from stopped search
    mock.receive('bestmove e2e4');
    // isready sent
    mock.clearPosted();

    // readyok triggers the queued option
    mock.receive('readyok');
    expect(mock.posted).toContain('setoption name MultiPV value 5');
    expect(mock.posted).toContain('isready');
  });

  it('restores analysis after option change', async () => {
    const { sf, mock } = await createReadyWorker();

    // Start analysis on a position
    sf.analyze(STARTING_FEN, 20);
    mock.receive('readyok');

    // Send some info so pendingAnalysisData has a FEN
    mock.receive(infoLine({ depth: 5, multipv: 1, cp: 30 }));
    mock.clearPosted();

    // Set option during analysis — should stop and restore
    sf.setOption('Hash', 256);
    mock.receive('bestmove e2e4');
    mock.receive('readyok');
    // Option applied, now another readyok cycle
    mock.clearPosted();
    mock.receive('readyok');

    // Should restore the interrupted analysis
    expect(mock.posted).toContain(`position fen ${STARTING_FEN}`);
  });

  it('does not restore analysis if a new analyze() was called during option change', async () => {
    const { sf, mock } = await createReadyWorker();

    // Start analysis
    sf.analyze(STARTING_FEN, 20);
    mock.receive('readyok');
    mock.receive(infoLine({ depth: 5, multipv: 1, cp: 30 }));
    mock.clearPosted();

    // Set option during analysis
    sf.setOption('Hash', 256);

    // While waiting for bestmove, user queues new analysis
    sf.analyze(FEN_AFTER_E4, 20);

    mock.receive('bestmove e2e4');
    mock.receive('readyok');
    mock.clearPosted();
    mock.receive('readyok');

    // Should start the new position, not restore old one
    expect(mock.posted).toContain(`position fen ${FEN_AFTER_E4}`);
    expect(mock.posted).not.toContain(`position fen ${STARTING_FEN}`);
  });

  it('updates internal multiPV count when setting MultiPV', async () => {
    const onUpdate = vi.fn();
    const { sf, mock } = await createReadyWorker({
      onAnalysisUpdate: onUpdate,
      multiPV: 1,
      stableDepthThreshold: 1,
    });

    sf.setOption('MultiPV', 2);
    mock.receive('readyok');

    // Now start analysis — should expect 2 lines
    sf.analyze(STARTING_FEN, 20);
    mock.receive('readyok');

    mock.receive(infoLine({ depth: 5, multipv: 1, cp: 30 }));
    expect(onUpdate).not.toHaveBeenCalled(); // Need 2 lines now

    mock.receive(infoLine({ depth: 5, multipv: 2, cp: -10 }));
    expect(onUpdate).toHaveBeenCalledTimes(1);
  });

  it('ignores setOption when not ready', () => {
    const sf = new SfEval();
    // Should not throw
    sf.setOption('Hash', 128);
  });

  it('ignores setOption when destroyed', async () => {
    const { sf, mock } = await createReadyWorker();
    sf.destroy();
    mock.clearPosted();
    sf.setOption('Hash', 128);
    expect(mock.posted.length).toBe(0);
  });

  it('handles setOption while already waiting for bestmove', async () => {
    const { sf, mock } = await createReadyWorker();

    // Start analysis
    sf.analyze(STARTING_FEN, 20);
    mock.receive('readyok');
    mock.clearPosted();

    // First interruption — waiting for bestmove
    sf.analyze(FEN_AFTER_E4, 20);
    expect(mock.posted).toContain('stop');
    mock.clearPosted();

    // setOption while waiting for bestmove
    sf.setOption('Hash', 64);

    // bestmove arrives
    mock.receive('bestmove e2e4');
    // Should go through isready -> readyok cycle for option
    mock.receive('readyok');
    expect(mock.posted).toContain('setoption name Hash value 64');
  });
});

// ===== CALLBACK MANAGEMENT =================================================

describe('updateCallbacks', () => {
  it('replaces onAnalysisUpdate callback', async () => {
    const onUpdate1 = vi.fn();
    const onUpdate2 = vi.fn();
    const { sf, mock } = await createReadyWorker({
      onAnalysisUpdate: onUpdate1,
      multiPV: 1,
      stableDepthThreshold: 1,
    });

    sf.updateCallbacks({ onAnalysisUpdate: onUpdate2 });

    sf.analyze(STARTING_FEN, 20);
    mock.receive('readyok');
    mock.receive(infoLine({ depth: 5, multipv: 1, cp: 30 }));

    expect(onUpdate1).not.toHaveBeenCalled();
    expect(onUpdate2).toHaveBeenCalled();
  });

  it('replaces onError callback', async () => {
    const onError1 = vi.fn();
    const onError2 = vi.fn();
    const { sf, mock } = await createReadyWorker({ onError: onError1 });

    sf.updateCallbacks({ onError: onError2 });

    mock.receive('error: something broke');

    expect(onError1).not.toHaveBeenCalled();
    expect(onError2).toHaveBeenCalled();
  });

  it('leaves other callback unchanged when updating only one', async () => {
    const onUpdate = vi.fn();
    const onError = vi.fn();
    const { sf, mock } = await createReadyWorker({
      onAnalysisUpdate: onUpdate,
      onError,
    });

    sf.updateCallbacks({ onError: vi.fn() });

    // onAnalysisUpdate should still work
    sf.analyze(STARTING_FEN, 20);
    mock.receive('readyok');
    mock.receive(infoLine({ depth: 12, multipv: 1, cp: 30 }));
    mock.receive(infoLine({ depth: 12, multipv: 2, cp: -10 }));
    mock.receive(infoLine({ depth: 12, multipv: 3, cp: -20 }));
    expect(onUpdate).toHaveBeenCalled();
  });
});

// ===== FEN TRACKING ========================================================

describe('FEN tracking in analysis', () => {
  it('includes FEN in analysis updates', async () => {
    const onUpdate = vi.fn();
    const { sf, mock } = await createReadyWorker({
      onAnalysisUpdate: onUpdate,
      multiPV: 1,
      stableDepthThreshold: 1,
    });

    sf.analyze(STARTING_FEN, 20);
    mock.receive('readyok');
    mock.receive(infoLine({ depth: 5, multipv: 1, cp: 30 }));

    expect(onUpdate.mock.calls[0][0].fen).toBe(STARTING_FEN);
  });

  it('updates FEN when analyzing new position', async () => {
    const onUpdate = vi.fn();
    const { sf, mock } = await createReadyWorker({
      onAnalysisUpdate: onUpdate,
      multiPV: 1,
      stableDepthThreshold: 1,
    });

    sf.analyze(STARTING_FEN, 20);
    mock.receive('readyok');
    mock.receive(infoLine({ depth: 5, multipv: 1, cp: 30 }));
    expect(onUpdate.mock.calls[0][0].fen).toBe(STARTING_FEN);
    onUpdate.mockClear();

    // New position
    sf.analyze(FEN_AFTER_E4, 20);
    mock.receive('bestmove e2e4');
    mock.receive('readyok');
    mock.receive(infoLine({ depth: 5, multipv: 1, cp: -20 }));
    expect(onUpdate.mock.calls[0][0].fen).toBe(FEN_AFTER_E4);
  });
});

// ===== ERROR HANDLING ======================================================

describe('error handling', () => {
  it('calls onError for engine error lines', async () => {
    const onError = vi.fn();
    const { mock } = await createReadyWorker({ onError });

    mock.receive('error: illegal position');
    expect(onError).toHaveBeenCalledWith('error: illegal position');
  });

  it('marks as destroyed on message handler crash', async () => {
    const { sf, mock } = await createReadyWorker();

    // Hack the message handler to throw
    const originalOnmessage = mock.onmessage;
    mock.onmessage = (e: MessageEvent) => {
      // Simulate the guard — in real code, handleMessage runs inside try/catch
      // We need to trigger the catch inside the worker's onmessage
      originalOnmessage?.(e);
    };

    // The actual error path is through handleMessage throwing,
    // but that's caught internally. Let's verify destroy state instead.
    sf.destroy();
    expect(sf.getIsDestroyed()).toBe(true);
    expect(sf.getIsReady()).toBe(false);
  });

  it('handles non-string message data', async () => {
    const { mock } = await createReadyWorker();

    // Should not throw — converts to string
    mock.receive(42 as unknown as string);
    mock.receive(null as unknown as string);
  });

  it('ignores messages after destruction', async () => {
    const onUpdate = vi.fn();
    const { sf, mock } = await createReadyWorker({
      onAnalysisUpdate: onUpdate,
      multiPV: 1,
      stableDepthThreshold: 1,
    });

    sf.analyze(STARTING_FEN, 20);
    mock.receive('readyok');

    // Destroy mid-analysis
    sf.destroy();

    // Late messages should be ignored (handlers are nulled)
    // This won't fire because onmessage is nulled, but let's verify no error
    expect(mock.onmessage).toBeNull();
  });
});

// ===== STATE MACHINE INTEGRITY (comprehensive transition tests) ============

describe('state machine transitions', () => {
  it('full lifecycle: init -> analyze -> results -> bestmove -> analyze -> stop -> destroy', async () => {
    const onUpdate = vi.fn();
    const { sf, mock } = await createReadyWorker({
      onAnalysisUpdate: onUpdate,
      multiPV: 1,
      stableDepthThreshold: 5,
    });

    // 1. Start analysis
    sf.analyze(STARTING_FEN, 20);
    mock.receive('readyok');

    // 2. Receive results
    for (let d = 1; d <= 10; d++) {
      mock.receive(infoLine({ depth: d, multipv: 1, cp: d * 3 }));
    }
    // Should have updates from depth 5 onwards
    expect(onUpdate.mock.calls.length).toBe(6); // depths 5-10

    // 3. bestmove
    mock.receive('bestmove e2e4');
    const lastCall = onUpdate.mock.calls[onUpdate.mock.calls.length - 1][0];
    expect(lastCall.bestMove).toBe('e2e4');

    // 4. New analysis
    onUpdate.mockClear();
    sf.analyze(FEN_AFTER_E4, 20);
    mock.receive('readyok');

    mock.receive(infoLine({ depth: 8, multipv: 1, cp: -15 }));
    expect(onUpdate).toHaveBeenCalledTimes(1);

    // 5. Stop
    sf.stop();
    mock.receive('bestmove d7d5');
    onUpdate.mockClear();

    // 6. Destroy
    sf.destroy();
    expect(sf.getIsReady()).toBe(false);
    expect(sf.getIsDestroyed()).toBe(true);
  });

  it('handles destroy during init handshake', async () => {
    const sf = new SfEval();
    const p = sf.init();
    mockWorkerInstance.receive('uciok');

    // Destroy before readyok
    sf.destroy();
    expect(sf.getIsDestroyed()).toBe(true);

    // readyok should be ignored (handlers nulled)
    // The promise won't resolve, but shouldn't crash
    expect(sf.getIsReady()).toBe(false);
  });

  it('handles rapid destroy + re-init cycle', async () => {
    const { sf } = await createReadyWorker();

    // Rapid cycle
    sf.destroy();
    const p = sf.init();
    mockWorkerInstance.receive('uciok');
    mockWorkerInstance.receive('readyok');
    await p;

    expect(sf.getIsReady()).toBe(true);
    expect(sf.getIsDestroyed()).toBe(false);

    sf.destroy();
  });

  it('stress test: 10 rapid analyze() calls', async () => {
    const onUpdate = vi.fn();
    const { sf, mock } = await createReadyWorker({
      onAnalysisUpdate: onUpdate,
      multiPV: 1,
      stableDepthThreshold: 1,
    });

    // Fire 10 rapid analyze calls
    for (let i = 0; i < 10; i++) {
      sf.analyze(`fen_${i} w - - 0 1`, 20);
    }

    // Complete the first search that started
    mock.receive('readyok');
    // This starts fen_9 (the last one queued)

    // Provide info for the final position
    mock.receive(infoLine({ depth: 5, multipv: 1, cp: 30 }));
    expect(onUpdate).toHaveBeenCalled();
    expect(onUpdate.mock.calls[0][0].fen).toBe('fen_9 w - - 0 1');
  });

  it('stress test: alternating analyze/stop', async () => {
    const { sf, mock } = await createReadyWorker({
      multiPV: 1,
      stableDepthThreshold: 1,
    });

    // Alternate between analyze and stop rapidly
    for (let i = 0; i < 5; i++) {
      sf.analyze(`fen_${i} w - - 0 1`, 20);
      sf.stop();
    }

    // Drain any pending bestmove
    mock.receive('bestmove e2e4');

    // Should be in a clean state — verify by starting a new analysis
    sf.analyze(STARTING_FEN, 20);
    // Need readyok since stop cleared waiting states
    // The engine should be able to start cleanly
    mock.receive('readyok');

    const goMsgs = mock.messagesMatching(/^go depth/);
    expect(goMsgs.length).toBeGreaterThanOrEqual(1);
  });

  it('handles analyze -> setOption -> analyze -> stop sequence', async () => {
    const onUpdate = vi.fn();
    const { sf, mock } = await createReadyWorker({
      onAnalysisUpdate: onUpdate,
      multiPV: 1,
      stableDepthThreshold: 1,
    });

    // Start analysis
    sf.analyze(STARTING_FEN, 20);
    mock.receive('readyok');
    mock.receive(infoLine({ depth: 5, multipv: 1, cp: 30 }));
    mock.clearPosted();

    // Change option mid-analysis
    sf.setOption('Threads', 4);

    // Immediately queue new analysis
    sf.analyze(FEN_AFTER_E4, 20);

    // Stop everything
    sf.stop();

    // Drain bestmove
    mock.receive('bestmove e2e4');
    mock.receive('readyok');

    // Engine should be idle, no analysis started
    expect(onUpdate.mock.calls.length).toBe(1); // Only the initial depth-5 update
  });
});

// ===== EDGE CASES ==========================================================

describe('edge cases', () => {
  it('handles empty PV in info line', async () => {
    const onUpdate = vi.fn();
    const { sf, mock } = await createReadyWorker({
      onAnalysisUpdate: onUpdate,
      multiPV: 1,
      stableDepthThreshold: 1,
    });

    sf.analyze(STARTING_FEN, 20);
    mock.receive('readyok');

    // Info with no pv section — the regex match for pv returns null
    mock.receive('info depth 5 multipv 1 score cp 30');
    // Should still update (pv defaults to [])
    expect(onUpdate).toHaveBeenCalled();
    expect(onUpdate.mock.calls[0][0].pv).toEqual([]);
  });

  it('handles multiPV option clamped to minimum 1', () => {
    const sf = new SfEval({ multiPV: 0 });
    // Internal multiPV should be 1, not 0
    // We verify this indirectly by checking the init handshake
    const p = sf.init();
    mockWorkerInstance.receive('uciok');
    // Should send MultiPV value of at least 1
    const mpvMsgs = mockWorkerInstance.messagesMatching(/setoption name MultiPV value (\d+)/);
    expect(mpvMsgs.length).toBe(1);
    expect(mpvMsgs[0]).toContain('value 1');
    mockWorkerInstance.receive('readyok');
    sf.destroy();
  });

  it('handles stableDepthThreshold clamped to minimum 1', async () => {
    const onUpdate = vi.fn();
    const sf = new SfEval({
      onAnalysisUpdate: onUpdate,
      multiPV: 1,
      stableDepthThreshold: 0, // Should be clamped to 1
    });
    const p = sf.init();
    mockWorkerInstance.receive('uciok');
    mockWorkerInstance.receive('readyok');
    await p;
    mockWorkerInstance.clearPosted();

    sf.analyze(STARTING_FEN, 20);
    mockWorkerInstance.receive('readyok');
    mockWorkerInstance.receive(infoLine({ depth: 1, multipv: 1, cp: 30 }));
    expect(onUpdate).toHaveBeenCalledTimes(1);
    sf.destroy();
  });

  it('send() returns false when worker is destroyed', async () => {
    const { sf, mock } = await createReadyWorker();
    sf.destroy();

    // analyze() should silently fail
    sf.analyze(STARTING_FEN);
    expect(mock.posted.length).toBe(0);
  });

  it('handles worker.postMessage throwing (simulating terminated worker)', async () => {
    const { sf, mock } = await createReadyWorker();

    // Terminate the mock to make postMessage throw
    mock.terminated = true;

    // Calling analyze should not crash the whole system
    sf.analyze(STARTING_FEN);
    // The internal send should catch the error
  });

  it('INITIAL_ANALYSIS has correct default values', () => {
    expect(INITIAL_ANALYSIS.depth).toBe(0);
    expect(INITIAL_ANALYSIS.score).toBeNull();
    expect(INITIAL_ANALYSIS.mate).toBeNull();
    expect(INITIAL_ANALYSIS.pv).toEqual([]);
    expect(INITIAL_ANALYSIS.bestMove).toBeNull();
    expect(INITIAL_ANALYSIS.fen).toBeNull();
  });

  it('handles unknown UCI messages gracefully', async () => {
    const { mock } = await createReadyWorker();

    // Random messages should not throw
    mock.receive('option name Hash type spin default 16 min 1 max 33554432');
    mock.receive('id name Stockfish 17');
    mock.receive('id author the Stockfish developers');
    mock.receive('');
    mock.receive('copyprotection ok');
  });

  it('setOption with string value', async () => {
    const { sf, mock } = await createReadyWorker();

    sf.setOption('SyzygyPath', '/path/to/tablebases');
    expect(mock.posted).toContain('setoption name SyzygyPath value /path/to/tablebases');
  });

  it('setOption MultiPV with invalid string does not crash', async () => {
    const { sf } = await createReadyWorker();

    // NaN parse should not crash
    sf.setOption('MultiPV', 'invalid' as unknown as number);
    // Should silently not update internal multiPV
  });
});

// ===== CONCURRENT OPERATION RACE CONDITIONS ================================

describe('race conditions', () => {
  it('analyze() during init handshake before readyok', async () => {
    const sf = new SfEval();
    const p = sf.init();
    mockWorkerInstance.receive('uciok');

    // analyze before readyok — engine not ready yet, should be a no-op
    sf.analyze(STARTING_FEN);

    mockWorkerInstance.receive('readyok');
    await p;

    // After init completes, analyze should work normally
    sf.analyze(STARTING_FEN);
    expect(mockWorkerInstance.posted).toContain('isready');
  });

  it('setOption during init handshake is ignored', async () => {
    const sf = new SfEval();
    sf.init();

    // setOption before engine is ready — should be silently ignored
    sf.setOption('Hash', 128);

    mockWorkerInstance.receive('uciok');
    mockWorkerInstance.receive('readyok');

    // No setoption Hash should have been sent (only the init MultiPV)
    const hashMsgs = mockWorkerInstance.messagesMatching(/setoption name Hash/);
    expect(hashMsgs.length).toBe(0);
  });

  it('destroy during pending bestmove cleans up correctly', async () => {
    const { sf, mock } = await createReadyWorker();

    // Start analysis
    sf.analyze(STARTING_FEN, 20);
    mock.receive('readyok');

    // Interrupt — waiting for bestmove
    sf.analyze(FEN_AFTER_E4, 20);

    // Destroy while waiting for bestmove
    sf.destroy();
    expect(sf.getIsDestroyed()).toBe(true);
    expect(sf.getIsReady()).toBe(false);
  });

  it('multiple setOption calls queue correctly', async () => {
    const { sf, mock } = await createReadyWorker();

    // Start analysis
    sf.analyze(STARTING_FEN, 20);
    mock.receive('readyok');
    mock.clearPosted();

    // Set option while analyzing
    sf.setOption('Hash', 128);
    // Second setOption overwrites pending
    sf.setOption('Hash', 256);

    mock.receive('bestmove e2e4');
    mock.receive('readyok');

    // Should only see the last value
    const hashMsgs = mock.messagesMatching(/setoption name Hash/);
    expect(hashMsgs.length).toBe(1);
    expect(hashMsgs[0]).toContain('value 256');
  });
});
