# Composable Backend v2 — Breaking Changes Plan

## Guiding principle

Every change must make the **user's code** simpler. If a change only improves framework internals but doesn't reduce user boilerplate, it's not worth the breaking change.

## Migration strategy

v2 is a **new major version** in the same repo. Users upgrade by changing their dependency version and following a migration guide. The v1 API (`EventEnvelope`, `defineComposable`, `PostOffice`, `AppException`, `Logger`) continues to work in v2 via a compatibility layer during a transition period.

---

## Phase 1: Typed handlers (biggest user impact)

**Goal:** Tasks receive typed input directly, not EventEnvelope.

### Change defineComposable signature

```typescript
// v1 (current)
defineComposable({
  process: 'v1.lead.score',
  handler: async (evt: EventEnvelope) => {
    const body = evt.getBody() as Record<string, unknown>;
    return { score: 85 };
  },
});

// v2 (new)
defineComposable({
  process: 'v1.lead.score',
  input: z.object({ email: z.string(), employees: z.number().optional() }),
  output: z.object({ score: z.number(), band: z.enum(['hot', 'warm', 'cold']) }),
  handler: async (input) => {
    // input is { email: string, employees?: number } — typed, validated, no casting
    return { score: 85, band: 'hot' };
  },
});
```

### What changes in the framework

| File | Change |
|---|---|
| `src/models/composable.ts` | Add `input` and `output` schema fields to `DefineComposableOptions`. When both `input` schema and `handler` accept typed input, the handler receives parsed input directly instead of EventEnvelope |
| `src/system/platform.ts` | ServiceManager unwraps EventEnvelope body, runs input schema, passes parsed input to handler, wraps result back into EventEnvelope |
| `src/automation/task-executor.ts` | After input mapping, pass mapped data directly to handler (not wrapped in EventEnvelope) |

### Backward compatibility

The v1 `handler: async (evt: EventEnvelope) => {}` signature still works. Detection: if `input` schema is not defined, the handler receives EventEnvelope (v1 mode). If `input` schema is defined, the handler receives typed input (v2 mode).

### Files affected in user apps

- Every `*.task.ts` file — optional migration (v1 handlers still work)
- Tests — `testTask()` already works with both signatures

### Effort: Medium
### Risk: Low (additive, backward compatible)

---

## Phase 2: Simplified flow YAML

**Goal:** Less boilerplate in flow definitions.

### Simplified syntax

```yaml
# v1 (current)
flow:
  id: 'process-lead'
  description: 'Process a lead'
  ttl: 10s
  exception: 'v1.lead.exception'

first.task: 'validate'

tasks:
  - name: 'validate'
    input:
      - 'input.body -> *'
    process: 'v1.lead.validate'
    output:
      - 'result -> model.lead'
    description: 'Validate the lead'
    execution: sequential
    next:
      - 'score'

  - name: 'score'
    input:
      - 'model.lead.email -> email'
    process: 'v1.lead.score'
    output:
      - 'result -> output.body'
    description: 'Score the lead'
    execution: end

# v2 (new)
flow: process-lead
ttl: 10s
exception: v1.lead.exception

tasks:
  - validate:
      process: v1.lead.validate

  - score:
      process: v1.lead.score
      input:
        email: model.lead.email
      respond: true
```

### Simplification rules

| v1 | v2 | Rule |
|---|---|---|
| `flow.id: 'name'` | `flow: name` | Flatten |
| `flow.description: '...'` | *(removed)* | Optional, rarely useful at runtime |
| `first.task: 'name'` | *(implicit)* | First task in list is always first |
| `execution: sequential` | *(implicit)* | Sequential is the default |
| `execution: end` | `respond: true` or *(implicit for last task)* | Last task is always end |
| `next: ['task2']` | *(implicit)* | Next task in list is the default next |
| `- name: 'task1'` | `- task1:` | Task name is the key |
| `'input.body -> *'` | *(implicit)* | When input schema exists, body is passed automatically |
| `'result -> output.body'` | `respond: true` | Shorthand for response mapping |
| `'model.x -> y'` | `input: { y: model.x }` | Object syntax instead of arrow |

