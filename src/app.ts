import fs from 'fs';
import path from 'path';
import { AppConfig } from './util/config-reader.js';
import { ConfigReader } from './util/config-reader.js';
import { Platform } from './system/platform.js';
import { PostOffice } from './system/post-office.js';
import { RestAutomation } from './system/rest-automation.js';
import { EventScriptEngine } from './automation/event-script-manager.js';
import { NoOpComposable } from './services/no-op.js';
import { DefinedComposable } from './models/composable.js';
import { EventEnvelope } from './models/event-envelope.js';

/**
 * A self-contained composable application instance.
 *
 * For the 90% case — a single process with one composable app — use the
 * top-level `composable()` function instead. `ComposableApp` is intended
 * for tests, embedding scenarios, and multi-app processes where independent
 * instances are needed.
 *
 * NOTE: The event bus (PostOffice / FunctionRegistry / EventEmitter) is
 * currently a process-level singleton. Routes registered through different
 * ComposableApp instances share the same bus. Full bus isolation requires
 * a deeper refactor and is tracked separately.
 */
export interface ComposableApp {
  /** The platform instance for this app. */
  platform: Platform;
  /** The configuration reader for this app. */
  config: ConfigReader;

  /**
   * Auto-scan a directory for *.task.ts / *.task.js composable files.
   *
   * @param dir absolute path to the directory to scan
   */
  scan(dir: string): Promise<void>;

  /**
   * Register a composable definition with the platform.
   *
   * @param composable a DefinedComposable created by defineComposable()
   */
  register(composable: DefinedComposable): void;

  /**
   * Make an RPC call and return the response body.
   *
   * @param route target route name
   * @param body request payload
   * @param timeout milliseconds (default 60000)
   */
  call(route: string, body?: unknown, timeout?: number): Promise<unknown>;

  /**
   * Make an RPC call and return the full EventEnvelope response.
   *
   * @param route target route name
   * @param body request payload
   * @param headers additional event headers
   * @param timeout milliseconds (default 60000)
   */
  request(
    route: string,
    body?: unknown,
    headers?: Record<string, string>,
    timeout?: number,
  ): Promise<EventEnvelope>;

  /**
   * Fire-and-forget send.
   *
   * @param route target route name
   * @param body request payload
   * @param headers additional event headers
   */
  send(
    route: string,
    body?: unknown,
    headers?: Record<string, string>,
  ): Promise<void>;

  /**
   * Start the platform and, if configured, the REST automation server.
   *
   * @param port optional port override (overrides application.yml / .env)
   */
  start(port?: number): Promise<void>;

  /**
   * Stop the platform and REST server.
   */
  stop(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Internal helpers (duplicated from composable.ts to keep app.ts self-contained)
// ---------------------------------------------------------------------------

function findProjectRoot(): string {
  let dir = process.cwd();
  while (dir !== path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, 'package.json'))) {
      return dir;
    }
    dir = path.dirname(dir);
  }
  return process.cwd();
}

function findConfigDir(root: string): string {
  const candidates = [
    path.join(root, 'src', 'config'),
    path.join(root, 'config'),
    path.join(root, 'src'),
  ];
  for (const dir of candidates) {
    if (
      fs.existsSync(dir) &&
      fs.existsSync(path.join(dir, 'application.yml'))
    ) {
      return dir;
    }
  }
  return path.join(root, 'src', 'config');
}

// ---------------------------------------------------------------------------
// ComposableAppImpl
// ---------------------------------------------------------------------------

class ComposableAppImpl implements ComposableApp {
  readonly platform: Platform;
  readonly config: ConfigReader;
  private readonly po: PostOffice;

  constructor(configDir?: string) {
    // If a configDir is given, initialise AppConfig with it.
    // AppConfig is itself a singleton, so the first caller wins.
    this.config = AppConfig.getInstance(configDir);
    this.platform = Platform.getInstance();
    this.po = new PostOffice();
  }

  async scan(dir: string): Promise<void> {
    await this.platform.autoScan(dir);
  }

  register(composable: DefinedComposable): void {
    this.platform.registerComposable(composable);
  }

  async call(
    route: string,
    body: unknown = null,
    timeout = 60000,
  ): Promise<unknown> {
    const event = new EventEnvelope()
      .setTo(route)
      .setBody(
        body as string | number | object | boolean | Buffer | Uint8Array,
      );
    const result = await this.po.request(event, timeout);
    if (result.getStatus() >= 400) {
      const rawErr = result.getError();
      const errMsg =
        typeof rawErr === 'string'
          ? rawErr
          : rawErr != null
            ? JSON.stringify(rawErr)
            : `Route ${route} returned ${result.getStatus()}`;
      throw Object.assign(new Error(errMsg), { status: result.getStatus() });
    }
    return result.getBody();
  }

  async request(
    route: string,
    body: unknown = null,
    headers: Record<string, string> = {},
    timeout = 60000,
  ): Promise<EventEnvelope> {
    const event = new EventEnvelope()
      .setTo(route)
      .setBody(
        body as string | number | object | boolean | Buffer | Uint8Array,
      );
    for (const [k, v] of Object.entries(headers)) {
      event.setHeader(k, v);
    }
    return this.po.request(event, timeout);
  }

  async send(
    route: string,
    body: unknown = null,
    headers: Record<string, string> = {},
  ): Promise<void> {
    const event = new EventEnvelope()
      .setTo(route)
      .setBody(
        body as string | number | object | boolean | Buffer | Uint8Array,
      );
    for (const [k, v] of Object.entries(headers)) {
      event.setHeader(k, v);
    }
    await this.po.send(event);
  }

  async start(port?: number): Promise<void> {
    // Register the no-op composable so the platform always has at least one handler
    this.platform.registerComposable(NoOpComposable);

    // Start event script engine (loads flow definitions)
    const eventManager = new EventScriptEngine();
    await eventManager.start();

    // Override port when caller specifies one
    if (port !== undefined) {
      this.config.set('server.port', port);
    }

    // Start REST automation if configured
    if ('true' === this.config.getProperty('rest.automation')) {
      const server = RestAutomation.getInstance();
      await server.start();
    }

    this.platform.runForever();
    await this.platform.getReady();
  }

  async stop(): Promise<void> {
    await this.platform.stop();
  }
}

// ---------------------------------------------------------------------------
// Public factory
// ---------------------------------------------------------------------------

/**
 * Create an independent composable application instance.
 *
 * This is the entry point for the 10% case: tests, embedding, or running
 * multiple logical apps inside one process. For the common single-app case
 * use `composable()` from `composable.ts` instead.
 *
 * Usage:
 * ```ts
 * const app = createApp();
 * await app.start();
 *
 * // later …
 * await app.stop();
 * ```
 *
 * With an explicit config directory:
 * ```ts
 * const app = createApp('/path/to/config');
 * ```
 *
 * @param configDir optional path to the directory that contains application.yml
 */
export function createApp(configDir?: string): ComposableApp {
  if (!configDir) {
    const root = findProjectRoot();
    configDir = findConfigDir(root);
  }
  return new ComposableAppImpl(configDir);
}
