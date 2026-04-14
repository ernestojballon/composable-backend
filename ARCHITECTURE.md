# Architecture Map

How the source code is organized and how the pieces connect.

## Request flow

```
HTTP Request → rest-automation.ts → post-office.ts → event-script-manager.ts → task-executor.ts → your *.task.ts
                                                                                                       ↓
HTTP Response ← rest-automation.ts ← post-office.ts ← event-script-manager.ts ← task-executor.ts ← result
```

## Source map

### `src/system/` — Core runtime

| File | What it does | Key method |
|---|---|---|
| `platform.ts` | Service registry, lifecycle, worker management, autoScan | `register()`, `autoScan()`, `stop()` |
| `post-office.ts` | Event routing — send, RPC, broadcast | `send()`, `request()`, `call()` |
| `rest-automation.ts` | Express HTTP server, maps rest.yaml to composables | `start()`, `stop()` |
| `function-registry.ts` | Stores registered routes and metadata | `exists()`, `getClass()` |
| `local-pubsub.ts` | Topic-based pub/sub on top of PostOffice | `createTopic()`, `subscribe()`, `publish()` |
| `object-stream.ts` | Temporary file-based streaming for large payloads | `ObjectStreamIO`, `ObjectStreamWriter`, `ObjectStreamReader` |

### `src/automation/` — Flow engine

| File | What it does | Key method |
|---|---|---|
| `compile-flows.ts` | Parses flow YAML into executable task graphs | `start()`, `loadFlowsFromDirectory()` |
| `event-script-manager.ts` | Creates flow instances, starts first task | Route: `event.script.manager` |
| `task-executor.ts` | Runs input mapping → composable → output mapping → next task | Route: `task.executor` |

### `src/models/` — Data structures and contracts

| File | What it does | User-facing? |
|---|---|---|
| `event-envelope.ts` | Universal message transport (body, headers, trace, status) | Yes — you create and inspect these |
| `composable.ts` | `defineComposable()`, `Composable` interface, `@preload`, `Validator` | Yes — you use these to write tasks |
| `async-http-request.ts` | Wraps HTTP request data (method, URL, headers, body, params) | Yes — your auth tasks receive these |
| `app-exception.ts` | Typed error with HTTP status code | Yes — you throw these |
| `flow.ts` | Compiled flow definition (id, ttl, first task) | No — internal |
| `flows.ts` | Static registry of all compiled flows | No — internal |
| `flow_instance.ts` | Runtime flow instance with state machine (model) | No — internal |
| `task.ts` | Compiled task definition (name, process, mappings, execution type) | No — internal |
| `pipe.ts` | Pipeline state for loop constructs | No — internal |
| `var-segment.ts` | Variable substitution parser | No — internal |

### `src/services/` — Built-in composable services

| File | Route name | What it does |
|---|---|---|
| `tracer.ts` | `distributed.tracing` | Logs exec_time, round_trip, trace IDs for every event |
| `rate-limiter.ts` | *(used by rest-automation)* | Sliding window rate limiting per endpoint |
| `resilience-handler.ts` | *(used in flows)* | Retry with backoff, alternative routing |
| `actuator.ts` | `info.*`, `health.*`, `env.*`, `liveness.*` | Health checks, app info, route listing |
| `event-api.ts` | `event.api.service` | Binary event-over-HTTP endpoint (POST /api/event) |
| `async-http-client.ts` | `async.http.request` | Outbound HTTP client for calling external APIs |
| `temporary-inbox.ts` | `temporary.inbox` | Resolves RPC promises when responses arrive |
| `no-op.ts` | `no.op` | Echo function — returns whatever it receives |

### `src/adapters/` — Transport bridges

| File | Route name | What it does |
|---|---|---|
| `http-to-flow.ts` | `http.flow.adapter` | Converts HTTP request → flow event |
| `flow-executor.ts` | *(programmatic)* | Run flows from code instead of HTTP |

### `src/util/` — Utilities

| File | What it does |
|---|---|
| `config-reader.ts` | AppConfig singleton, YAML loading, `${ENV_VAR:default}` resolution, classpath discovery |
| `logger.ts` | Structured logging (text, json, compact formats) |
| `routing.ts` | REST route parsing, URL matching, path parameters, wildcards |
| `utility.ts` | UUID, duration parsing, Levenshtein distance, YAML loading, file helpers |
| `crypto-api.ts` | AES-256-GCM encryption/decryption |
| `multi-level-map.ts` | Dot-bracket access for nested objects (`body.items[0].name`) |
| `content-type-resolver.ts` | MIME type mapping for file extensions |
| `event-http-resolver.ts` | Maps routes to remote HTTP endpoints |
| `ts-class-scanner.ts` | Scans TypeScript files for `@preload` and `defineComposable()` |
| `js-class-scanner.ts` | Scans compiled JavaScript files for composables |
| `template-loader.ts` | Loads file templates from resources folder |

### Root

| File | What it does |
|---|---|
| `composable.ts` | `composable()` — the single entry point that starts everything |
| `index.ts` | Public API exports |

## How the pieces connect

```
composable()
  │
  ├─→ AppConfig (config-reader.ts)
  │     └─→ loads application.yml, rest.yaml
  │
  ├─→ Platform (platform.ts)
  │     ├─→ FunctionRegistry — stores all routes
  │     ├─→ autoScan — discovers *.task.ts and *.flow.yml
  │     └─→ ServiceManager — worker pool per composable
  │           └─→ EventEmitter (Node.js) — the message bus
  │
  ├─→ EventScriptEngine (event-script-manager.ts)
  │     ├─→ CompileFlows — parses YAML into task graphs
  │     ├─→ TaskExecutor — runs input mapping → task → output mapping
  │     └─→ HttpToFlow — bridges HTTP adapter to flows
  │
  └─→ RestAutomation (rest-automation.ts)
        ├─→ RoutingEntry — parsed rest.yaml routes
        ├─→ RateLimiter — per-endpoint throttling
        ├─→ ActuatorServices — /health, /info, /env
        └─→ Express.listen(port)
```
