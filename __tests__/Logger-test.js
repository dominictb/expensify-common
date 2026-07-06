import {TextEncoder} from 'util';
import Logger, {truncateToByteSize} from '../lib/Logger';

const MARKER_REGEX = /\.\.\.\[truncated \d+ bytes\]$/;
// Independent, UTF-8-correct byte counter for assertions (TextEncoder is the gold standard).
const byteLength = (str) => new TextEncoder().encode(str).length;

const mockServerLoggingCallback = jest.fn();
const mockClientLoggingCallback = jest.fn();

const Log = new Logger({
    serverLoggingCallback: mockServerLoggingCallback,
    clientLoggingCallback: mockClientLoggingCallback,
});

const DebugLog = new Logger({
    serverLoggingCallback: mockServerLoggingCallback,
    clientLoggingCallback: mockClientLoggingCallback,
    isDebug: true,
});

test('Test Log.info()', () => {
    Log.info('Test1', false);
    expect(mockServerLoggingCallback).toHaveBeenCalledTimes(0);
    Log.info('Test2', true);
    expect(mockServerLoggingCallback).toHaveBeenCalled();
    expect(mockServerLoggingCallback).toHaveBeenCalledWith(
        expect.any(Object),
        expect.objectContaining({
            api_setCookie: false,
            logPacket: expect.any(String),
        }),
    );
    const packet = JSON.parse(mockServerLoggingCallback.mock.calls[0][1].logPacket);
    delete packet[0].timestamp;
    delete packet[1].timestamp;
    expect(packet).toEqual([
        {message: '[info] Test1', parameters: '', email: null},
        {message: '[info] Test2', parameters: '', email: null},
    ]);

    // Test the case where `isDebug` is `true` in `Log` instance and we pass `extraData` parameter
    DebugLog.info('Test2', false, {test: 'test'}, false, {test: 'test'});
    expect(mockServerLoggingCallback).toHaveBeenCalled();
    expect(mockClientLoggingCallback).toHaveBeenCalledWith('[info] Test2 - {"test":"test"}', {test: 'test'});
});

test('Test Log.alert()', () => {
    mockServerLoggingCallback.mockClear();
    Log.alert('Test2', {}, false);
    expect(mockServerLoggingCallback).toHaveBeenCalled();
    expect(mockServerLoggingCallback).toHaveBeenCalledWith(
        expect.any(Object),
        expect.objectContaining({
            api_setCookie: false,
            logPacket: expect.any(String),
        }),
    );
    const packet = JSON.parse(mockServerLoggingCallback.mock.calls[0][1].logPacket);
    delete packet[0].timestamp;
    expect(packet).toEqual([{message: '[alrt] Test2', parameters: {}, email: null}]);
});

test('Test Log.warn()', () => {
    mockServerLoggingCallback.mockClear();
    Log.warn('Test2');
    expect(mockServerLoggingCallback).toHaveBeenCalled();
    expect(mockServerLoggingCallback).toHaveBeenCalledWith(
        expect.any(Object),
        expect.objectContaining({
            api_setCookie: false,
            logPacket: expect.any(String),
        }),
    );
    const packet = JSON.parse(mockServerLoggingCallback.mock.calls[0][1].logPacket);
    delete packet[0].timestamp;
    expect(packet).toEqual([{message: '[warn] Test2', parameters: '', email: null}]);
});

test('Test Log.hmmm()', () => {
    mockServerLoggingCallback.mockClear();
    Log.hmmm('Test');
    Log.info('Test', true);
    expect(mockServerLoggingCallback).toHaveBeenCalled();
    expect(mockServerLoggingCallback).toHaveBeenCalledWith(
        expect.any(Object),
        expect.objectContaining({
            api_setCookie: false,
            logPacket: expect.any(String),
        }),
    );
    const packet = JSON.parse(mockServerLoggingCallback.mock.calls[0][1].logPacket);
    delete packet[0].timestamp;
    delete packet[1].timestamp;
    expect(packet).toEqual([
        {message: '[hmmm] Test', parameters: '', email: null},
        {message: '[info] Test', parameters: '', email: null},
    ]);
});

test('Test Log.client()', () => {
    Log.client('Test');
    expect(mockClientLoggingCallback).toHaveBeenCalled();
    expect(mockClientLoggingCallback).toHaveBeenCalledWith('Test', '');
});

test('Test oversized message is truncated before being sent to the server', () => {
    mockServerLoggingCallback.mockClear();
    const huge = 'x'.repeat(1_100_000);
    Log.info(huge, true);

    const packet = JSON.parse(mockServerLoggingCallback.mock.calls.at(-1)[1].logPacket);
    const sent = packet.at(-1).message;
    expect(byteLength(sent)).toBeLessThanOrEqual(1_000_000);
    expect(sent).toMatch(MARKER_REGEX);
});

