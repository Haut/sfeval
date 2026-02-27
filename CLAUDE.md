# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

**stockfish-kit** — a lightweight browser wrapper for Stockfish WASM with UCI state management. Provides a `SfEval` class for vanilla JS and a `useSfEval` React hook via the `stockfish-kit/react` subpath export.

## Commands

- `npm run build` — build ESM + CJS via tsup
- `npm run dev` — build in watch mode
- `npm test` — run all tests (vitest)
- `npx vitest run src/__tests__/sfeval.test.ts -t "test name"` — run a single test by name

## Architecture

Four source files in `src/`:

- **types.ts** — All public types (`AnalysisInfo`, `AnalysisLine`, `SfEvalOptions`, `SfEvalCallbacks`) and the `INITIAL_ANALYSIS` constant. Scores are always raw (from side-to-move's perspective); consumers convert to white's perspective.
- **sfeval.ts** — Core `SfEval` class (~540 lines). Manages a Web Worker running Stockfish WASM, handles UCI protocol sequencing (`uci` → `uciok` → `isready` → `readyok` → `position` → `go` → `info` → `bestmove`), parses engine output, and tracks MultiPV lines. Key internal state: `isReady`, `isAnalyzing`, `isWaitingForBestmove`, `isWaitingForReady`, plus pending queues for analysis/options that arrive during transitions.
- **react.ts** — `useSfEval` hook. Auto-initializes the engine, reacts to FEN changes, manages callback refs for closure safety, and cleans up on unmount.
- **index.ts** — Re-exports `SfEval`, types, and `INITIAL_ANALYSIS`.

Build produces dual ESM/CJS with `.d.ts` files. React is an optional peer dependency and externalized by tsup.

## Testing

Tests live in `src/__tests__/sfeval.test.ts` (85 tests). They use a `MockWorker` class that simulates the browser Worker API — no real Stockfish binary needed. Tests cover UCI sequencing, state transitions, MultiPV parsing, pending queues, error handling, and edge cases (aspiration windows, bounds, diagnostic lines).

## Key Design Details

- **Stable depth threshold** (default 12): analysis results are not emitted to callbacks until the engine reaches this depth, preventing eval jumps at shallow depths.
- **Pending queues**: if `analyze()` or `setOption()` is called while the engine is mid-transition (waiting for bestmove/readyok), the request is queued and replayed when ready.
- **MultiPV tracking**: uses a `Map<number, AnalysisLine>` keyed by multipv index; lines are only emitted as a batch when all lines for a given depth are collected.
