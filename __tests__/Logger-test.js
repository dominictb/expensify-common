import {TextEncoder} from 'util';
import Logger, {truncateMessageToFitLine, enforceLineByteLimit, MAX_LOG_LINE_BYTES} from '../lib/Logger';

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
    const line = packet.at(-1);
    // The whole serialized line (what the server measures) must be under the limit.
    expect(byteLength(JSON.stringify(line))).toBeLessThanOrEqual(1_000_000);
    expect(line.message).toMatch(MARKER_REGEX);
});

test('Test oversized parameters are bounded before being sent to the server', () => {
    mockServerLoggingCallback.mockClear();
    const bigParams = {blob: 'A'.repeat(1_100_000)};
    Log.info('small message', true, bigParams);

    const packet = JSON.parse(mockServerLoggingCallback.mock.calls.at(-1)[1].logPacket);
    const line = packet.at(-1);
    expect(byteLength(JSON.stringify(line))).toBeLessThanOrEqual(1_000_000);
    // The large parameters are replaced with a size marker; the message is kept.
    expect(line.parameters).toEqual({truncated: true, originalByteSize: expect.any(Number)});
    expect(line.message).toBe('[info] small message');
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

describe('truncateMessageToFitLine', () => {
    const makeLine = (overrides) => ({message: '', parameters: '', timestamp: new Date(0), email: null, ...overrides});
    const serializedByteLength = (line) => byteLength(JSON.stringify(line));

    test('returns the message unchanged when the line already fits', () => {
        const message = 'hello world';
        expect(truncateMessageToFitLine(makeLine({message}), message, MAX_LOG_LINE_BYTES)).toBe(message);
    });

    test('truncates with a byte marker so the serialized line fits', () => {
        const message = 'a'.repeat(1000);
        const line = makeLine({message});
        const truncated = truncateMessageToFitLine(line, message, 200);
        expect(truncated).toMatch(MARKER_REGEX);
        expect(serializedByteLength({...line, message: truncated})).toBeLessThanOrEqual(200);
    });

    test('reports the correct number of removed raw bytes', () => {
        const message = 'a'.repeat(1000);
        const truncated = truncateMessageToFitLine(makeLine({message}), message, 200);
        const removed = Number(truncated.match(/truncated (\d+) bytes/)[1]);
        const keptBytes = byteLength(truncated.replace(MARKER_REGEX, ''));
        expect(keptBytes + removed).toBe(1000);
    });

    test('does not split multi-byte (astral) characters', () => {
        const message = '😀'.repeat(200); // each 😀 is 4 UTF-8 bytes
        const line = makeLine({message});
        const truncated = truncateMessageToFitLine(line, message, 200);
        expect(serializedByteLength({...line, message: truncated})).toBeLessThanOrEqual(200);
        const keptPrefix = truncated.replace(MARKER_REGEX, '');
        expect(Array.from(keptPrefix).every((char) => char === '😀')).toBe(true);
    });

    test('accounts for JSON escaping (quotes serialize to 2 bytes each)', () => {
        const message = '"'.repeat(500);
        const line = makeLine({message});
        const truncated = truncateMessageToFitLine(line, message, 200);
        expect(serializedByteLength({...line, message: truncated})).toBeLessThanOrEqual(200);
    });

    test('keeps the serialized line within maxSize across digit-boundary sizes', () => {
        const message = 'a'.repeat(2000);
        const line = makeLine({message});
        for (const maxSize of [120, 121, 122, 130, 220, 221, 500, 1024]) {
            const truncated = truncateMessageToFitLine(line, message, maxSize);
            expect(serializedByteLength({...line, message: truncated})).toBeLessThanOrEqual(maxSize);
        }
    });
});

describe('enforceLineByteLimit', () => {
    const serializedByteLength = (line) => byteLength(JSON.stringify(line));
    const makeLine = (overrides) => ({message: '', parameters: '', timestamp: new Date(0), email: null, ...overrides});

    it('returns the same line unchanged when it already fits', () => {
        const line = makeLine({message: '[info] hi', parameters: {a: 1}});
        expect(enforceLineByteLimit(line, MAX_LOG_LINE_BYTES)).toBe(line);
    });

    it('truncates based on serialized (escaped) size, not raw size', () => {
        const maxSize = 300;
        // All double-quotes: raw byte length == maxSize (a naive raw-byte cap would leave this
        // unchanged), but each quote serializes to 2 bytes so the serialized line is ~2x over.
        const message = '"'.repeat(maxSize);
        const line = makeLine({message});
        expect(byteLength(message)).toBeLessThanOrEqual(maxSize); // raw fits...
        expect(serializedByteLength(line)).toBeGreaterThan(maxSize); // ...serialized does not

        const result = enforceLineByteLimit(line, maxSize);
        expect(serializedByteLength(result)).toBeLessThanOrEqual(maxSize);
        expect(result.message).toMatch(MARKER_REGEX);
    });

    it('replaces oversized parameters with a size marker and keeps the message', () => {
        const maxSize = 300;
        const line = makeLine({message: '[info] short message', parameters: {blob: 'A'.repeat(1000)}});
        const result = enforceLineByteLimit(line, maxSize);
        expect(serializedByteLength(result)).toBeLessThanOrEqual(maxSize);
        expect(result.parameters).toEqual({truncated: true, originalByteSize: expect.any(Number)});
        expect(result.message).toBe('[info] short message');
    });

    it('bounds the line when both message and parameters are large', () => {
        const maxSize = 300;
        const line = makeLine({message: 'M'.repeat(1000), parameters: {blob: 'P'.repeat(1000)}});
        const result = enforceLineByteLimit(line, maxSize);
        expect(serializedByteLength(result)).toBeLessThanOrEqual(maxSize);
    });

    it('handles control characters that expand 6x under JSON escaping', () => {
        const maxSize = 200;
        // \x01 is 1 raw byte but serializes to the 6-byte escape "\u0001".
        const message = '\x01'.repeat(maxSize);
        const line = makeLine({message});
        expect(byteLength(message)).toBeLessThanOrEqual(maxSize); // raw fits
        expect(serializedByteLength(line)).toBeGreaterThan(maxSize); // serialized does not
        const result = enforceLineByteLimit(line, maxSize);
        expect(serializedByteLength(result)).toBeLessThanOrEqual(maxSize);
    });
});
