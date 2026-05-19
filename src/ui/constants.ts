export const IMPLEMENTATION_MODULE = 'i3X_Implementation';

// Mendix constant names stored in the i3X_Implementation module
export const CONSTANT_API_BASE_URL = 'API_BaseUrl';
export const CONSTANT_API_USERNAME = 'API_Username';
export const CONSTANT_API_PASSWORD = 'API_Password';
export const CONSTANT_API_TOKEN = 'API_Token';

// Markers used during JSON serialization to preserve decimal representation
export const DECIMAL_WRITE_MARKER = '__I3X_DECIMAL_WRITE__';
export const DECIMAL_INTEGER_MARKER = '__I3X_DECIMAL_INTEGER__';

// Mendix JSON structure path segment for array items and object roots
export const OBJECT_PATH = '(Object)';

// Extra HTTP headers for JSON REST calls (used in microflow extraHeaders)
export const JSON_EXTRA_HEADERS: Array<{ key: string; value: string }> = [
    { key: 'Accept', value: "'application/json'" },
    { key: 'Content-Type', value: "'application/json'" },
];
