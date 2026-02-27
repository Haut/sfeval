import { useState, useCallback } from 'react';
import { Chessboard } from 'react-chessboard';
import { Chess } from 'chess.js';
import { useSfEval } from 'stockfish-kit/react';
import type { AnalysisLine } from 'stockfish-kit';
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

  const { analysis } = useSfEval({
    fen,
    workerPath: '/engine/stockfish.js',
    multiPV: 3,
    stableDepthThreshold: 20,
    debug: true,
    onError: (err) => console.error('[SfEval error]', err),
  });

  const onPieceDrop = useCallback(
    ({ sourceSquare, targetSquare }: { piece: unknown; sourceSquare: string; targetSquare: string | null }): boolean => {
      if (!targetSquare) return false;
      try {
        game.move({ from: sourceSquare, to: targetSquare, promotion: 'q' });
      } catch {
        return false;
      }
      setFen(game.fen());
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
