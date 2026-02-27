interface EvalBarProps {
  score: number | null;
  mate: number | null;
  depth: number;
  width: number;
}

/** Sigmoid mapping: centipawns → white's percentage (0–100). */
function cpToPercent(cp: number): number {
  return 50 + 50 * (2 / (1 + Math.exp(-cp / 200)) - 1);
}

function formatScore(score: number | null, mate: number | null): string {
  if (mate !== null) {
    return mate > 0 ? `M${mate}` : `M${mate}`;
  }
  if (score !== null) {
    const pawns = score / 100;
    return pawns > 0 ? `+${pawns.toFixed(1)}` : pawns.toFixed(1);
  }
  return '0.0';
}

export function EvalBar({ score, mate, depth, width }: EvalBarProps) {
  let whitePercent: number;
  if (mate !== null) {
    whitePercent = mate > 0 ? 100 : 0;
  } else if (score !== null) {
    whitePercent = cpToPercent(score);
  } else {
    whitePercent = 50;
  }

  const label = formatScore(score, mate);
  const whiteAdvantage = (score !== null && score >= 0) || (mate !== null && mate > 0);

  return (
    <div
      style={{
        width,
        height: 28,
        borderRadius: 4,
        overflow: 'hidden',
        position: 'relative',
        display: 'flex',
        background: '#333',
        fontFamily: 'system-ui, sans-serif',
        fontSize: 13,
        fontWeight: 600,
        userSelect: 'none',
      }}
    >
      {/* White side */}
      <div
        style={{
          width: `${whitePercent}%`,
          background: '#f0f0f0',
          transition: 'width 0.3s ease',
          minWidth: 0,
        }}
      />
      {/* Label + Depth */}
      <div
        style={{
          position: 'absolute',
          inset: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '0 8px',
        }}
      >
        <span style={{ color: whiteAdvantage ? '#333' : '#f0f0f0' }}>
          {label}
        </span>
        <span style={{ color: whiteAdvantage ? '#f0f0f0' : '#333', fontSize: 11, opacity: 0.7 }}>
          {depth > 0 ? `d${depth}` : ''}
        </span>
      </div>
    </div>
  );
}
