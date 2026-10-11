/** Random unit vector (cheat mode). Gaussian via Box–Muller, then normalised. */
export function randomUnitVector(dim: number): number[] {
  const v = new Array<number>(dim);
  let norm = 0;
  for (let i = 0; i < dim; i += 2) {
    const u1 = Math.random() || 1e-12;
    const u2 = Math.random();
    const r = Math.sqrt(-2 * Math.log(u1));
    const a = r * Math.cos(2 * Math.PI * u2);
    const b = r * Math.sin(2 * Math.PI * u2);
    v[i] = a;
    norm += a * a;
    if (i + 1 < dim) {
      v[i + 1] = b;
      norm += b * b;
    }
  }
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < dim; i++) v[i] /= norm;
  return v;
}
