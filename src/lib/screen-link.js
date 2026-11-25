// Link between the player and a visualizer "screen" (a second window on another display, or any same-origin tab).
// The player analyses the audio once and broadcasts each frame; a screen rebuilds the same `A` object the packs expect.
export const CHANNEL = 'bootleg-screen';

// Everything in A except functions (past/stem are rebuilt on the other side).
export function packFrame(A) { const f = {}; for (const k in A) if (typeof A[k] !== 'function') f[k] = A[k]; return f; }

// Receiver side: keeps a short history so A.past(seconds) works, and re-attaches A.stem().
export class FrameRebuilder {
  constructor() { this.hist = []; }
  rebuild(f) {
    const A = { ...f }, now = performance.now() / 1000; if (A.spectrum) { this.hist.push({ t: now, s: A.spectrum }); if (this.hist.length > 720) this.hist.shift(); }
    A.past = sec => { const want = now - sec; for (let i = this.hist.length - 1; i >= 0; i--) if (this.hist[i].t <= want) return this.hist[i].s; return this.hist[0]?.s || A.spectrum; };
    if (window.VisStems) window.VisStems.attach(A, A.stems || []); return A;
  }
}
