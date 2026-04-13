# Kafka Integration

The `@composable-backend/kafka` package provides a first-party Kafka companion for composable-backend.
It abstracts away Kafka complexity with declarative YAML-based configuration and seamless integration
with the event-driven architecture.

## Install

```bash
npm install @composable-backend/kafka
```

Peer dependencies: `composable-backend` (^1.1.0) and `kafkajs` (^2.2.4).

## Configure application.yml

Add the Kafka adapter to your autostart and autostop modules:

```yaml
modules.autostart:
  - 'kafka.adapter'

modules.autostop:
  - 'kafka.adapter'
```

## Configure kafka-adapter.yaml

Place this file in your `resources` folder. Each consumer entry routes incoming Kafka messages
to a composable-backend flow. Each producer entry declares a topic you can publish to.

```yaml
consumer:
  - broker: 'localhost:9092'
    topic: 'leads.scored'
    flow: 'process-lead'
    group: 'lead-workflow-internal'
    tracing: true

producer:
  - broker: 'localhost:9092'
    topic: 'leads.scored'
```

### Consumer entry fields

| Field     | Required | Description                                              |
|:----------|:---------|:---------------------------------------------------------|
| broker    | Yes      | Kafka broker address(es), comma-separated for clusters   |
| topic     | Yes      | Kafka topic to consume from                              |
| flow      | Yes      | Flow ID to route incoming messages to                    |
| group     | Yes      | Consumer group ID                                        |
| tracing   | No       | Enable distributed tracing (default false)               |
| ssl       | No       | Enable SSL/TLS (default false)                           |
| sasl      | No       | SASL authentication config (see below)                   |

### Producer entry fields

| Field     | Required | Description                                              |
|:----------|:---------|:---------------------------------------------------------|
| broker    | Yes      | Kafka broker address(es), comma-separated for clusters   |
| topic     | Yes      | Kafka topic to publish to                                |
| ssl       | No       | Enable SSL/TLS (default false)                           |
| sasl      | No       | SASL authentication config (see below)                   |

## Register in preload

```typescript
import { KafkaAdapter, KafkaNotification } from '@composable-backend/kafka';

platform.registerComposable(KafkaAdapter);
platform.registerComposable(KafkaNotification);
```

## Define the flow

Create a flow YAML in your `resources/flows/` directory to handle incoming messages:

```yaml
flow:
  id: 'process-lead'
  description: 'Handle incoming scored leads'
  ttl: 10s

first.task: 'handle.lead'

tasks:
  - name: 'handle.lead'
    input:
      - 'input.body -> *'
      - 'input.header.topic -> header.topic'
    process: 'v1.lead.log-scored'
    output:
      - 'result -> output.body'
    description: 'Process the lead'
    execution: end
```

## Publish from any task

Use `PostOffice` to send messages to Kafka topics:

```typescript
const req = new EventEnvelope()
    .setTo('kafka.notification')
    .setHeader('topic', 'leads.scored')
    .setBody({ content: myPayload });

const po = new PostOffice();
await po.send(req);
```

The broker is resolved from the `producer` section in `kafka-adapter.yaml`. You can override
it per-request with a `broker` header:

```typescript
const req = new EventEnvelope()
    .setTo('kafka.notification')
    .setHeader('broker', 'kafka-prod:9092')
    .setHeader('topic', 'notifications.email')
    .setBody({ content: myPayload });
```

## Consume messages

Write a normal composable task — the flow routes Kafka messages to it:

```typescript
export const handler = async (evt: EventEnvelope) => {
    const body = evt.getBody();
    log.info(JSON.stringify(body, null, 2));
    return body;
};

export default defineComposable({
    process: 'v1.lead.log-scored',
    handler,
    instances: 10,
});
```

## SSL/SASL authentication

Add `ssl` and `sasl` per entry to connect to secured brokers:

```yaml
consumer:
  - broker: 'kafka-prod:9093'
    topic: 'leads.scored'
    flow: 'process-lead'
    group: 'lead-workflow-internal'
    ssl: true
    sasl:
      mechanism: 'scram-sha-256'
      username: 'my-user'
      password: 'my-pass'

producer:
  - broker: 'kafka-prod:9093'
    topic: 'notifications.email'
    ssl: true
    sasl:
      mechanism: 'scram-sha-256'
      username: 'my-user'
      password: 'my-pass'
```

Supported SASL mechanisms: `plain`, `scram-sha-256`, `scram-sha-512`.

## Independent consumer and producer clusters

Consumer and producer configurations are fully independent — even for the same topic.
Each side resolves its own broker addresses and security credentials, so you can consume
from one cluster and produce to another:

```yaml
consumer:
  - broker: 'cluster-a:9092'
    topic: 'events'
    flow: 'process-events'
    group: 'my-group'
    ssl: true
    sasl:
      mechanism: 'scram-sha-256'
      username: 'reader'
      password: 'reader-secret'

producer:
  - broker: 'cluster-b:9093'
    topic: 'events'
    ssl: true
    sasl:
      mechanism: 'scram-sha-512'
      username: 'writer'
      password: 'writer-secret'
```

In this example, incoming `events` messages are consumed from `cluster-a` with one set of
credentials, while publishing to `events` goes to `cluster-b` with a different mechanism
and user. Brokers, SSL, and SASL are resolved independently per direction.

## Kafka emulator

For unit tests, you can emulate Kafka without a real broker by setting `emulate.kafka`
in application.yml:

```yaml
emulate.kafka: true
```

The emulator uses an in-memory EventEmitter instead of real Kafka. It provides a single
partition per topic and is not a replacement for a real broker — it is designed for testing only.

## Docker setup

For local development with a real Kafka broker, use Docker Compose:

```yaml
services:
  kafka:
    image: apache/kafka:latest
    ports:
      - '9092:9092'
    environment:
      KAFKA_NODE_ID: 1
      KAFKA_PROCESS_ROLES: broker,controller
      KAFKA_LISTENERS: PLAINTEXT://0.0.0.0:9092,CONTROLLER://0.0.0.0:9093
      KAFKA_ADVERTISED_LISTENERS: PLAINTEXT://localhost:9092
      KAFKA_CONTROLLER_QUORUM_VOTERS: 1@localhost:9093
      KAFKA_CONTROLLER_LISTENER_NAMES: CONTROLLER
      KAFKA_LISTENER_SECURITY_PROTOCOL_MAP: CONTROLLER:PLAINTEXT,PLAINTEXT:PLAINTEXT
```

<br/>

|                  Previous                    |                   Home                    |                       Next                       |
|:--------------------------------------------:|:-----------------------------------------:|:------------------------------------------------:|
| [Event over HTTP](07-EVENT-OVER-HTTP.md)     | [Table of Contents](TABLE-OF-CONTENTS.md) | [Custom Flow Adapters](09-CUSTOM-FLOW-ADAPTERS.md) |
