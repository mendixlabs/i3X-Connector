function trimTrailingSlashes(path: string): string {
    return path.replace(/\/+$/, '');
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

export function getObjectsHistoryUrl(apiBaseUrl: string): string | null {
    return buildFromBase(apiBaseUrl, '/objects/history')?.toString() ?? null;
}

export function getObjectWriteUrl(apiBaseUrl: string, elementId: string): string | null {
    return buildFromBase(apiBaseUrl, `/objects/${encodeURIComponent(elementId)}/value`)?.toString() ?? null;
}

export function getObjectWriteUrlTemplate(apiBaseUrl: string): string | null {
    const writeUrl = buildFromBase(apiBaseUrl, '/objects/{1}/value')?.toString() ?? null;
    return writeUrl?.replace(/%7B1%7D/gi, '{1}') ?? null;
}
