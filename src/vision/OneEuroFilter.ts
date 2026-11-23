/**
 * 1€ (One-Euro) Adaptive Low-Pass Filter.
 * Smooths hand landmark jitter when moving slowly while remaining ultra-responsive
 * during rapid strums and plucks.
 */
export class OneEuroFilter1D {
  private prevValue: number | null = null;
  private prevDeriv = 0;
  private prevTime: number | null = null;

  constructor(
    private readonly minCutoff = 1.6,
    private readonly beta = 0.06,
    private readonly dCutoff = 1.0
  ) {}

  private static alpha(cutoff: number, dt: number): number {
    const tau = 1.0 / (2.0 * Math.PI * cutoff);
    return 1.0 / (1.0 + tau / Math.max(dt, 1e-4));
  }

  filter(value: number, timestampSec: number): number {
    if (this.prevValue === null || this.prevTime === null) {
      this.prevValue = value;
      this.prevTime = timestampSec;
      return value;
    }

    const dt = Math.max(timestampSec - this.prevTime, 1 / 240);
    const rawDeriv = (value - this.prevValue) / dt;
    const aD = OneEuroFilter1D.alpha(this.dCutoff, dt);
    const smoothDeriv = aD * rawDeriv + (1 - aD) * this.prevDeriv;

    const cutoff = this.minCutoff + this.beta * Math.abs(smoothDeriv);
    const a = OneEuroFilter1D.alpha(cutoff, dt);
    const filtered = a * value + (1 - a) * this.prevValue;

    this.prevValue = filtered;
    this.prevDeriv = smoothDeriv;
    this.prevTime = timestampSec;
    return filtered;
  }

  reset(): void {
    this.prevValue = null;
    this.prevDeriv = 0;
    this.prevTime = null;
  }
}

export class LandmarkSmoother {
  private filters: [OneEuroFilter1D, OneEuroFilter1D, OneEuroFilter1D][] = [];

  constructor(
    private readonly count = 21,
    private readonly minCutoff = 2.2,
    private readonly beta = 0.14
  ) {
    this.init();
  }

  private init(): void {
    this.filters = Array.from({ length: this.count }, () => [
      new OneEuroFilter1D(this.minCutoff, this.beta),
      new OneEuroFilter1D(this.minCutoff, this.beta),
      new OneEuroFilter1D(this.minCutoff, this.beta),
    ]);
  }

  smooth(
    raw: { x: number; y: number; z: number }[],
    timestampSec: number
  ): { x: number; y: number; z: number }[] {
    return raw.map((pt, i) => {
      const f = this.filters[i];
      if (!f) return pt;
      return {
        x: f[0].filter(pt.x, timestampSec),
        y: f[1].filter(pt.y, timestampSec),
        z: f[2].filter(pt.z, timestampSec),
      };
    });
  }

  reset(): void {
    for (const triple of this.filters) {
      triple[0].reset();
      triple[1].reset();
      triple[2].reset();
    }
  }
}
