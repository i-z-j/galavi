/**
 * Tile load queue — bounded-concurrency scheduler for tile fetches.
 *
 * Tracks the desired tile set per generation; stale loads (from before a
 * `reset`) are rejected via `shouldAccept`.
 */

export class TileLoadQueue<T extends { id: string }> {
  private desiredTiles  = new Set<string>();
  private pendingTiles  : T[] = [];
  private loadingTiles  = new Set<string>();
  private inFlightLoads = 0;
  private generation    = 0;

  constructor(private readonly maxConcurrentLoads = 4) {}

  get currentGeneration(): number {
    return this.generation;
  }

  isLoading(id: string): boolean {
    return this.loadingTiles.has(id);
  }

  shouldAccept(id: string, generation: number): boolean {
    return generation === this.generation && this.desiredTiles.has(id);
  }

  setDesired(desiredIds: Iterable<string>, pendingTiles: T[]): void {
    this.desiredTiles = new Set(desiredIds);
    this.pendingTiles = pendingTiles;
  }

  reset(): void {
    this.generation++;
    this.desiredTiles.clear();
    this.pendingTiles = [];
    this.loadingTiles.clear();
  }

  finish(id: string): void {
    this.loadingTiles.delete(id);
    this.inFlightLoads = Math.max(0, this.inFlightLoads - 1);
  }

  pump(
    canStart  : (tile: T) => boolean,
    startLoad : (tile: T, generation: number) => void,
  ): void {
    while (this.inFlightLoads < this.maxConcurrentLoads && this.pendingTiles.length > 0) {
      const nextIndex = this.pendingTiles.findIndex((tile) => (
        !this.loadingTiles.has(tile.id) &&
        this.desiredTiles.has(tile.id) &&
        canStart(tile)
      ));

      if (nextIndex < 0) return;

      const [tile] = this.pendingTiles.splice(nextIndex, 1);
      this.loadingTiles.add(tile.id);
      this.inFlightLoads++;
      startLoad(tile, this.generation);
    }
  }
}
