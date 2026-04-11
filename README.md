# Composable Backend

A composable backend framework for building event-driven microservices and serverless applications
in Node.js.

This project is a derivative work based on
[Mercury Composable for Node.js](https://github.com/Accenture/mercury-nodejs),
originally developed by Accenture. See [NOTICE](NOTICE) for full attribution.

The source code is provided under the Apache 2.0 license.

# Optimized for Human

Composability methodology provides a clear path from Domain Driven Design (DDD), Event Driven Architecture (EDA)
to application software design and implementation, connecting product managers, domain knowledge owners,
architects and engineers together to deliver high quality products.

# Optimized for AI

Composable methodology reduces the problem space for AI code assistant because each function is self-contained,
independent and I/O is immutable.

In addition, the Event Script is a Domain Specific Language (DSL) that can be understood by AI agent with some
fine-tuning, thus making the whole ecosystem AI friendly.

# Getting Started

A composable application is designed in 3 steps:

1. Describe your use case as an event flow diagram
2. Create a configuration file to represent the event flow
3. Write a user story for each user function

To get started, please visit [Chapter 1, Developer Guide](guides/CHAPTER-1.md)
and [Methodology](guides/METHODOLOGY.md).

# Conquer Complexity: Embrace Composable Design

## Introduction

Software development is an ongoing battle against complexity. Over time, codebases can become tangled and unwieldy,
hindering innovation and maintenance. This article introduces composable design patterns, a powerful approach to
build applications that are modular, maintainable, and scalable.

## The Perils of Spaghetti Code

We have all encountered it: code that resembles a plate of spaghetti – tangled dependencies, hidden logic,
and a general sense of dread when approaching modifications. These codebases are difficult to test, debug,
and update. Composable design patterns offer a solution.

## Evolution of Design Patterns

Software development methodologies have evolved alongside hardware advancements. In the early days, developers
prized efficiency, writing code from scratch due to limited libraries. The rise of frameworks brought structure
and boilerplate code, but also introduced potential rigidity.

## Functional Programming and Event-Driven Architecture

Functional programming, with its emphasis on pure functions and immutable data, paved the way for composable design.
This approach encourages building applications as chains of well-defined functions, each with a clear input and output.

Event-driven architecture complements this approach by using events to trigger functions. This loose coupling
promotes modularity and scalability.

## The Power of Composable Design

At its core, composable design emphasizes two principles:

1. _Self-Contained Functions_: Each function is a well-defined unit, handling its own logic and transformations
   with minimal dependencies.
2. _Event Choreography_: Functions communicate through events, allowing for loose coupling and independent
   execution.

## Benefits of Composable Design

- _Enhanced Maintainability_: Isolated functions are easier to understand, test, and modify.
- _Improved Reusability_: Self-contained functions can be easily reused across different parts of your application.
- _Superior Performance_: Loose coupling reduces bottlenecks and encourages asynchronous execution.
- _Streamlined Testing_: Well-defined functions facilitate unit testing and isolate potential issues.
- _Simplified Debugging_: Independent functions make it easier to pinpoint the source of errors.
- _Technology Agnostic_: You may use your preferred frameworks and tools to write composable code,
  allowing for easier future adaptations.

## Implementing Composable Design

While seemingly simple, implementing composable design can involve some initial complexity.

Here's a breakdown of the approach:

- _Function Design_: Each function serves a specific purpose, with clearly defined inputs and outputs.
- _Event Communication_: Functions communicate through well-defined events, avoiding direct dependencies.
- _Choreography_: An event manager, with a state machine and event flow configuration, sequences and triggers functions
  based on events.

## Conclusion

Composable design patterns offer a powerful paradigm for building maintainable, scalable, and future-proof applications.
By embracing the principles of self-contained functions and event-driven communication, you can conquer complexity and
write code that is a joy to work with.
