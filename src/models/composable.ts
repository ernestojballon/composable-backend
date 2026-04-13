import { EventEnvelope } from './event-envelope.js';
import { Logger } from '../util/logger.js';

const log = Logger.getInstance();

/**
 * Minimal library-agnostic validator protocol.
 *
 * Any object exposing a `parse(value) => T` method that throws on invalid input
 * satisfies this interface. Zod schemas satisfy it natively. TypeBox users can
 * wrap a schema with a small adapter:
 *
 *     const v: Validator<T> = { parse: (x) => { if (!Check(schema, x)) throw new Error(...); return x as T; } };
 */
export interface Validator<T = unknown> {
  parse(value: unknown): T;
}

/**
 * Type helper: extract the parsed type of a Validator (akin to z.infer).
 */
export type Infer<V> = V extends Validator<infer T> ? T : never;

export type ComposableResult =
  | string
  | boolean
  | number
  | object
  | EventEnvelope
  | null;

export type ComposableHandler<TOut = ComposableResult> = (
  evt: EventEnvelope,
) => Promise<TOut> | TOut;

export type Visibility = 'private' | 'public';

export interface DefineComposableOptions<
  TRoute extends string = string,
  TIn = unknown,
  TOut extends ComposableResult = ComposableResult,
> {
  process: TRoute;
  handler: ComposableHandler<TOut>;
  inputSchema?: Validator<TIn>;
  outputSchema?: Validator<TOut>;
  instances?: number;
  visibility?: Visibility;
  interceptor?: boolean;
}

export interface DefinedComposable<
  TRoute extends string = string,
  TIn = unknown,
  TOut extends ComposableResult = ComposableResult,
> extends Composable {
  readonly process: TRoute;
  readonly instances: number;
  readonly visibility: Visibility;
  readonly interceptor: boolean;
  inputSchema?: Validator<TIn>;
  outputSchema?: Validator<TOut>;
  handleEvent(evt: EventEnvelope): Promise<TOut>;
}

export interface Composable {
  /**
   * Annotation for the initialize() method to tell the system to preload this composable function:
   * @preload(route, instances, visibility, interceptor)
   *
   * You can use the initialize method to do optional setup for your composable function.
   */
  initialize(): Composable;

  /**
   * This is your user function's entry point.
   *
   * IMPORTANT:
   * The 'this' reference is not relevant in a composable function
   * because Composable function is designed to be isolated with I/O immutability.
   *
   * If your function needs to call other private methods in the same composable class,
   * use the PostOffice's getMyClass method like this:
   *
   * // Creates a unique instance of PostOffice for your function
   * const po = new PostOffice(evt);
   * const self = po.getMyClass() as UserFunction;
   * // where UserFunction should be the same as your composable class name.
   *
   * @param evt is the incoming event containing headers and body (payload)
   */
  handleEvent(evt: EventEnvelope): Promise<ComposableResult>;

  /**
   * Optional input schema. When set, the event body is validated BEFORE
   * handleEvent() is invoked. Validation failure throws AppException(400).
   * The parsed (and potentially coerced) value replaces evt.getBody().
   */
  inputSchema?: Validator;

  /**
   * Optional output schema. When set, the handler's resolved return value
   * is validated AFTER handleEvent() completes. Validation failure is
   * reported as AppException(500). Skipped for interceptors (their return
   * value is not forwarded anyway).
   *
   * If the handler returns an EventEnvelope, the envelope's body is validated.
   */
  outputSchema?: Validator;
}

/**
 * Annotation for a composable class
 *
 * @param route name (aka functional topic)
 * @param instances to define concurrency
 * @param visibility 'private' or 'public' (default 'private'). Public functions are reachable via event-over-http.
 * @param interceptor is true if this function is an event interceptor
 * @returns annotated function
 */
export function preload(
  route: string,
  instances = 1,
  visibility: Visibility = 'private',
  interceptor = false,
) {
  return function (
    _target,
    propertyKey: string,
    descriptor: PropertyDescriptor,
  ) {
    if ('initialize' == propertyKey) {
      const method = descriptor.value;
      descriptor.value = function (...argv) {
        log.debug(
          `preload ${route} with ${instances} instances, visibility=${visibility}, interceptor=${interceptor}`,
        );
        return method.apply(this, argv);
      };
    } else {
      log.error(
        `Please annotate the 'initialize' method in a Composable - @preload does not apply to ${propertyKey}`,
      );
    }
  };
}

/**
 * Functional authoring helper for a composable task definition.
 *
 * This is equivalent to implementing the Composable interface directly, but it
 * avoids an empty initialize() method and works well with optional validators.
 */
export function defineComposable<
  TRoute extends string = string,
  TIn = unknown,
  TOut extends ComposableResult = ComposableResult,
>(
  options: DefineComposableOptions<TRoute, TIn, TOut>,
): DefinedComposable<TRoute, TIn, TOut> {
  if (!options || typeof options !== 'object') {
    throw new Error('Composable definition must be an object');
  }
  if (!options.process || typeof options.process !== 'string') {
    throw new Error('Composable definition must declare a process');
  }
  if (!(options.handler instanceof Function)) {
    throw new Error('Composable definition must declare a handler function');
  }

  const composable: DefinedComposable<TRoute, TIn, TOut> = {
    process: options.process,
    instances: Math.max(1, options.instances ?? 1),
    visibility: options.visibility ?? 'private',
    interceptor: options.interceptor ?? false,
    initialize(): Composable {
      return this;
    },
    async handleEvent(evt: EventEnvelope): Promise<TOut> {
      return await options.handler(evt);
    },
  };

  if (options.inputSchema) {
    composable.inputSchema = options.inputSchema;
  }
  if (options.outputSchema) {
    composable.outputSchema = options.outputSchema;
  }
  return composable;
}