### What changes in the framework

| File | Change |
|---|---|
| `src/automation/compile-flows.ts` | Support both v1 and v2 YAML syntax. Detect by checking if `flow` is a string (v2) or object (v1). Parse v2 syntax into the same internal `Flow` and `Task` objects |

### Backward compatibility

v1 YAML syntax continues to work unchanged. The compiler detects the format and parses accordingly.

### Effort: Medium
### Risk: Low (additive, both formats work)

---

## Phase 3: Kill singletons

**Goal:** No global state. Multiple instances in tests. Embeddable.

### Current singletons

| Singleton | Why it's a problem |
|---|---|
| `Platform.getInstance()` | Can't run two apps in same process, can't isolate tests |
| `AppConfig.getInstance()` | Shared config across all tests |
| `FunctionRegistry.getInstance()` | Shared route registry |
| `RestAutomation.getInstance()` | One HTTP server per process |
| `Logger.getInstance()` | Shared log level |

### New API

```typescript
// v2 — no singletons
import { createApp } from 'composable-backend';

const app = createApp({
  config: 'src/config',
  port: 8086,
});

await app.scan('src/');
await app.start();

// In tests — isolated instances
const testApp = createApp({ config: 'tests/config' });
await testApp.scan('src/tasks/');
const result = await testApp.call('v1.lead.score', { email: 'ada@test.com' });
```

### What changes in the framework

| File | Change |
|---|---|
| `src/system/platform.ts` | Remove singleton. `createApp()` returns a new `App` instance with its own EventEmitter, registry, and config |
| `src/util/config-reader.ts` | Remove AppConfig singleton. Config is owned by the App instance |
| `src/system/rest-automation.ts` | Remove singleton. HTTP server is owned by the App instance |
| `src/system/function-registry.ts` | Remove singleton. Registry is owned by the App instance |
| `src/composable.ts` | `composable()` creates an App instance internally (sugar over createApp) |

### Backward compatibility

`composable()` still works (creates a default App internally). `Platform.getInstance()` and `AppConfig.getInstance()` continue to work but are deprecated — they return the default App's platform and config.

### Effort: High
### Risk: Medium (internal refactor, but external API stays compatible via composable())

---

## Phase 4: Replace Express

**Goal:** Faster HTTP, runtime-agnostic, WebSocket-ready.

### Options

| Option | Pros | Cons |
|---|---|---|
| **Hono** | Multi-runtime (Node, Bun, Deno, Edge), fast, tiny | Smaller middleware ecosystem |
| **Native http.createServer()** | Zero dependencies, full control | Must build routing/middleware from scratch |
| **Fastify** | Fastest on Node, mature plugins | Node-only, heavier than Hono |

### Recommendation: Hono

- Runs everywhere (Node, Bun, Cloudflare Workers, Lambda)
- 15KB bundle vs Express 200KB
- Native WebSocket support
- TypeScript-first
- The framework already abstracts HTTP via rest-automation — users never touch the server directly

### What changes in the framework

| File | Change |
|---|---|
| `src/system/rest-automation.ts` | Replace Express with Hono. Same YAML parsing, same routing logic, different HTTP engine |
| `package.json` | Remove express, body-parser, cookie-parser, busboy. Add hono |

### Backward compatibility

`rest.yaml` format unchanged. `setupMiddleWare()` removed (Hono uses a different middleware model). Users who imported Express types directly need to update.

### Effort: High
### Risk: Medium (rest-automation is well-encapsulated)

---

## Phase 5: Replace msgpackr with structuredClone

**Goal:** Faster in-process serialization, keep binary for network.

### Current flow

```
send(event) → event.toBytes() [msgpackr serialize] → emit → new EventEnvelope(bytes) [msgpackr deserialize]
```

