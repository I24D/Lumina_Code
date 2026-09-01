/**
 * Owns all cancellable work associated with the current spoken turn.
 *
 * AbortController alone is not enough: a provider may ignore the signal and
 * resolve late. The monotonically increasing generation lets callers reject
 * that stale result before it is handed to the model as if it belonged to the
 * user's newer request.
 */

export interface TurnOperation {
  readonly generation: number;
  readonly signal: AbortSignal;
  isCurrent(): boolean;
  finish(): void;
}

export class TurnCancellationManager {
  private generation = 0;
  private readonly controllers = new Set<AbortController>();
  private lastReason?: string;

  currentGeneration(): number {
    return this.generation;
  }

  reason(): string | undefined {
    return this.lastReason;
  }

  activeOperations(): number {
    return this.controllers.size;
  }

  beginTurn(reason = "new-turn"): number {
    this.cancel(reason);
    return this.generation;
  }

  startOperation(): TurnOperation {
    const generation = this.generation;
    const controller = new AbortController();
    this.controllers.add(controller);
    let finished = false;

    return {
      generation,
      signal: controller.signal,
      isCurrent: () =>
        !finished &&
        !controller.signal.aborted &&
        generation === this.generation,
      finish: () => {
        if (finished) {
          return;
        }
        finished = true;
        this.controllers.delete(controller);
      },
    };
  }

  cancel(reason = "cancelled"): void {
    this.lastReason = reason;
    this.generation += 1;
    for (const controller of this.controllers) {
      controller.abort(reason);
    }
    this.controllers.clear();
  }
}
