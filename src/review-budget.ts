export class ReviewRunBudget {
  private readonly maxRuns: number;
  private currentRuns = 0;

  constructor(maxActiveRuns: number) {
    if (!Number.isInteger(maxActiveRuns)) throw new Error("maxActiveRuns must be an integer");
    if (maxActiveRuns < 1) throw new Error("maxActiveRuns must be at least 1");
    this.maxRuns = maxActiveRuns;
  }

  get activeRuns(): number {
    return this.currentRuns;
  }

  tryStart(): boolean {
    if (this.currentRuns >= this.maxRuns) return false;
    this.currentRuns += 1;
    return true;
  }

  finish(): void {
    this.currentRuns = Math.max(0, this.currentRuns - 1);
  }
}
