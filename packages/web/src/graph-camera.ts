export class InitialGraphAutoFit {
  private pending = true;

  consume(): boolean {
    if (!this.pending) return false;
    this.pending = false;
    return true;
  }

  cancel(): void {
    this.pending = false;
  }
}
