import { FunctionRegistry } from '../src/system/function-registry';
import { EventEnvelope } from '../src/models/event-envelope';

// A minimal Composable implementation for testing
class TestComposable {
    initialize() { return this; }
    async handleEvent(evt: EventEnvelope) {
        return evt.getBody();
    }
}

class InvalidClass {
    doSomething() { return 'not composable'; }
}

describe('FunctionRegistry', () => {

    const registry = FunctionRegistry.getInstance();
    const testRoute = 'test.registry.' + Date.now();

    afterAll(() => {
        registry.remove(testRoute);
    });

    it('does not have a non-existent route', () => {
        expect(registry.exists('nonexistent.route.xyz')).toBe(false);
    });

    it('returns false for exists with no argument', () => {
        expect(registry.exists()).toBe(false);
    });

    it('saves a valid Composable', () => {
        const composable = new TestComposable();
        registry.save(testRoute, composable, 1, false, false);
        expect(registry.exists(testRoute)).toBe(true);
    });

    it('does not save duplicate routes', () => {
        const composable = new TestComposable();
        // Saving again should be idempotent
        registry.save(testRoute, composable, 2, true, true);
        const meta = registry.getMetadata(testRoute) as Record<string, unknown>;
        // Metadata should still have original values since duplicate was ignored
        expect(meta['instances']).toBe(1);
    });

    it('does not save invalid Composable', () => {
        const invalidRoute = 'test.invalid.' + Date.now();
        const invalid = new InvalidClass();
        registry.save(invalidRoute, invalid, 1, false, false);
        expect(registry.exists(invalidRoute)).toBe(false);
    });

    it('retrieves metadata', () => {
        const meta = registry.getMetadata(testRoute) as Record<string, unknown>;
        expect(meta).toBeDefined();
        expect(meta['instances']).toBe(1);
        expect(meta['private']).toBe(false);
        expect(meta['interceptor']).toBe(false);
    });

    it('retrieves a working handleEvent function that processes events', async () => {
        const fn = registry.get(testRoute);
        expect(fn).toBeDefined();
        // Actually call the function and verify it returns the event body
        const evt = new EventEnvelope().setBody('test-payload');
        const cls = registry.getClass(testRoute);
        const result = await fn.call(cls, evt);
        expect(result).toBe('test-payload');
    });

    it('retrieves the class instance', () => {
        const cls = registry.getClass(testRoute);
        expect(cls).toBeDefined();
        expect(cls).toBeInstanceOf(TestComposable);
    });

    it('returns null for non-existent route get', () => {
        const fn = registry.get('nonexistent.route.xyz');
        expect(fn).toBeNull();
    });

    it('returns null for non-existent route getClass', () => {
        const cls = registry.getClass('nonexistent.route.xyz');
        expect(cls).toBeNull();
    });

    it('tracks load state', () => {
        expect(registry.isLoaded(testRoute)).toBe(false);
        registry.load(testRoute);
        expect(registry.isLoaded(testRoute)).toBe(true);
    });

    it('includes route in function list', () => {
        const list = registry.getFunctionList();
        expect(list).toContain(testRoute);
    });

    it('removes a route', () => {
        registry.remove(testRoute);
        expect(registry.exists(testRoute)).toBe(false);
        expect(registry.isLoaded(testRoute)).toBe(false);
        expect(registry.getMetadata(testRoute)).toBeUndefined();
    });
});
