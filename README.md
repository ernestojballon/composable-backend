# Composable Backend

A composable backend framework for building event-driven microservices and serverless applications in Node.js.

This project is a derivative work based on [Mercury Composable for Node.js](https://github.com/Accenture/mercury-nodejs), originally developed by Accenture. See [NOTICE](NOTICE) for full attribution.

The source code is provided under the Apache 2.0 license.

## 5-Minute Quickstart

### Install

```bash
npm install composable-backend
```

### Optional Kafka Add-On

Kafka support is being split into a first-party companion package so the core library can stay lean for HTTP-only and serverless use cases.

When the package is available, the intended installation will be:

```bash
npm install composable-backend @composable-backend/kafka kafkajs
```

Until then, use the Kafka adapter approach described in [Chapter 8](guides/CHAPTER-8.md).

### Minimal Project

```text
your-app/
  src/
    main.ts
    services/
      hello-world.ts
    resources/
      application.yml
  tests/
    hello-world.test.ts
```

### Minimal Config

Create `src/resources/application.yml`:

```yaml
application.name: 'quickstart-demo'
log.level: 'info'
rest.automation: false
```

### Minimal Function

Create `src/services/hello-world.ts`:

```ts
import { defineComposable, EventEnvelope } from 'composable-backend';

export default defineComposable({
  process: 'hello.world',
  handler: async (evt: EventEnvelope) => {
    const body = (evt.getBody() ?? {}) as { name?: string };
    return {
      message: `Hello ${body.name ?? 'world'}`,
    };
  },
});
```

### Minimal App Bootstrap

Create `src/main.ts`:

```ts
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { AppConfig, Platform } from 'composable-backend';
import helloWorld from './services/hello-world.js';

function getResourcePath() {
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, 'resources');
}

async function main() {
  AppConfig.getInstance(getResourcePath());

  const platform = Platform.getInstance();
  await platform.getReady();

  platform.registerComposable(helloWorld);
  platform.runForever();
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
```

### Example Request

You can send an in-memory RPC request to your composable with `PostOffice`:

```ts
import { EventEnvelope, PostOffice, Sender } from 'composable-backend';

const po = new PostOffice(new Sender('demo.client', '1000', 'TEST /hello'));

const response = await po.request(
  new EventEnvelope()
    .setTo('hello.world')
    .setBody({ name: 'Ada' }),
  3000
);

console.log(response.getBody());
// { message: 'Hello Ada' }
```

### Testing Example

Create `tests/hello-world.test.ts`:

```ts
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { beforeAll, describe, expect, it } from 'vitest';
import { AppConfig, EventEnvelope, Platform, PostOffice, Sender } from 'composable-backend';
import helloWorld from '../src/services/hello-world.js';

function getResourcePath() {
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, '../src/resources');
}

describe('hello.world', () => {
  let platform: Platform;

  beforeAll(async () => {
    AppConfig.getInstance(getResourcePath());
    platform = Platform.getInstance();
    await platform.getReady();
    platform.registerComposable(helloWorld);
  });

  it('returns a greeting', async () => {
    const po = new PostOffice(new Sender('unit.test', '1001', 'TEST /hello'));
    const response = await po.request(
      new EventEnvelope()
        .setTo('hello.world')
        .setBody({ name: 'Ada' }),
      3000
    );
    expect(response.getBody()).toStrictEqual({ message: 'Hello Ada' });
  });
});
```

Run it with:

```bash
npx vitest run
```

## Two Authoring Styles

The library supports both styles:

### Function Style

```ts
import { defineComposable, EventEnvelope } from 'composable-backend';

export default defineComposable({
  process: 'v1.lead.log-scored',
  instances: 10,
  handler: async (evt: EventEnvelope) => {
    return evt.getBody() ?? {};
  },
});
```

Register it with:

```ts
platform.registerComposable(leadLogScored);
```

### Class Style

```ts
import { Composable, EventEnvelope, preload } from 'composable-backend';

export class LeadLogScored implements Composable {
  @preload('v1.lead.log-scored', 10)
  initialize(): Composable {
    return this;
  }

  async handleEvent(evt: EventEnvelope) {
    return evt.getBody() ?? {};
  }
}
```

Register it with:

```ts
platform.register('v1.lead.log-scored', new LeadLogScored(), 10);
```

## Why Composable Backend

Composable Backend is built around a simple idea: each task should be a self-contained unit with immutable input and output, and larger use cases should be assembled by event choreography rather than tight coupling.

That gives you:

- Small, isolated business functions
- Clear boundaries between tasks
- Easy unit and integration testing
- Strong fit for event-driven systems and flow-based automation
- A code shape that is easy for both humans and AI tools to reason about

## Next Steps

- Read [Chapter 1, Developer Guide](guides/CHAPTER-1.md) for a broader walkthrough
- Read [Chapter 7, API Overview](guides/CHAPTER-7.md) for platform APIs
- Read [Chapter 8, Kafka Flow Adapter](guides/CHAPTER-8.md) for the current Kafka integration approach
- Read [Methodology](guides/METHODOLOGY.md) for the composable design model
- Read [Appendix I](guides/APPENDIX-I.md) for configuration details

## Conquer Complexity: Embrace Composable Design

Software development is an ongoing battle against complexity. Over time, codebases can become tangled and unwieldy, hindering innovation and maintenance. Composable design patterns offer a path toward modular, maintainable, scalable applications by emphasizing self-contained functions and event-driven communication.

At its core, composable design emphasizes two principles:

1. Self-contained functions
2. Event choreography

That combination improves maintainability, reusability, throughput, debugging, and testing while allowing you to use your preferred frameworks and tools inside each composable task.
