import { fileURLToPath } from 'url';
import { AppException } from '../src/models/app-exception';
import { defineComposable, Validator } from '../src/models/composable';
import { EventEnvelope } from '../src/models/event-envelope';
import { Platform } from '../src/system/platform';
import { NoOpComposable } from '../src/services/no-op';
import { PostOffice, Sender } from '../src/system/post-office';
import { AppConfig } from '../src/util/config-reader';
import { TemplateLoader } from '../src/util/template-loader';
import { JavaScriptClassScanner } from '../src/util/js-class-scanner';
import {
  ClassScanUtility,
  TypeScriptClassScanner,
} from '../src/util/ts-class-scanner';

function getRootFolder() {
  const folder = fileURLToPath(new URL('..', import.meta.url));
  const path = folder.includes('\\') ? folder.replaceAll('\\', '/') : folder;
  const colon = path.indexOf(':');
  return colon == 1 ? path.substring(colon + 1) : path;
}

interface SchemaInput {
  id: string;
  amount: number;
}

interface SchemaOutput {
  ok: boolean;
  doubled: number;
}

const inputSchema: Validator<SchemaInput> = {
  parse(value: unknown): SchemaInput {
    if (!value || typeof value !== 'object') {
      throw new Error('expected object');
    }
    const record = value as Record<string, unknown>;
    if (typeof record.id !== 'string') {
      throw new Error('id must be string');
    }
    if (typeof record.amount !== 'number') {
      throw new Error('amount must be number');
    }
    return { id: record.id, amount: record.amount };
  },
};

const outputSchema: Validator<SchemaOutput> = {
  parse(value: unknown): SchemaOutput {
    if (!value || typeof value !== 'object') {
      throw new Error('expected object');
    }
    const record = value as Record<string, unknown>;
    if (typeof record.ok !== 'boolean') {
      throw new Error('ok must be boolean');
    }
    if (typeof record.doubled !== 'number') {
      throw new Error('doubled must be number');
    }
    return { ok: record.ok, doubled: record.doubled };
  },
};

