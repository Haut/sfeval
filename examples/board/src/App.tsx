import { useState, useRef, useEffect, useCallback } from 'react';
import { Chessboard } from 'react-chessboard';
import { Chess } from 'chess.js';
import { SfEval, INITIAL_ANALYSIS } from '@haut/sfeval';
import type { AnalysisInfo, AnalysisLine } from '@haut/sfeval';
import { EvalBar } from './EvalBar';
import './App.css';

const BOARD_WIDTH = 480;

function formatEval(score: number | null, mate: number | null): string {
  if (mate !== null) return mate > 0 ? `+M${Math.abs(mate)}` : `-M${Math.abs(mate)}`;
  if (score !== null) {
    const p = score / 100;
    return p > 0 ? `+${p.toFixed(2)}` : p.toFixed(2);
  }
  return '—';
}

function Lines({ lines, flip, width }: { lines?: AnalysisLine[]; flip: number; width: number }) {
  if (!lines?.length) return null;
  return (
    <div style={{ width, fontFamily: 'monospace', fontSize: 13, color: '#ccc' }}>
      {lines.map((line) => (
        <div key={line.multipv} className="line-row">
          <span className="line-eval">
            {formatEval(
              line.score !== null ? line.score * flip : null,
              line.mate !== null ? line.mate * flip : null,
            )}
          </span>
          <span className="line-pv">{line.pv.join(' ')}</span>
        </div>
      ))}
    </div>
  );
}

function App() {
  const [game] = useState(() => new Chess());
  const [fen, setFen] = useState(game.fen());
  const [analysis, setAnalysis] = useState<AnalysisInfo>(INITIAL_ANALYSIS);
  const engineRef = useRef<SfEval | null>(null);

  useEffect(() => {
    const engine = new SfEval({
      workerPath: '/engine/stockfish.js',
      multiPV: 3,
      stableDepthThreshold: 8,
      debug: true,
      onAnalysisUpdate: (info) => setAnalysis(info),
      onError: (err) => console.error('[SfEval error]', err),
    });

    engineRef.current = engine;

    engine.init().then(() => {
      engine.analyze(game.fen());
    });

    return () => {
      engine.destroy();
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const onPieceDrop = useCallback(
    ({ sourceSquare, targetSquare }: { piece: unknown; sourceSquare: string; targetSquare: string | null }): boolean => {
      if (!targetSquare) return false;
      try {
        game.move({ from: sourceSquare, to: targetSquare, promotion: 'q' });
      } catch {
        return false;
      }

      const newFen = game.fen();
      setFen(newFen);
      setAnalysis(INITIAL_ANALYSIS);
      engineRef.current?.analyze(newFen);
      return true;
    },
    [game],
  );

  // Normalize score to white's perspective for the eval bar.
  // SfEval reports from the side-to-move's perspective.
  const sideToMove = fen.split(' ')[1];
  const flip = sideToMove === 'b' ? -1 : 1;
  const whiteScore = analysis.score !== null ? analysis.score * flip : null;
  const whiteMate = analysis.mate !== null ? analysis.mate * flip : null;

  const status = game.isCheckmate()
    ? 'Checkmate'
    : game.isStalemate()
      ? 'Stalemate'
      : game.isDraw()
        ? 'Draw'
        : game.inCheck()
          ? 'Check'
          : '';

  return (
    <div className="app">
      <div style={{ width: BOARD_WIDTH, height: BOARD_WIDTH }}>
        <Chessboard
          options={{
            position: fen,
            onPieceDrop,
          }}
        />
      </div>
      <EvalBar score={whiteScore} mate={whiteMate} depth={analysis.depth} width={BOARD_WIDTH} />
      <Lines lines={analysis.lines} flip={flip} width={BOARD_WIDTH} />
      {status && <div className="info"><span className="status">{status}</span></div>}
    </div>
  );
}

export default App;