test('Test debug client callback receives the full untruncated message', () => {
    const mockClient = jest.fn();
    const DebugLogInstance = new Logger({
        serverLoggingCallback: jest.fn(),
        clientLoggingCallback: mockClient,
        isDebug: true,
    });
    const huge = 'x'.repeat(1_100_000);
    DebugLogInstance.info(huge, true);

    // The local dev console should still get the full message so debugging isn't degraded.
    expect(mockClient.mock.calls[0][0].startsWith(`[info] ${huge}`)).toBe(true);
});

test('Test getContextEmail captures email per log line', () => {
    const mockCallback = jest.fn();
    const LogWithEmail = new Logger({
        serverLoggingCallback: mockCallback,
        clientLoggingCallback: jest.fn(),
        getContextEmail: () => 'test@example.com',
    });

    LogWithEmail.info('Test message', true);
    expect(mockCallback).toHaveBeenCalled();

    const packet = JSON.parse(mockCallback.mock.calls[0][1].logPacket);
    delete packet[0].timestamp;
    expect(packet).toEqual([{message: '[info] Test message', parameters: '', email: 'test@example.com'}]);
});

test('Test getContextEmail throwing does not break logging', () => {
    const mockCallback = jest.fn();
    const LogWithThrowingEmail = new Logger({
        serverLoggingCallback: mockCallback,
        clientLoggingCallback: jest.fn(),
        getContextEmail: () => {
            throw new Error('Failed to get email');
        },
    });

    // Should not throw
    LogWithThrowingEmail.info('Test message', true);
    expect(mockCallback).toHaveBeenCalled();

    const packet = JSON.parse(mockCallback.mock.calls[0][1].logPacket);
    delete packet[0].timestamp;
    expect(packet).toEqual([{message: '[info] Test message', parameters: '', email: null}]);
});

describe('truncateToByteSize', () => {
    test('returns the input unchanged when under the limit', () => {
        expect(truncateToByteSize('hello', 100)).toBe('hello');
    });

    test('returns the input unchanged when exactly at the limit', () => {
        const input = 'a'.repeat(50);
        expect(truncateToByteSize(input, 50)).toBe(input);
    });

    test('truncates and appends a byte marker when over the limit', () => {
        const out = truncateToByteSize('a'.repeat(100), 50);
        expect(out).toMatch(MARKER_REGEX);
        expect(byteLength(out)).toBeLessThanOrEqual(50);
    });

    test('reports the correct number of removed bytes', () => {
        const out = truncateToByteSize('a'.repeat(100), 50);
        const removed = Number(out.match(/truncated (\d+) bytes/)[1]);
        const keptBytes = byteLength(out.replace(MARKER_REGEX, ''));
        expect(keptBytes + removed).toBe(100);
    });

    test('never overflows maxSize across digit-count boundaries of N', () => {
        // Sizes chosen so `removed` lands on either side of 9->10 and 99->100.
        for (const maxSize of [30, 31, 32, 120, 121, 122]) {
            const out = truncateToByteSize('a'.repeat(1000), maxSize);
            expect(byteLength(out)).toBeLessThanOrEqual(maxSize);
        }
    });

    test('does not split multi-byte (astral) characters', () => {
        const out = truncateToByteSize('😀'.repeat(50), 100); // each 😀 is 4 UTF-8 bytes
        expect(byteLength(out)).toBeLessThanOrEqual(100);
        const keptPrefix = out.replace(MARKER_REGEX, '');
        // The kept prefix must contain only whole 😀 characters (no replacement char).
        expect(Array.from(keptPrefix).every((char) => char === '😀')).toBe(true);
    });

    test('handles 2-byte characters correctly', () => {
        const out = truncateToByteSize('é'.repeat(100), 60); // each é is 2 UTF-8 bytes
        expect(out).toMatch(MARKER_REGEX);
        expect(byteLength(out)).toBeLessThanOrEqual(60);
    });

    test('hard-truncates without a marker when maxSize is too small to fit one', () => {
        // maxSize (5) is smaller than the marker itself, so we drop the marker rather than
        // exceed the limit or return something larger than the input.
        const out = truncateToByteSize('abcdef', 5);
        expect(out).toBe('abcde');
        expect(byteLength(out)).toBeLessThanOrEqual(5);
        expect(out.length).toBeLessThanOrEqual('abcdef'.length);
    });

    test('never returns a result larger than the input or the limit for tiny maxSize', () => {
        const input = '😀😀😀'; // 12 UTF-8 bytes, no ASCII fallback
        for (const maxSize of [1, 2, 3, 4, 8]) {
            const out = truncateToByteSize(input, maxSize);
            expect(byteLength(out)).toBeLessThanOrEqual(maxSize);
            expect(byteLength(out)).toBeLessThanOrEqual(byteLength(input));
        }
    });
});
