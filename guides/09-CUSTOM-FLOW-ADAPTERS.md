# Custom Flow Adapters

## What is a Flow Adapter?

> Figure 1 - Event Flow Diagram

![Event Flow Diagram](./diagrams/event-flow-diagram.png)

A transaction flow has a start point and an end point. Each processing step is a "task" — a composable
function that is independent of the others. The system uses a YAML "flow" configuration to connect tasks
together for a given use case.

A **Flow Adapter** is the gateway between the external world and the internal event flow system.
It converts an inbound request (HTTP, Kafka, WebSocket, AMQP, etc.) into an event that enters
the flow, and converts the flow's result back into an outbound response.

## Built-in HTTP Flow Adapter

The system includes an HTTP Flow Adapter (`http.flow.adapter`) that converts REST requests into events
routed to the first task of a flow. When the flow finishes, the last task's result is returned as an
HTTP response.

This is configured in `rest.yaml` using the `flow` parameter:

```yaml
rest:
  - service: "http.flow.adapter"
    methods: ['GET']
    url: "/api/greetings/{user}"
    flow: 'greetings'
    timeout: 10s
    tracing: true
```

## Built-in Kafka Flow Adapter

The `@composable-backend/kafka` package provides a Kafka Flow Adapter that routes Kafka messages
to flows. See [Kafka Integration](08-KAFKA-INTEGRATION.md) for full details.

## Writing your own Flow Adapter

Any transport protocol can be integrated by following this pattern:

1. **Receive the inbound message** from your transport (WebSocket frame, AMQP message, gRPC call, etc.)
2. **Create an EventEnvelope** with the message payload and route it to `event.script.manager` with a `flow_id` header
3. **The flow engine executes** the configured tasks using the event data
4. **Collect the result** and send it back through your transport

### Adapter skeleton

```typescript
import { defineComposable, EventEnvelope, PostOffice } from 'composable-backend';

export default defineComposable({
  process: 'my.custom.adapter',
  instances: 10,
  handler: async (evt: EventEnvelope) => {
    const type = evt.getHeader('type');

    if (type === 'start') {
      // Initialize your transport connection (WebSocket server, AMQP consumer, etc.)
      // When a message arrives from your transport:
      //
      //   const flowEvent = new EventEnvelope()
      //     .setTo('event.script.manager')
      //     .setHeader('flow_id', 'my-flow-name')
      //     .setBody({ body: messagePayload, header: { /* extra context */ } });
      //   await new PostOffice().send(flowEvent);
      //
      return null;
    }

    if (type === 'stop') {
      // Clean up your transport connection
      return null;
    }

    return null;
  },
});
```

Register the adapter in your preload and add it to `modules.autostart` / `modules.autostop`
in application.yml for lifecycle management.

### Key considerations

- **Lifecycle**: Use the `type: start` / `type: stop` headers from autostart/autostop to manage
  connection lifecycle.
- **Tracing**: Propagate `traceId`, `tracePath`, and `correlationId` from inbound messages into
  the EventEnvelope to preserve distributed tracing across transports.
- **Concurrency**: Set an appropriate `instances` count based on your transport's throughput needs.
- **Error handling**: Wrap transport interactions in try/catch and use the framework's Logger
  for consistent error reporting.

### Functional isolation with worker threads

For complex or resource-intensive libraries (e.g., a gRPC server, a proprietary SDK), you can
isolate them in a Node.js worker thread to prevent them from affecting the main event loop.

The `kafka.adapter` and `kafka.notification` composables in `@composable-backend/kafka` demonstrate
this pattern. See the [Node.js Worker Thread documentation](https://nodejs.org/api/worker_threads.html)
for details.

<br/>

|                      Previous                    |                   Home                    |                       Next                       |
|:------------------------------------------------:|:-----------------------------------------:|:------------------------------------------------:|
| [Kafka Integration](08-KAFKA-INTEGRATION.md)     | [Table of Contents](TABLE-OF-CONTENTS.md) | [Build, Test and Deploy](10-BUILD-TEST-DEPLOY.md) |
