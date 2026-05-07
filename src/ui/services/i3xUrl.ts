function trimTrailingSlashes(path: string): string {
    return path.replace(/\/+$/, '');
}

interface I3xSuccessEnvelope<T> {
    success: boolean;
    result: T | null;
}

/**
 * Official i3X v1 GET endpoints return payloads in { success, result }.
 * We only support that envelope shape.
 */
export function unwrapI3xResult<T>(raw: unknown): T | null {
    if (raw !== null && typeof raw === 'object' && 'success' in raw && 'result' in raw) {
        return (raw as I3xSuccessEnvelope<T>).result;
    }

    throw new Error('Expected official i3X v1 response envelope { success, result }.');
}

function buildFromBase(apiBaseUrl: string, endpointPath: string): URL | null {
    try {
        const parsed = new URL(apiBaseUrl.trim());
        const basePath = trimTrailingSlashes(parsed.pathname);
        parsed.pathname = `${basePath}${endpointPath}`.replace(/\/{2,}/g, '/');
        parsed.search = '';
        parsed.hash = '';
        return parsed;
    } catch {
        return null;
    }
}

export function getObjectTypesUrl(apiBaseUrl: string): string | null {
    return buildFromBase(apiBaseUrl, '/objecttypes')?.toString() ?? null;
}

export function getApiBaseUrl(apiBaseUrl: string): string | null {
    return buildFromBase(apiBaseUrl, '')?.toString() ?? null;
}

export function getObjectsUrl(apiBaseUrl: string, typeId: string): string | null {
    const parsed = buildFromBase(apiBaseUrl, '/objects');
    if (!parsed) {
        return null;
    }
    parsed.searchParams.set('typeElementId', typeId);
    return parsed.toString();
}

export function getObjectsValueUrl(apiBaseUrl: string): string | null {
    return buildFromBase(apiBaseUrl, '/objects/value')?.toString() ?? null;
}
