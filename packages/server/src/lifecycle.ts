export class Lifecycle {
  private draining = false;

  get isDraining(): boolean {
    return this.draining;
  }

  beginDrain(): void {
    this.draining = true;
  }
}
