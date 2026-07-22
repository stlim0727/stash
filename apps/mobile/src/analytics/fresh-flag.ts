/** A remote boolean is never trusted across launches or failed refreshes. */
export class FreshLaunchBooleanFlag {
  private generation = 0;
  private enabled = false;

  value(): boolean {
    return this.enabled;
  }

  startLaunch(): void {
    this.generation += 1;
    this.enabled = false;
  }

  async refresh(load: () => Promise<unknown>): Promise<boolean> {
    const generation = this.generation;
    this.enabled = false;
    try {
      const value = await load();
      if (generation === this.generation) this.enabled = value === true;
    } catch {
      if (generation === this.generation) this.enabled = false;
    }
    return this.enabled;
  }
}
