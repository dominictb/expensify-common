type Parameters = string | Record<string, unknown> | Array<Record<string, unknown>> | Error;
type ServerLoggingCallbackOptions = {
    api_setCookie: boolean;
    logPacket: string;
};
type ServerLoggingCallback = (logger: Logger, options: ServerLoggingCallbackOptions) => Promise<{requestID: string}> | undefined;
type ClientLoggingCallBack = (message: string, extraData: Parameters) => void;
type LogLine = {
    message: string;
    parameters: Parameters;
    onlyFlushWithOthers?: boolean;
    timestamp: Date;
    email?: string | null;
};
type LoggerOptions = {
    serverLoggingCallback: ServerLoggingCallback;
    isDebug: boolean;
    clientLoggingCallback: ClientLoggingCallBack;
    maxLogLinesBeforeFlush?: number;
    getContextEmail?: () => string | null;
};

const MAX_LOG_LINES_BEFORE_FLUSH = 50;

// The server rejects any single serialized log line larger than 1,048,576 bytes (1 MiB).
// We enforce a lower cap on the JSON-serialized line (message + parameters + metadata, with
// escaping) so it stays comfortably under the server limit.
const MAX_LOG_LINE_BYTES = 1_000_000;

/**
 * Gets the UTF-8 byte length of a single unicode code point.
 */
function codePointByteSize(code: number): number {
    if (code >= 0x10000) {
        return 4;
    }
    if (code >= 0x800) {
        return 3;
    }
    if (code >= 0x80) {
        return 2;
    }
    return 1;
}

/**
 * Gets the total UTF-8 byte length of a string.
 */
function utf8ByteLength(input: string): number {
    return Array.from(input).reduce((sum, char) => sum + codePointByteSize(char.codePointAt(0) ?? 0), 0);
}

/**
 * UTF-8 byte length of a single code point *after JSON string escaping*, matching the output of
 * JSON.stringify: `"` `\` and the short control escapes are 2 bytes, other control characters
 * and lone surrogates become `\uXXXX` (6 bytes), everything else is its plain UTF-8 size.
 */
function jsonEscapedByteSize(code: number): number {
    if (code === 0x22 || code === 0x5c || code === 0x08 || code === 0x09 || code === 0x0a || code === 0x0c || code === 0x0d) {
        return 2;
    }
    if (code < 0x20 || (code >= 0xd800 && code <= 0xdfff)) {
        return 6;
    }
    return codePointByteSize(code);
}

/**
 * Truncates `message` so that the SERIALIZED `line` fits within maxSize bytes. The serialized
 * line is `overhead(empty message) + JSON-escaped bytes of the message`, so we measure the
 * message's escaped size directly (single pass) instead of repeatedly re-serializing the whole
 * line. This is exact for JSON.stringify's escaping and avoids the cost of a binary search.
 */
function truncateMessageToFitLine(line: LogLine, message: string, maxSize: number): string {
    const overhead = utf8ByteLength(JSON.stringify({...line, message: ''}));
    const totalRawBytes = utf8ByteLength(message);

    // Marker "...[truncated N bytes]" is escape-free ASCII, so its serialized size equals its
    // raw size = 21 + digits(N). Reserve for the max possible N so the final line never overflows.
    const MARKER_STATIC_BYTES = 21;
    const reservedMarkerBytes = MARKER_STATIC_BYTES + String(totalRawBytes).length;
    const contentBudget = maxSize - overhead - reservedMarkerBytes;

    if (contentBudget <= 0) {
        return '';
    }

    // Keep whole code points until the escaped budget is exhausted (never splits a character).
    let keptUnits = 0;
    let keptEscapedBytes = 0;
    let keptRawBytes = 0;
    for (let i = 0; i < message.length; ) {
        const code = message.codePointAt(i) ?? 0;
        const escapedBytes = jsonEscapedByteSize(code);
        if (keptEscapedBytes + escapedBytes > contentBudget) {
            break;
        }
        keptEscapedBytes += escapedBytes;
        keptRawBytes += codePointByteSize(code);
        const units = code > 0xffff ? 2 : 1;
        i += units;
        keptUnits += units;
    }

    if (keptRawBytes >= totalRawBytes) {
        return message;
    }

    const removed = totalRawBytes - keptRawBytes;
    return `${message.slice(0, keptUnits)}...[truncated ${removed} bytes]`;
}

/**
 * Serializes a log line while enforcing the per-line byte limit on the *serialized* line — what
 * the server measures — covering the message, parameters and metadata plus JSON-escaping
 * overhead. Returns the JSON string for the line (reused to build the packet, so each line is
 * serialized only once). Oversized `parameters` (structured data we can't safely truncate
 * mid-JSON) are replaced with a size marker; the message is then truncated to fit the remainder.
 */
function serializeLineWithinByteLimit(line: LogLine, maxSize: number): string {
    const serialized = JSON.stringify(line);

    // Cheap fast path: at most 3 UTF-8 bytes per UTF-16 code unit, so if 3 * length fits the
    // line is definitely under the limit and we avoid the exact byte count entirely.
    if (serialized.length * 3 <= maxSize || utf8ByteLength(serialized) <= maxSize) {
        return serialized;
    }

    const result: LogLine = {...line};

    // If the line is over the limit even with an empty message, the bulk is in `parameters` —
    // replace it with a marker so the (human-readable) message is what we keep room for.
    if (utf8ByteLength(JSON.stringify({...result, message: ''})) > maxSize) {
        const parametersByteSize = utf8ByteLength(JSON.stringify(result.parameters ?? ''));
        result.parameters = {truncated: true, originalByteSize: parametersByteSize};
    }

    result.message = truncateMessageToFitLine(result, line.message, maxSize);
    return JSON.stringify(result);
}