describe('defineComposable', () => {
  const root = getRootFolder();
  const resourcePath = root + 'tests/resources';
  const runtimeBase = `test.define.composable.${Date.now()}`;
  const validatedRoute = `${runtimeBase}.validated`;
  const passthroughRoute = `${runtimeBase}.passthrough`;
  let platform: Platform;

  beforeAll(async () => {
    AppConfig.getInstance(resourcePath);
    platform = Platform.getInstance();
    await platform.getReady();
  });

  afterAll(() => {
    for (const route of [validatedRoute, passthroughRoute]) {
      if (new PostOffice().exists(route)) {
        platform.release(route);
      }
    }
  });

  it('creates a composable object with default lifecycle and metadata', async () => {
    const composable = defineComposable({
      process: 'v1.get.profile',
      handler: (evt) => evt.getBody(),
    });
    expect(composable.process).toBe('v1.get.profile');
    expect(composable.instances).toBe(1);
    expect(composable.visibility).toBe('private');
    expect(composable.interceptor).toBe(false);
    expect(composable.initialize()).toBe(composable);
    const result = await composable.handleEvent(
      new EventEnvelope().setBody('demo'),
    );
    expect(result).toBe('demo');
  });

  it('runs optional input and output validation through the platform runtime', async () => {
    const composable = defineComposable({
      process: validatedRoute,
      handler: (evt) => {
        const body = evt.getBody() as SchemaInput;
        return { ok: true, doubled: body.amount * 2 };
      },
      inputSchema,
      outputSchema,
      instances: 2,
      visibility: 'public',
    });
    platform.registerComposable(composable);

    const po = new PostOffice(
      new Sender('unit.test', '1001', 'TEST /define-composable/ok'),
    );
    const response = await po.request(
      new EventEnvelope()
        .setTo(validatedRoute)
        .setBody({ id: 'abc', amount: 4 }),
      3000,
    );
    expect(response.getBody()).toStrictEqual({ ok: true, doubled: 8 });
  });

  it('rejects invalid input when inputSchema is provided', async () => {
    const po = new PostOffice(
      new Sender('unit.test', '1002', 'TEST /define-composable/bad-input'),
    );
    try {
      await po.request(
        new EventEnvelope()
          .setTo(validatedRoute)
          .setBody({ id: 'abc', amount: 'bad' }),
        3000,
      );
      throw new Error('expected input validation to reject');
    } catch (e) {
      expect(e).toBeInstanceOf(AppException);
      const ex = e as AppException;
      expect(ex.getStatus()).toBe(400);
      expect(ex.message).toContain('Input validation failed');
      expect(ex.message).toContain('amount must be number');
    }
  });

  it('rejects invalid output when outputSchema is provided', async () => {
    const invalidRoute = `${runtimeBase}.invalid-output`;
    const composable = defineComposable({
      process: invalidRoute,
      handler: () => ({ ok: 'yes', doubled: 1 }),
      outputSchema,
    });
    platform.registerComposable(composable);

    const po = new PostOffice(
      new Sender('unit.test', '1003', 'TEST /define-composable/bad-output'),
    );
    try {
      await po.request(
        new EventEnvelope()
          .setTo(invalidRoute)
          .setBody({ id: 'abc', amount: 1 }),
        3000,
      );
      throw new Error('expected output validation to reject');
    } catch (e) {
      expect(e).toBeInstanceOf(AppException);
      const ex = e as AppException;
      expect(ex.getStatus()).toBe(500);
      expect(ex.message).toContain('Output validation failed');
    } finally {
      if (new PostOffice().exists(invalidRoute)) {
        platform.release(invalidRoute);
      }
    }
  });

  it('skips validation when schemas are omitted', async () => {
    const composable = defineComposable({
      process: passthroughRoute,
      handler: (evt) => ({ payload: evt.getBody(), accepted: true }),
    });
    platform.registerComposable(composable);

    const po = new PostOffice(
      new Sender('unit.test', '1004', 'TEST /define-composable/no-schema'),
    );
    const response = await po.request(
      new EventEnvelope()
        .setTo(passthroughRoute)
        .setBody({ flexible: 'shape' }),
      3000,
    );
    expect(response.getBody()).toStrictEqual({
      payload: { flexible: 'shape' },
      accepted: true,
    });
  });

  it('adds TypeScript scanner metadata for both class and defineComposable styles', async () => {
    const classScanner = new TypeScriptClassScanner(root, 'src', 'preload');
    const classResult = (await classScanner.scan()) as {
      classes: Record<string, string>;
      composables: Record<
        string,
        { kind: string; file: string; exportName: string; parameters: string[] }
      >;
    };
    expect(classResult.classes['NoOp']).toBe('src/services/no-op');
    expect(classResult.composables['NoOp']).toBeDefined();

    const scanner = new TypeScriptClassScanner(
      root,
      'tests/resources/annotated',
      'preload',
    );
    const result = (await scanner.scan()) as {
      composables: Record<
        string,
        { kind: string; file: string; exportName: string; parameters: string[] }
      >;
    };
    const entry = Object.values(result.composables).find(
      (v) =>
        v.kind == 'definition' &&
        v.file == 'tests/resources/annotated/define-composable' &&
        v.exportName == 'default',
    );
    expect(entry).toBeDefined();
    expect(entry?.parameters).toStrictEqual([
      "'v1.define.composable.ts'",
      '3',
      "'public'",
      'true',
    ]);
  });

  it('adds JavaScript scanner metadata for defineComposable modules', async () => {
    const scanner = new JavaScriptClassScanner(
      root,
      'tests/resources/annotated',
      'preload',
    );
    const result = (await scanner.scan()) as {
      composables: Record<
        string,
        { kind: string; file: string; exportName: string; parameters: string[] }
      >;
    };
    const entry = Object.values(result.composables).find(
      (v) =>
        v.kind == 'definition' &&
        v.file == 'tests/resources/annotated/define-composable.js' &&
        v.exportName == 'default',
    );
    expect(entry).toBeDefined();
    expect(entry?.parameters).toStrictEqual([
      "'v1.define.composable.js'",
      '4',
      "'public'",
      'true',
    ]);
  });

  it('includes a placeholder for definition-based registrations in the preload template', () => {
    const loader = new TemplateLoader();
    const template = loader.getTemplate('preload.template');
    expect(template.includes('${composable-list}')).toBe(true);
  });

  it('generates preload code for both class and defineComposable registrations', async () => {
    const scanner = new TypeScriptClassScanner(
      root,
      'tests/resources/annotated',
      'preload',
    );
    const result = (await scanner.scan()) as {
      composables: Record<
        string,
        { kind: string; file: string; exportName: string; parameters: string[] }
      >;
    };
    const preloadCode = ClassScanUtility.generatePreloadCode({
      composables: {
        NoOp: {
          kind: 'class',
          file: 'src/services/no-op',
          exportName: 'NoOp',
          parameters: ["'no.op'", '50'],
        },
        ...result.composables,
      },
    });

    expect(preloadCode.importStatements).toContain(
      "import { NoOp } from '../services/no-op.js';",
    );
    expect(preloadCode.importStatements).toContain(
      "import defineComposable from '../../tests/resources/annotated/define-composable.js';",
    );
    expect(preloadCode.serviceList).toContain(
      "platform.register('no.op', new NoOp(), 50);",
    );
    expect(preloadCode.composableList).toContain(
      'platform.registerComposable(defineComposable);',
    );
  });

  it('prefers class registrations when class and definition exports share the same process', async () => {
    const scanner = new TypeScriptClassScanner(root, 'src', 'preload');
    const result = (await scanner.scan()) as {
      composables: Record<
        string,
        { kind: string; file: string; exportName: string; parameters: string[] }
      >;
    };
    const preloadCode = ClassScanUtility.generatePreloadCode(result);

    expect(preloadCode.serviceList).toContain(
      "platform.register('no.op', new NoOp(), 50);",
    );
    expect(preloadCode.composableList).not.toContain('NoOpComposable');
    expect(preloadCode.composableList).not.toContain(
      'platform.registerComposable(noOpComposable);',
    );
  });

  it('supports named defineComposable exports when generating preload imports', () => {
    const preloadCode = ClassScanUtility.generatePreloadCode({
      composables: {
        'named@src/services/reporting-task': {
          kind: 'definition',
          file: 'src/services/reporting-task',
          exportName: 'reportingTask',
          parameters: ["'v1.reporting.task'", '2', "'public'", 'false'],
        },
      },
    });

    expect(preloadCode.importStatements).toContain(
      "import { reportingTask } from '../services/reporting-task.js';",
    );
    expect(preloadCode.composableList).toContain(
      'platform.registerComposable(reportingTask);',
    );
  });

  it('supports function-style built-in composables alongside class exports', async () => {
    const route = `${runtimeBase}.no-op-composable`;
    const composable = defineComposable({
      process: route,
      instances: NoOpComposable.instances,
      handler: NoOpComposable.handleEvent.bind(NoOpComposable),
    });
    platform.registerComposable(composable);

    const po = new PostOffice(
      new Sender('unit.test', '1005', 'TEST /define-composable/no-op'),
    );
    const response = await po.request(
      new EventEnvelope().setTo(route).setBody({ hello: 'world' }),
      3000,
    );
    expect(response.getBody()).toStrictEqual({ hello: 'world' });

    if (new PostOffice().exists(route)) {
      platform.release(route);
    }
  });
});
