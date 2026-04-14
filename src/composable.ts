import fs from 'fs';
import path from 'path';
import { AppConfig } from './util/config-reader.js';
import { Platform } from './system/platform.js';
import { RestAutomation } from './system/rest-automation.js';
import { EventScriptEngine } from './automation/event-script-manager.js';
import { NoOpComposable } from './services/no-op.js';
import { DefinedComposable } from './models/composable.js';

export interface ComposableOptions {
  /** Server port. Overrides application.yml and .env. */
  port?: number;
  /** Additional composables to register (e.g. KafkaAdapter from external packages). */
  composables?: DefinedComposable[];
}

/**
 * Find the project root by looking for package.json walking up from cwd.
 */
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

/**
 * Find config directory. Searches:
 * 1. src/config/ (standard location)
 * 2. config/ (alternative)
 * 3. src/ (flat structure)
 */
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

/**
 * Detect if running in dev mode (tsx) or production (node from dist/).
 */
function isDevMode(): boolean {
  // tsx sets this, or the entry point is a .ts file
  const entryFile = process.argv[1] ?? '';
  return entryFile.endsWith('.ts');
}

/**
 * Find directory for auto-scanning tasks.
 * Dev: scan src/ for *.task.ts
 * Prod: scan dist/ for *.task.js
 */
function findTaskScanDir(root: string): string {
  if (isDevMode()) {
    const src = path.join(root, 'src');
    return fs.existsSync(src) ? src : root;
  }
  const dist = path.join(root, 'dist');
  return fs.existsSync(dist) ? dist : root;
}

/**
 * Find directory for auto-scanning flows.
 * Always src/ — YAML files live there permanently (Approach C).
 */
function findFlowScanDir(root: string): string {
  const src = path.join(root, 'src');
  return fs.existsSync(src) ? src : root;
}

/**
 * Start a composable-backend application.
 *
 * This is the single entry point that replaces Platform, AppConfig,
 * EventScriptEngine, RestAutomation, and ComposableLoader boilerplate.
 *
 * Usage:
 *   import { composable } from 'composable-backend';
 *   await composable();
 *
 * With options:
 *   await composable({
 *     port: 3000,
 *     composables: [KafkaAdapter, KafkaNotification],
 *   });
 */
export async function composable(options?: ComposableOptions): Promise<void> {
  // Load .env if available (Node 20.6+)
  try {
    const proc = process as unknown as { loadEnvFile?: () => void };
    if (typeof proc.loadEnvFile === 'function') {
      try {
        proc.loadEnvFile();
      } catch {
        /* no .env is fine */
      }
    }
  } catch {
    /* ignore */
  }

  const root = findProjectRoot();
  const configDir = findConfigDir(root);
  const taskDir = findTaskScanDir(root);
  const flowDir = findFlowScanDir(root);

  // Initialize config
  const config = AppConfig.getInstance(configDir);

  // Initialize platform
  const platform = Platform.getInstance();
  platform.registerComposable(NoOpComposable);

  // Auto-scan tasks from src/ (dev) or dist/ (prod)
  await platform.autoScan(taskDir);
  // Auto-scan flows from src/ (always — YAML files stay in source)
  if (flowDir !== taskDir) {
    const { CompileFlows } = await import('./automation/compile-flows.js');
    const compiler = new CompileFlows();
    compiler.loadFlowsFromDirectory(flowDir);
  }

  // Register additional composables (external packages)
  if (options?.composables) {
    for (const c of options.composables) {
      platform.registerComposable(c);
    }
  }

  // Start event script engine (loads flows)
  const eventManager = new EventScriptEngine();
  await eventManager.start();

  // Override port if specified
  if (options?.port) {
    config.set('server.port', options.port);
  }

  // Start REST automation if enabled
  if ('true' == config.getProperty('rest.automation')) {
    const server = RestAutomation.getInstance();
    await server.start();
  }

  platform.runForever();
  await platform.getReady();
}
