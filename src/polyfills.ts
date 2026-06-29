// Must be imported FIRST, before any module that touches Buffer/global
// (e.g. @solana/spl-token, @coral-xyz/anchor). ES module imports evaluate in
// order, so importing this module before App guarantees the globals exist
// before Solana libs are evaluated. Setting them in main.tsx's body runs too
// late — the body executes after its imports have already evaluated.
import { Buffer } from 'buffer';

const g = globalThis as unknown as { Buffer?: typeof Buffer; global?: unknown };
if (typeof g.Buffer === 'undefined') {
  g.Buffer = Buffer;
}
if (typeof g.global === 'undefined') {
  g.global = globalThis;
}
