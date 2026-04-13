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

```bash
npm install @composable-backend/kafka kafkajs
```

### Minimal Project

```text
your-app/
  src/
    hello-world.task.ts       ← auto-discovered by convention
    config/
      preload.ts
      application.yml
```

### Minimal Config

Create `src/config/application.yml`:

```yaml
application.name: 'quickstart-demo'
log.level: 'info'
rest.automation: false
```

### Minimal Function

Create `src/hello-world.task.ts`:

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

Create `src/config/preload.ts`:

```ts
import { fileURLToPath } from 'url';
import { AppConfig, Platform } from 'composable-backend';

function getRootFolder(): string {
  const folder = fileURLToPath(new URL('.', import.meta.url));
  return folder.includes('\\') ? folder.replaceAll('\\', '/') : folder;
}

export class ComposableLoader {
  static async initialize(): Promise<void> {
    const configDir = getRootFolder();
    AppConfig.getInstance(configDir + 'resources');

    const platform = Platform.getInstance();
    await platform.autoScan(configDir + '..');

    platform.runForever();
    await platform.getReady();
  }
}
```

Create `src/main.ts`:

```ts
import { ComposableLoader } from './config/preload.js';

ComposableLoader.initialize().catch(error => {
  console.error(error);
  process.exit(1);
});
```

### Dev Mode

Add to `package.json`:

```json
{
  "scripts": {
    "dev": "tsx watch src/main.ts",
    "build": "tsc",
    "start": "node dist/main.js"
  }
}
```

`npm run dev` runs directly from source with instant restart on file changes. No build step needed during development.

### Example Request

Send an in-memory RPC request to your composable with `PostOffice`:

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
import helloWorld from '../src/hello-world.task.js';

function getResourcePath() {
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, '../src/config');
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

## File Conventions

The framework uses file naming conventions to auto-discover tasks and flows:

| Convention | What it does |
|---|---|
| `*.task.ts` | Auto-registered as a composable function (must default-export a `defineComposable()`) |
| `*.flow.yml` | Auto-loaded as a flow definition |

Place them **anywhere** inside `src/`. The scanner searches recursively — organize by feature, domain, or however you prefer:

```text
src/
  leads/
    lead-score.task.ts
    lead-validate.task.ts
    process-lead.flow.yml
  orders/
    order-process.task.ts
    process-order.flow.yml
  config/
    preload.ts
    application.yml
    rest.yaml
```

Or flat:

```text
src/
  lead-score.task.ts
  process-lead.flow.yml
  config/...
```

Both work. The scanner finds every `*.task.ts` and `*.flow.yml` under `src/` regardless of folder structure.

### Auto-scan from libraries

Libraries listed in `web.component.scan` are also scanned for `*.task.js` and `*.flow.yml` files:

```yaml
# application.yml
web.component.scan: 'my-composable-library'
```

### Manual registration

You can still register composables manually alongside auto-scan. This is needed for external packages that don't follow the naming convention:

```ts
import { KafkaAdapter, KafkaNotification } from '@composable-backend/kafka';

await platform.autoScan(srcDir);
platform.registerComposable(KafkaAdapter);
platform.registerComposable(KafkaNotification);
```

## Two Authoring Styles

### Function Style (recommended)

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

Class-style composables are registered manually:

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

- Read [Getting Started](guides/02-GETTING-STARTED.md) for a broader walkthrough
- Read [Composable Functions](guides/03-COMPOSABLE-FUNCTIONS.md) for function authoring patterns
- Read [REST Automation](guides/04-REST-AUTOMATION.md) for HTTP endpoint configuration
- Read [Event Scripting](guides/05-EVENT-SCRIPTING.md) for flow orchestration
- Read [Platform and PostOffice](guides/06-PLATFORM-AND-POSTOFFICE.md) for core APIs
- Read [Kafka Integration](guides/08-KAFKA-INTEGRATION.md) for Kafka setup
- Read [Methodology](guides/01-METHODOLOGY.md) for the composable design model
- Read [Configuration Reference](guides/APPENDIX-CONFIGURATION.md) for all config parameters
- Read [API Reference](guides/APPENDIX-API-REFERENCE.md) for all API methods