### v2 flow

```
send(event) → structuredClone(event) → emit → received directly (already a fresh copy)
```

### What changes

| File | Change |
|---|---|
| `src/system/post-office.ts` | Use `structuredClone()` instead of `toBytes()`/`fromBytes()` for in-process events |
| `src/models/event-envelope.ts` | Keep `toBytes()`/`fromBytes()` for network transport (event-over-HTTP, Kafka) |

### Effort: Low
### Risk: Low (behavioral change is transparent)

---

## Phase 6: Simplified config

**Goal:** 3-line application.yml.

### Current config (10+ lines)

```yaml
application.name: 'my-service'
info.app:
  version: '0.1.0'
  description: 'My service'
server.port: ${SERVER_PORT:8086}
environment: ${ENVIRONMENT:development}
rest.automation: true
log.format: 'text'
log.level: ${LOG_LEVEL:info}
yaml.rest.automation: 'classpath:/rest.yaml'
```

### v2 config (3 lines)

```yaml
name: my-service
port: ${SERVER_PORT:8086}
log: ${LOG_LEVEL:info}
```

### Convention-over-configuration rules

| v1 config key | v2 behavior |
|---|---|
| `application.name` | `name` (shortened) |
| `server.port` | `port` (shortened) |
| `log.level` | `log` (shortened) |
| `log.format` | Default `text` in dev, `compact` in production (auto-detect) |
| `rest.automation` | Always on if `rest.yaml` exists |
| `yaml.rest.automation` | Always `rest.yaml` in the config directory |
| `info.app.version` | Read from `package.json` automatically |
| `info.app.description` | Read from `package.json` automatically |
| `environment` | Read from `ENVIRONMENT` env var |

### Backward compatibility

v1 config keys still work. The framework checks for `name` first, falls back to `application.name`.

### Effort: Low
### Risk: Low (additive, old keys still work)

---

## Implementation order

| Phase | What | Effort | Risk | Dependency |
|---|---|---|---|---|
| 1 | Typed handlers | Medium | Low | None |
| 2 | Simplified flow YAML | Medium | Low | None |
| 6 | Simplified config | Low | Low | None |
| 5 | structuredClone | Low | Low | None |
| 3 | Kill singletons | High | Medium | After 1, 2, 6 |
| 4 | Replace Express | High | Medium | After 3 |

Phases 1, 2, 6, and 5 can be done **in the current v1 codebase** as backward-compatible additions. Users can adopt them incrementally.

Phases 3 and 4 are true breaking changes that require a v2 major version bump.

### Timeline estimate

| Phase | Duration |
|---|---|
| 1 + 2 + 5 + 6 (backward compatible) | 1 release cycle |
| 3 (kill singletons) | 1 release cycle |
| 4 (replace Express) | 1 release cycle |
| Migration guide + testing + docs | 1 release cycle |

---

## What the user sees at the end

### main.ts
```typescript
import { composable } from 'composable-backend';

await composable();
```

### task file
```typescript
import { defineComposable } from 'composable-backend';
import { z } from 'zod';

export default defineComposable({
  process: 'v1.lead.score',
  input: z.object({ email: z.string() }),
  output: z.object({ score: z.number(), band: z.string() }),
  handler: async (input) => {
    return { score: 85, band: 'hot' };
  },
});
```

### flow file
```yaml
flow: process-lead
ttl: 10s
tasks:
  - validate:
      process: v1.lead.validate
  - score:
      process: v1.lead.score
      respond: true
```

### test file
```typescript
import leadScore from '../src/tasks/lead-score.task.js';

it('scores correctly', async () => {
  const result = await leadScore.handler({ email: 'ada@company.com' });
  expect(result).toEqual({ score: 85, band: 'hot' });
});
```

### config
```yaml
name: my-service
port: 8086
log: info
```

Zero boilerplate. Every file has only user-authored content.
