import { useState, useRef, useEffect, useCallback } from 'react';
import { Chessboard } from 'react-chessboard';
import { Chess } from 'chess.js';
import { SfEval, INITIAL_ANALYSIS } from '@haut/sfeval';
import type { AnalysisInfo } from '@haut/sfeval';
import { EvalBar } from './EvalBar';
import './App.css';

const BOARD_WIDTH = 480;

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
    (sourceSquare: string, targetSquare: string): boolean => {
      const move = game.move({
        from: sourceSquare,
        to: targetSquare,
        promotion: 'q',
      });

      if (!move) return false;

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
      <Chessboard
        id="board"
        position={fen}
        onPieceDrop={onPieceDrop}
        boardWidth={BOARD_WIDTH}
      />
      <EvalBar score={whiteScore} mate={whiteMate} width={BOARD_WIDTH} />
      <div className="info">
        <span>Depth: {analysis.depth}</span>
        {analysis.bestMove && <span>Best: {analysis.bestMove}</span>}
        {status && <span className="status">{status}</span>}
      </div>
    </div>
  );
}

export default App;
