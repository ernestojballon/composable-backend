import { ContentTypeResolver } from '../src/util/content-type-resolver';

describe('ContentTypeResolver', () => {

    const resolver = ContentTypeResolver.getInstance();

    describe('getContentType', () => {
        it('returns content type as-is when no charset', () => {
            expect(resolver.getContentType('application/json')).toBe('application/json');
        });

        it('strips charset parameter', () => {
            expect(resolver.getContentType('text/html; charset=utf-8')).toBe('text/html');
        });

        it('trims whitespace', () => {
            expect(resolver.getContentType('  application/json  ')).toBe('application/json');
        });

        it('returns null for null/empty input', () => {
            expect(resolver.getContentType(null)).toBeNull();
            expect(resolver.getContentType('')).toBeNull();
        });

        it('strips charset with extra parameters', () => {
            expect(resolver.getContentType('text/plain; charset=utf-8; boundary=something')).toBe('text/plain');
        });
    });
});