export default class Logger {
    logLines: LogLine[];

    serverLoggingCallback: ServerLoggingCallback;

    clientLoggingCallback: ClientLoggingCallBack;

    isDebug: boolean;

    maxLogLinesBeforeFlush: number;

    getContextEmail?: () => string | null;

    constructor({serverLoggingCallback, isDebug, clientLoggingCallback, maxLogLinesBeforeFlush, getContextEmail}: LoggerOptions) {
        // An array of log lines that limits itself to a certain number of entries (deleting the oldest)
        this.logLines = [];
        this.serverLoggingCallback = serverLoggingCallback;
        this.clientLoggingCallback = clientLoggingCallback;
        this.isDebug = isDebug;
        this.maxLogLinesBeforeFlush = maxLogLinesBeforeFlush || MAX_LOG_LINES_BEFORE_FLUSH;
        this.getContextEmail = getContextEmail;

        // Public Methods
        this.info = this.info.bind(this);
        this.alert = this.alert.bind(this);
        this.warn = this.warn.bind(this);
        this.hmmm = this.hmmm.bind(this);
        this.client = this.client.bind(this);
    }

    /**
     * Ask the server to write the log message
     */
    logToServer(): void {
        // We do not want to call the server with an empty list or if all the lines has onlyFlushWithOthers=true
        if (!this.logLines.length || this.logLines?.every((l) => l.onlyFlushWithOthers)) {
            return;
        }

        // We don't care about log setting web cookies so let's define it as false.
        // Serialize each line while bounding it to the server's per-line size limit (covers
        // message, parameters and JSON-escaping overhead). Building the packet by joining the
        // per-line JSON keeps each line serialized only once — identical output to
        // JSON.stringify(array) with no extra pass.
        const serializedLines = this.logLines?.map((l) => {
            // eslint-disable-next-line no-param-reassign
            delete l.onlyFlushWithOthers;
            return serializeLineWithinByteLimit(l, MAX_LOG_LINE_BYTES);
        });
        this.logLines = [];
        const promise = this.serverLoggingCallback(this, {
            api_setCookie: false,
            logPacket: `[${serializedLines.join(',')}]`,
        });
        if (!promise) {
            return;
        }
        promise.then((response) => {
            if (!response.requestID) {
                return;
            }
            this.info('Previous log requestID', false, {requestID: response.requestID}, true);
        });
    }

    /**
     * Add a message to the list
     * @param parameters The parameters associated with the message
     * @param forceFlushToServer Should we force flushing all logs to server?
     * @param onlyFlushWithOthers A request will never be sent to the server if all loglines have this set to true
     */
    add(message: string, parameters: Parameters, forceFlushToServer: boolean, onlyFlushWithOthers = false, extraData: Parameters = '') {
        // Capture the user's email at the moment this specific log line is created
        // This ensures the log retains user context even if the session is cleared before sending
        let email: string | null = null;
        try {
            email = this.getContextEmail ? this.getContextEmail() : null;
        } catch {
            // Silently fail if getContextEmail throws - logging should not crash
        }

        const length = this.logLines.push({
            message,
            parameters,
            onlyFlushWithOthers,
            timestamp: new Date(),
            email,
        });

        if (this.isDebug) {
            this.client(`${message} - ${JSON.stringify(parameters)}`, extraData);
        }

        // If we're over the limit, flush the logs
        if (length > this.maxLogLinesBeforeFlush || forceFlushToServer) {
            this.logToServer();
        }
    }

    /**
     * Caches an informational message locally, to be sent to the server if
     * needed later.
     *
     * @param message The message to log.
     * @param sendNow if true, the message will be sent right away.
     * @param parameters The parameters to send along with the message
     * @param onlyFlushWithOthers A request will never be sent to the server if all loglines have this set to true
     */
    info(message: string, sendNow = false, parameters: Parameters = '', onlyFlushWithOthers = false, extraData: Parameters = '') {
        const msg = `[info] ${message}`;
        this.add(msg, parameters, sendNow, onlyFlushWithOthers, extraData);
    }

    /**
     * Logs an alert.
     *
     * @param message The message to alert.
     * @param parameters The parameters to send along with the message
     * @param includeStackTrace Must be disabled for testing
     */
    alert(message: string, parameters: Parameters = {}, includeStackTrace = true) {
        const msg = `[alrt] ${message}`;
        const params = parameters;

        if (includeStackTrace && typeof params === 'object' && !Array.isArray(params)) {
            params.stack = JSON.stringify(new Error().stack);
        }

        this.add(msg, params, true);
    }

    /**
     * Logs a warn.
     *
     * @param message The message to warn.
     * @param parameters The parameters to send along with the message
     */
    warn(message: string, parameters: Parameters = '') {
        const msg = `[warn] ${message}`;
        this.add(msg, parameters, true);
    }

    /**
     * Logs a hmmm.
     *
     * @param message The message to hmmm.
     * @param parameters The parameters to send along with the message
     */
    hmmm(message: string, parameters: Parameters = '') {
        const msg = `[hmmm] ${message}`;
        this.add(msg, parameters, false);
    }

    /**
     * Logs a message in the browser console.
     *
     * @param message The message to log.
     */
    client(message: string, extraData: Parameters = '') {
        if (!this.clientLoggingCallback) {
            return;
        }

        this.clientLoggingCallback(message, extraData);
    }
}

// Exported for unit testing.
export {truncateMessageToFitLine, serializeLineWithinByteLimit, utf8ByteLength, MAX_LOG_LINE_BYTES};
