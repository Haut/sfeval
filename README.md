# stockfish-kit

Lightweight browser wrapper for [Stockfish](https://stockfishchess.org/) WASM with UCI state management. Handles the Web Worker lifecycle, UCI protocol sequencing, and MultiPV tracking so you don't have to.

- **Zero runtime dependencies** — just bring your own Stockfish WASM build
- **React hook** included via `stockfish-kit/react`
- **Dual format** — ESM and CommonJS with full TypeScript types
- **Tree-shakeable** — marked `sideEffects: false`

## Install

```bash
npm install stockfish-kit
```

You also need a Stockfish WASM build served as a web worker. The [`stockfish`](https://www.npmjs.com/package/stockfish) npm package works well — copy its JS file to your public directory (e.g. `public/engine/stockfish.js`).

## React Quickstart

```tsx
import { useSfEval } from 'stockfish-kit/react';

function Analysis() {
  const { analysis, isReady, error } = useSfEval({
    fen: 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1',
    workerPath: '/engine/stockfish.js',
    multiPV: 3,
  });

  if (error) return <div>Engine error: {error}</div>;
  if (!isReady) return <div>Loading engine...</div>;

  return (
    <div>
      <p>Depth: {analysis.depth}</p>
      <p>Eval: {analysis.score !== null ? (analysis.score / 100).toFixed(2) : '—'}</p>
      <p>Best move: {analysis.bestMove ?? '...'}</p>
      {analysis.lines?.map((line) => (
        <div key={line.multipv}>
          Line {line.multipv}: {line.pv.join(' ')}
        </div>
      ))}
    </div>
  );
}
```

Pass `null` or `undefined` as `fen` to pause analysis. When `fen` changes, the previous search is stopped and a new one begins automatically.

### Hook options

```ts
useSfEval({
  fen: string | null | undefined; // position to analyze (null/undefined = paused)
  workerPath?: string;             // path to Stockfish worker (default: '/engine/stockfish.js')
  maxDepth?: number;               // maximum search depth (default: 25)
  multiPV?: number;                // number of principal variations (default: 3)
  stableDepthThreshold?: number;   // min depth before results are emitted (default: 12)
  debug?: boolean;                 // log UCI messages to console (default: false)
  onError?: (error: string) => void;
});
```

### Hook return value

```ts
{
  analysis: AnalysisInfo; // current analysis (resets on fen change)
  engine: SfEval | null;  // underlying engine instance
  isReady: boolean;       // true once the engine is initialized
  error: string | null;   // last error, or null
}
```

## Vanilla JS

```ts
import { SfEval } from 'stockfish-kit';

const engine = new SfEval({
  workerPath: '/engine/stockfish.js',
  multiPV: 3,
  stableDepthThreshold: 12,
  onAnalysisUpdate: (analysis) => {
    console.log(`depth ${analysis.depth}  eval ${analysis.score}  best ${analysis.bestMove}`);
    console.log('lines:', analysis.lines);
  },
  onError: (err) => console.error(err),
});

await engine.init();

// Analyze a position
engine.analyze('rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1');

// Change position (automatically stops previous search)
engine.analyze('rnbqkbnr/pppppppp/8/8/3PP3/8/PPP2PPP/RNBQKBNR b KQkq - 0 2');

// Stop analysis
engine.stop();

// Set UCI options at runtime
engine.setOption('Threads', 4);
engine.setOption('Hash', 128);
engine.setOption('MultiPV', 5);

// Clean up
engine.destroy();
```

## API

### `SfEval`

#### Constructor options

| Option | Type | Default | Description |
|---|---|---|---|
| `workerPath` | `string` | `'/engine/stockfish.js'` | URL/path to the Stockfish worker script |
| `multiPV` | `number` | `3` | Number of principal variations |
| `stableDepthThreshold` | `number` | `12` | Minimum depth before emitting results (prevents eval jumps at low depth) |
| `debug` | `boolean` | `false` | Log UCI protocol messages to console |
| `onAnalysisUpdate` | `(analysis: AnalysisInfo) => void` | — | Called on each analysis update |
| `onError` | `(error: string) => void` | — | Called on engine errors |

#### Methods

| Method | Description |
|---|---|
| `init(): Promise<void>` | Initialize the engine. Safe to call multiple times. |
| `analyze(fen, maxDepth?)` | Start analyzing a position. Queues if the engine is mid-transition. |
| `stop()` | Stop the current analysis. |
| `setOption(name, value)` | Set a UCI option (e.g. `Threads`, `Hash`, `MultiPV`). Handles stop/restart if the engine is searching. |
| `updateCallbacks(callbacks)` | Update `onAnalysisUpdate`/`onError` without recreating the engine. |
| `getIsReady(): boolean` | Check if the engine is initialized. |
| `getIsDestroyed(): boolean` | Check if the engine has been destroyed. |
| `destroy()` | Terminate the worker and release all resources. |

### `AnalysisInfo`

```ts
{
  depth: number;            // current search depth
  score: number | null;     // centipawns (from side-to-move's perspective)
  mate: number | null;      // mate in N (from side-to-move's perspective)
  pv: string[];             // principal variation (UCI move strings)
  bestMove: string | null;  // best move when search completes
  fen: string | null;       // position this analysis belongs to
  lines?: AnalysisLine[];   // all MultiPV lines (when multiPV > 1)
}
```

### `AnalysisLine`

```ts
{
  depth: number;
  score: number | null;
  mate: number | null;
  pv: string[];
  multipv: number;          // line number (1, 2, 3...)
}
```

> **Note:** Scores are always from the **side-to-move's perspective**. To display from White's perspective, multiply by `-1` when it's Black to move:
> ```ts
> const flip = fen.split(' ')[1] === 'b' ? -1 : 1;
> const whiteScore = analysis.score !== null ? analysis.score * flip : null;
> ```

## Key Behaviors

**Stable depth threshold** — By default, no results are emitted until the engine reaches depth 12. This prevents the evaluation from jumping wildly at shallow depths. Configure with `stableDepthThreshold`.

**Automatic sequencing** — Calling `analyze()` while the engine is busy (searching, waiting for `bestmove`, or waiting for `readyok`) queues the request. The proper UCI stop/sync sequence is handled internally.

**`setOption` during search** — If you call `setOption()` while a search is running, the engine stops the search, applies the option, and automatically restarts analysis on the same position.

**MultiPV batching** — When using multiple principal variations, lines are only emitted once all lines reach the same depth, avoiding mixed-depth output.

## Cross-Origin Isolation

If your Stockfish build uses `SharedArrayBuffer` (required for multi-threaded WASM), your server must send these headers:

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

Vite example:

```ts
// vite.config.ts
export default defineConfig({
  server: {
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
  },
});
```

## License

MIT
