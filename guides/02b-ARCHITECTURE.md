# How the Framework Works

This guide traces how an HTTP request flows through the framework, from Express to your composable function and back. Understanding these layers will help you debug, optimize, and extend your applications.

## The 4 layers

```
HTTP Request
    ↓
┌─────────────────────────────┐
│  1. REST Automation         │  Express server, routes from rest.yaml
│     rest-automation.ts      │  Converts HTTP → EventEnvelope
└──────────┬──────────────────┘
           ↓
┌─────────────────────────────┐
│  2. PostOffice / EventBus   │  Node.js EventEmitter
│     post-office.ts          │  Routes events by name, RPC, fire-and-forget
└──────────┬──────────────────┘
           ↓
┌─────────────────────────────┐
│  3. Flow Engine             │  YAML → compiled task graph
│     event-script-manager.ts │  Orchestrates task sequence, manages state machine
│     task-executor.ts        │
└──────────┬──────────────────┘
           ↓
┌─────────────────────────────┐
│  4. Composable Functions    │  Your code
│     *.task.ts               │  Pure: EventEnvelope in → result out
└─────────────────────────────┘
```

## Tracing a request step by step

Let's trace `POST /api/leads` with body `{ "firstName": "Ada" }` through the entire system.

### Step 1: Express receives the HTTP request

`rest-automation.ts` has an Express middleware that catches every request. It looks up the URL + method in the routing table (parsed from `rest.yaml`):

```yaml
# rest.yaml
- service: 'http.flow.adapter'
  methods: ['POST']
  url: '/api/leads'
  flow: 'process-lead'
  timeout: 10s
  authentication: 'v1.api.auth'
  tracing: true
```

It finds a match: service=`http.flow.adapter`, flow=`process-lead`, auth=`v1.api.auth`.

### Step 2: Authentication (if configured)

The REST engine creates an `AsyncHttpRequest` object wrapping the raw HTTP request (method, URL, headers, body, path params, query params) and sends it to the auth service via PostOffice RPC:

```
PostOffice.request(
  EventEnvelope { to: 'v1.api.auth', body: AsyncHttpRequest }
)
```

The auth composable (`v1.api.auth`) receives it, validates the token, returns `true` or `false`. If `false` → HTTP 401 immediately.

### Step 3: Event enters the flow engine

After auth passes, the REST engine sends the request to `http.flow.adapter`, which converts it and forwards to `event.script.manager`:

```
EventEnvelope {
  to: 'event.script.manager',
  header: { flow_id: 'process-lead' },
  body: { body: { firstName: 'Ada' }, header: { ... } }
}
```

### Step 4: Flow engine creates a flow instance

`event-script-manager.ts` receives the event. It:

1. Looks up flow `process-lead` in the compiled flow registry
2. Creates a new `FlowInstance` with a unique ID and an empty **state machine** (the `model` namespace)
3. Reads `first.task` from the flow definition
4. Sends the event to `task.executor` with the task name

### Step 5: Task executor runs each task

`task-executor.ts` receives the event. For each task it:

**Input mapping** — Reads the flow's `input:` section and maps data:
```yaml
input:
  - 'input.body.firstName -> firstName'
  - 'input.body.email -> email'
```
This extracts `firstName` and `email` from the HTTP body into a new object.

**Calls the composable** — Sends an EventEnvelope to the task's `process` route via the in-memory EventEmitter:
```
emitter.emit('v1.lead.normalize', envelope.toBytes())
```

**Your code runs** — Your `*.task.ts` handler receives the envelope, does its work, returns a result.

**Output mapping** — Takes the result and maps it into the state machine and/or response:
```yaml
output:
  - 'result.contact -> model.contact'
  - 'result.company -> model.company'
```

**Routes to next task** — Based on `execution` type:
- `sequential` → sends to the next task
- `decision` → evaluates the `decision` variable, picks a branch
- `parallel` → sends to all next tasks simultaneously
- `end` → flow is done, return result to caller

### Step 6: Response returns

When the last task has `execution: end`:
1. The `output.body` from output mapping becomes the response
2. It's sent to `async.http.response`
3. The Express `res` object writes the HTTP response
4. The client receives the JSON

## The key objects

### EventEnvelope

The universal transport. Every message between composables is an EventEnvelope:

```typescript
{
  id: 'uuid',              // unique per event
  to: 'v1.lead.score',     // destination route
  from: 'task.executor',   // who sent it
  body: { ... },           // payload
  headers: { ... },        // metadata
  status: 200,             // HTTP status
  traceId: 'abc',          // transaction ID (same across entire request chain)
  correlationId: 'xyz',    // links request → response in RPC
}
```

Serialized to binary (msgpackr) when passing between composables for immutability.

### PostOffice

The message router. Three modes:

```typescript
// Fire-and-forget
await po.send(envelope);

// RPC (waits for response with timeout)
const response = await po.request(envelope, 5000);

// Convenience — wraps the above
const result = await po.call('v1.lead.score', { data: 'hello' }, 5000);
```

Under the hood: `send()` calls `emitter.emit(route, envelope.toBytes())`. `request()` creates a temporary inbox, sets `replyTo` on the envelope, and waits for a response on that inbox.

### Platform

The service registry. Manages composable lifecycle:

```typescript
platform.register('v1.lead.score', composable, 10, 'private');
//                  route name      handler   instances  visibility
```

Each composable gets N worker instances. When an event arrives, the `ServiceManager` picks an available worker and dispatches. If all workers are busy, events queue up.

### State machine (model)

Each flow instance has its own `model` — a key-value store that persists across tasks within one transaction:

```yaml
# Task 1 output — writes to model
output:
  - 'result.contact -> model.contact'

# Task 2 input — reads from model
input:
  - 'model.contact.email -> email'
```

This is how tasks communicate without knowing about each other. Task 1 writes to `model.contact`, Task 2 reads from `model.contact`. Neither imports the other.

## The concurrency model

```
                    ServiceManager ('v1.lead.score')
                           │
              ┌────────────┼────────────┐
              ↓            ↓            ↓
         Worker #1    Worker #2    Worker #3
         (busy)       (available)  (busy)
                           ↑
                      next event goes here
```

- Each composable has N workers (set by `instances` in `defineComposable()`)
- Workers process one event at a time
- When a worker finishes, it signals "READY" and gets the next queued event
- This is single-threaded (Node.js event loop) but concurrent via async/await
- Set higher `instances` for tasks that make slow I/O calls (database, HTTP)

## What makes it composable

The design enforces isolation:

1. **No imports between tasks** — tasks never `import` each other
2. **Communication only via events** — PostOffice is the only way to talk
3. **State via model, not shared memory** — the flow's state machine passes data between tasks
4. **Input/output mapping in YAML** — the flow config decides what data each task sees
5. **File convention** — `*.task.ts` and `*.flow.yml` are self-contained units

This means you can:
- Test any task in isolation with `testTask(myTask, input)`
- Replace a task without touching other tasks
- Reorder tasks by editing YAML, not code
- Run tasks in parallel by changing `execution: sequential` to `execution: parallel`
- Deploy the same task in multiple flows without code duplication

<br/>

|                Previous                  |                   Home                    |                     Next                          |
|:----------------------------------------:|:-----------------------------------------:|:-------------------------------------------------:|
| [Getting Started](02-GETTING-STARTED.md) | [Table of Contents](TABLE-OF-CONTENTS.md) | [Composable Functions](03-COMPOSABLE-FUNCTIONS.md) |
