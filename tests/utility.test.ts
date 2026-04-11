import fs from 'fs';
import os from 'os';
import path from 'path';
import { Utility, StringBuilder } from '../src/util/utility';

const util = new Utility();

describe('StringBuilder', () => {

    it('can append strings', () => {
        const sb = new StringBuilder();
        sb.append('hello');
        sb.append(' ');
        sb.append('world');
        expect(sb.getValue()).toBe('hello world');
    });

    it('can append non-string values', () => {
        const sb = new StringBuilder();
        sb.append(42);
        sb.append(true);
        expect(sb.getValue()).toBe('42true');
    });

    it('returns empty string when nothing appended', () => {
        const sb = new StringBuilder();
        expect(sb.getValue()).toBe('');
    });

    it('skips empty strings but appends non-string falsy values', () => {
        const sb = new StringBuilder();
        sb.append('');
        sb.append(0);
        sb.append(null);
        expect(sb.getValue()).toBe('0null');
    });
});

describe('Utility', () => {

    describe('getUuid', () => {
        it('returns a hex string that is a valid UUID with hyphens stripped', () => {
            const id = util.getUuid();
            // Must be 32 hex chars — a valid v4 UUID minus its hyphens
            expect(id).toMatch(/^[0-9a-f]{32}$/);
            // Re-inserting hyphens should produce a valid v4 UUID
            const restored = `${id.slice(0,8)}-${id.slice(8,12)}-${id.slice(12,16)}-${id.slice(16,20)}-${id.slice(20)}`;
            expect(restored).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
        });

        it('generates distinct IDs across multiple calls', () => {
            const ids = new Set(Array.from({ length: 50 }, () => util.getUuid()));
            expect(ids.size).toBe(50);
        });
    });

    describe('getUuid4', () => {
        it('returns a valid v4 UUID', () => {
            const id = util.getUuid4();
            expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
        });

        it('is different from getUuid output for the same call', () => {
            // getUuid strips hyphens, getUuid4 keeps them — verify they serve different purposes
            const plain = util.getUuid();
            const standard = util.getUuid4();
            expect(plain).not.toContain('-');
            expect(standard).toContain('-');
        });
    });

    describe('sleep', () => {
        it('resolves after the given time', async () => {
            const start = Date.now();
            await util.sleep(50);
            const elapsed = Date.now() - start;
            expect(elapsed).toBeGreaterThanOrEqual(40);
        });

        it('resolves with the delay value passed in', async () => {
            const result = await util.sleep(10);
            expect(result).toBe(10);
        });
    });

    describe('getFloat', () => {
        it('formats to 3 decimal points by default', () => {
            expect(util.getFloat(3.14159)).toBe(3.142);
        });

        it('formats to custom decimal points', () => {
            expect(util.getFloat(3.14159, 2)).toBe(3.14);
        });

        it('returns 0.0 for null/undefined', () => {
            expect(util.getFloat(null)).toBe(0.0);
            expect(util.getFloat(undefined)).toBe(0.0);
        });
    });

    describe('htmlEscape', () => {
        it('escapes HTML special characters', () => {
            expect(util.htmlEscape('<div class="test">')).toBe('&lt;div class=&quot;test&quot;&gt;');
        });

        it('escapes ampersand and single quote', () => {
            expect(util.htmlEscape("Tom & Jerry's")).toBe("Tom &amp; Jerry&#39;s");
        });
    });

    describe('str2int', () => {
        it('converts valid string to integer', () => {
            expect(util.str2int('42')).toBe(42);
        });

        it('returns -1 for invalid string', () => {
            expect(util.str2int('abc')).toBe(-1);
        });

        it('returns -1 for null/empty', () => {
            expect(util.str2int(null)).toBe(-1);
            expect(util.str2int('')).toBe(-1);
        });

        it('truncates floating point strings', () => {
            expect(util.str2int('3.14')).toBe(3);
        });
    });

    describe('str2float', () => {
        it('converts valid string to float', () => {
            expect(util.str2float('3.14')).toBe(3.14);
        });

        it('returns -1 for invalid string', () => {
            expect(util.str2float('abc')).toBe(-1);
        });

        it('returns -1 for null/empty', () => {
            expect(util.str2float(null)).toBe(-1);
            expect(util.str2float('')).toBe(-1);
        });
    });

    describe('isDigits', () => {
        it('returns true for digit-only strings', () => {
            expect(util.isDigits('12345')).toBe(true);
        });

        it('returns false for strings with non-digit characters', () => {
            expect(util.isDigits('12a45')).toBe(false);
            expect(util.isDigits('-5')).toBe(false);
        });

        it('returns false for null/empty', () => {
            expect(util.isDigits(null)).toBe(false);
            expect(util.isDigits('')).toBe(false);
        });
    });

    describe('isNumeric', () => {
        it('returns true for positive numbers', () => {
            expect(util.isNumeric('12345')).toBe(true);
        });

        it('returns true for negative numbers', () => {
            expect(util.isNumeric('-42')).toBe(true);
        });

        it('returns false for non-numeric strings', () => {
            expect(util.isNumeric('abc')).toBe(false);
        });

        it('returns false for single hyphen', () => {
            expect(util.isNumeric('-')).toBe(false);
        });

        it('returns false for null/empty', () => {
            expect(util.isNumeric(null)).toBe(false);
            expect(util.isNumeric('')).toBe(false);
        });
    });

    describe('validRouteName', () => {
        it('accepts valid route names', () => {
            expect(util.validRouteName('hello.world')).toBe(true);
            expect(util.validRouteName('my-service.handler')).toBe(true);
            expect(util.validRouteName('v1_test.route')).toBe(true);
        });

        it('rejects names without dots', () => {
            expect(util.validRouteName('hello')).toBe(false);
        });

        it('rejects names starting or ending with special characters', () => {
            expect(util.validRouteName('.hello.world')).toBe(false);
            expect(util.validRouteName('hello.world.')).toBe(false);
            expect(util.validRouteName('-hello.world')).toBe(false);
            expect(util.validRouteName('hello.world-')).toBe(false);
            expect(util.validRouteName('_hello.world')).toBe(false);
        });

        it('rejects names with double dots', () => {
            expect(util.validRouteName('hello..world')).toBe(false);
        });

        it('rejects uppercase characters', () => {
            expect(util.validRouteName('Hello.World')).toBe(false);
        });

        it('returns false for null/empty', () => {
            expect(util.validRouteName(null)).toBe(false);
            expect(util.validRouteName('')).toBe(false);
        });
    });

    describe('getElapsedTime', () => {
        it('formats milliseconds', () => {
            expect(util.getElapsedTime(500)).toBe('500 ms');
        });

        it('formats seconds', () => {
            expect(util.getElapsedTime(3000)).toBe('3 seconds');
        });

        it('formats 1 second singular', () => {
            expect(util.getElapsedTime(1000)).toBe('1 second');
        });

        it('formats minutes', () => {
            expect(util.getElapsedTime(120000)).toBe('2 minutes');
        });

        it('formats hours', () => {
            // getElapsedTime uses > not >= so 3600000 = 60 minutes exactly
            expect(util.getElapsedTime(3600001)).toContain('1 hour');
        });

        it('formats days', () => {
            expect(util.getElapsedTime(86400001)).toContain('1 day');
        });

        it('formats mixed durations', () => {
            // 1 day + 2 hours + 3 minutes + 4 seconds (with +1ms to cross thresholds)
            const ms = 86400001 + 7200000 + 180000 + 4000;
            const result = util.getElapsedTime(ms);
            expect(result).toContain('1 day');
            expect(result).toContain('2 hours');
            expect(result).toContain('3 minutes');
            expect(result).toContain('4 seconds');
        });
    });

    describe('getLocalTimestamp', () => {
        it('returns a timestamp close to the current time', () => {
            const ts = util.getLocalTimestamp();
            // Extract the date portion and verify it matches today
            const datePart = ts.substring(0, 10);
            const now = new Date();
            const offset = now.getTimezoneOffset() * 60 * 1000;
            const localDate = new Date(now.getTime() - offset).toISOString().substring(0, 10);
            expect(datePart).toBe(localDate);
        });

        it('converts a known epoch to the correct local timestamp', () => {
            // Use a fixed epoch and verify the output reflects the local timezone conversion
            const epoch = 1700000000000; // 2023-11-14T22:13:20.000Z
            const ts = util.getLocalTimestamp(epoch);
            // Verify the function produces a date-time string (not just a format check)
            const now = new Date(epoch);
            const offset = now.getTimezoneOffset() * 60 * 1000;
            const expected = new Date(epoch - offset).toISOString().replace('T', ' ').replace('Z', '');
            expect(ts).toBe(expected);
        });
    });

    describe('getDurationInSeconds', () => {
        it('parses seconds', () => {
            expect(util.getDurationInSeconds('30s')).toBe(30);
        });

        it('parses minutes', () => {
            expect(util.getDurationInSeconds('5m')).toBe(300);
        });

        it('parses hours', () => {
            expect(util.getDurationInSeconds('2h')).toBe(7200);
        });

        it('parses days', () => {
            expect(util.getDurationInSeconds('1d')).toBe(86400);
        });

        it('parses plain number as seconds', () => {
            expect(util.getDurationInSeconds('60')).toBe(60);
        });
    });

    describe('normalizeFilePath', () => {
        it('converts backslashes to forward slashes', () => {
            expect(util.normalizeFilePath('path\\to\\file')).toBe('path/to/file');
        });

        it('strips Windows drive letter', () => {
            expect(util.normalizeFilePath('C:\\Users\\test')).toBe('/Users/test');
        });

        it('leaves Unix paths unchanged', () => {
            expect(util.normalizeFilePath('/usr/local/bin')).toBe('/usr/local/bin');
        });
    });

    describe('isDirectory', () => {
        it('returns true for existing directories', () => {
            expect(util.isDirectory(os.tmpdir())).toBe(true);
        });

        it('returns false for files', () => {
            const tmpFile = path.join(os.tmpdir(), `test-util-${Date.now()}.txt`);
            fs.writeFileSync(tmpFile, 'test');
            try {
                expect(util.isDirectory(tmpFile)).toBe(false);
            } finally {
                fs.unlinkSync(tmpFile);
            }
        });

        it('returns false for non-existent paths', () => {
            expect(util.isDirectory('/nonexistent/path/xyz')).toBe(false);
        });
    });

    describe('file operations', () => {
        const tmpDir = os.tmpdir();
        const testFile = path.join(tmpDir, `test-util-file-${Date.now()}.txt`);

        afterEach(() => {
            if (fs.existsSync(testFile)) {
                fs.unlinkSync(testFile);
            }
        });

        it('str2file and file2str round-trip', async () => {
            await util.str2file(testFile, 'hello world');
            const content = await util.file2str(testFile);
            expect(content).toBe('hello world');
        });

        it('file2str returns empty for non-existent file', async () => {
            const content = await util.file2str('/nonexistent/file.txt');
            expect(content).toBe('');
        });

        it('bytes2file and file2bytes round-trip', async () => {
            const data = Buffer.from('binary data');
            await util.bytes2file(testFile, data);
            const content = await util.file2bytes(testFile);
            expect(Buffer.isBuffer(content)).toBe(true);
            expect(content.toString()).toBe('binary data');
        });

        it('file2bytes returns empty buffer for non-existent file', async () => {
            const content = await util.file2bytes('/nonexistent/file.bin');
            expect(content.length).toBe(0);
        });

        it('appendStr2file appends content', async () => {
            await util.str2file(testFile, 'hello');
            await util.appendStr2file(testFile, ' world');
            const content = await util.file2str(testFile);
            expect(content).toBe('hello world');
        });

        it('appendBytes2file appends bytes', async () => {
            await util.str2file(testFile, 'hello');
            await util.appendBytes2file(testFile, Buffer.from(' world'));
            const content = await util.file2str(testFile);
            expect(content).toBe('hello world');
        });
    });

    describe('mkdirsIfNotExist', () => {
        const tmpDir = path.join(os.tmpdir(), `test-mkdir-${Date.now()}`);

        afterEach(() => {
            if (fs.existsSync(tmpDir)) {
                fs.rmSync(tmpDir, { recursive: true });
            }
        });

        it('creates nested directories', () => {
            const nested = path.join(tmpDir, 'a', 'b');
            util.mkdirsIfNotExist(nested);
            expect(fs.existsSync(nested)).toBe(true);
        });

        it('does nothing for null/empty', () => {
            util.mkdirsIfNotExist(null);
            util.mkdirsIfNotExist('');
        });
    });

    describe('split', () => {
        it('splits by single character', () => {
            expect(util.split('a,b,c', ',')).toEqual(['a', 'b', 'c']);
        });

        it('splits by multiple separators', () => {
            expect(util.split('a,b;c', ',;')).toEqual(['a', 'b', 'c']);
        });

        it('skips empty elements by default', () => {
            expect(util.split('a,,b', ',')).toEqual(['a', 'b']);
        });

        it('includes empty elements when requested', () => {
            expect(util.split('a,,b', ',', true)).toEqual(['a', '', 'b']);
        });

        it('returns empty array for null/empty input', () => {
            expect(util.split(null, ',')).toEqual([]);
            expect(util.split('', ',')).toEqual([]);
        });
    });

    describe('bytesToBase64 and base64ToBytes', () => {
        it('round-trips correctly', () => {
            const original = Buffer.from('hello world');
            const b64 = util.bytesToBase64(original);
            const decoded = util.base64ToBytes(b64);
            expect(decoded.toString()).toBe('hello world');
        });
    });

    describe('equalsIgnoreCase', () => {
        it('returns true for same-case strings', () => {
            expect(util.equalsIgnoreCase('hello', 'hello')).toBe(true);
        });

        it('returns true for different-case strings', () => {
            expect(util.equalsIgnoreCase('Hello', 'hello')).toBe(true);
        });

        it('returns false for different strings', () => {
            expect(util.equalsIgnoreCase('hello', 'world')).toBe(false);
        });
    });

    describe('getInteger', () => {
        it('converts string to integer', () => {
            expect(util.getInteger('42')).toBe(42);
        });

        it('converts number to integer', () => {
            expect(util.getInteger(3.14)).toBe(3);
        });

        it('returns -1 for other types', () => {
            expect(util.getInteger(null)).toBe(-1);
        });
    });

    describe('getString', () => {
        it('returns string as-is', () => {
            expect(util.getString('hello')).toBe('hello');
        });

        it('JSON-stringifies non-string values', () => {
            expect(util.getString({ a: 1 })).toBe('{"a":1}');
        });
    });

    describe('getDecodedUri', () => {
        it('decodes URI-encoded characters', () => {
            expect(util.getDecodedUri('/api/hello%20world')).toBe('/api/hello world');
        });

        it('returns "/" for null', () => {
            expect(util.getDecodedUri(null)).toBe('/');
        });

        it('prevents path traversal and returns a safe path', () => {
            const result = util.getDecodedUri('/api/../secret');
            expect(result).not.toContain('..');
            expect(result).toBe('/api/secret');
        });

        it('handles backslash traversal attempts', () => {
            const result = util.getDecodedUri('/api\\..\\secret');
            expect(result).not.toContain('..');
            expect(result).not.toContain('\\');
        });
    });

    describe('extractSegments', () => {
        it('extracts segments whose positions can reconstruct the original variables', () => {
            const original = 'Hello ${name} from ${place}';
            const segments = util.extractSegments(original, '${', '}');
            expect(segments).toHaveLength(2);
            // Use the returned positions to extract the actual variable references
            const first = original.substring(segments[0].start, segments[0].end);
            const second = original.substring(segments[1].start, segments[1].end);
            expect(first).toBe('${name}');
            expect(second).toBe('${place}');
        });

        it('handles nested-looking patterns by finding innermost matches', () => {
            const original = 'value is ${outer${inner}}';
            const segments = util.extractSegments(original, '${', '}');
            expect(segments.length).toBeGreaterThanOrEqual(1);
            // Verify at least one extracted segment is a valid variable reference
            const extracted = original.substring(segments[0].start, segments[0].end);
            expect(extracted).toContain('${');
        });

        it('returns empty array when no segments found', () => {
            const segments = util.extractSegments('no variables here', '${', '}');
            expect(segments).toHaveLength(0);
        });
    });

    describe('loadYamlFile', () => {
        it('throws for missing file path', () => {
            expect(() => util.loadYamlFile(null)).toThrow('Missing file path');
        });

        it('throws for non-existent file', () => {
            expect(() => util.loadYamlFile('/nonexistent/file.yml')).toThrow('does not exist');
        });

        it('loads a valid YAML file', () => {
            const tmpFile = path.join(os.tmpdir(), `test-yaml-${Date.now()}.yml`);
            fs.writeFileSync(tmpFile, 'key: value\nnested:\n  a: 1\n');
            try {
                const result = util.loadYamlFile(tmpFile);
                expect(result.getElement('key')).toBe('value');
                expect(result.getElement('nested.a')).toBe(1);
            } finally {
                fs.unlinkSync(tmpFile);
            }
        });
    });
});
