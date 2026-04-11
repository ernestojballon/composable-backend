import { EventEnvelope } from '../models/event-envelope.js';
import { Composable, defineComposable, preload } from '../models/composable.js';

export const NoOpComposable = defineComposable({
  process: 'no.op',
  instances: 50,
  handler: async (evt: EventEnvelope) => evt,
});

export class NoOp implements Composable {
  @preload('no.op', 50)
  initialize(): Composable {
    return this;
  }

  async handleEvent(evt: EventEnvelope) {
    return evt;
  }
}
