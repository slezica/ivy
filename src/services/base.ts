/**
 * Base Service
 *
 * Abstract base class providing typed event emission for services.
 * Uses mitt internally but exposes a simpler API.
 */

import mitt, { Emitter, Handler } from 'mitt'

export abstract class BaseService<Events extends Record<string, unknown>> {
  private emitter: Emitter<Events>

  constructor() {
    this.emitter = mitt<Events>()
  }

  on<K extends keyof Events>(event: K, handler: Handler<Events[K]>): void {
    this.emitter.on(event, handler)
  }

  off<K extends keyof Events>(event: K, handler: Handler<Events[K]>): void {
    this.emitter.off(event, handler)
  }

  protected emit<K extends keyof Events>(event: K, value: Events[K]): void {
    this.emitter.emit(event, value)
  }
}
