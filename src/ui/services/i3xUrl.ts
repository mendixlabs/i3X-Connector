const KNOWN_SUFFIX_REGEXES = [
    /\/objecttypes$/i,
    /\/objects\/value$/i,
    /\/objects\/history$/i,
    /\/objects\/list$/i,
    /\/objects\/related$/i,
    /\/objects\/[^/]+\/value$/i,
    /\/objects$/i,
];

function trimTrailingSlashes(path: string): string {
    return path.replace(/\/+$/, '');
}

function stripKnownSuffix(path: string): string {
    const current = trimTrailingSlashes(path);
    for (const regex of KNOWN_SUFFIX_REGEXES) {
        if (regex.test(current)) {
            return current.replace(regex, '');
        }
    }
    return current;
}

function toNormalizedPath(path: string): string {
    const stripped = stripKnownSuffix(path);
    const withI3x = /\/i3x$/i.test(stripped) ? stripped : `${stripped}/i3x`;
    return withI3x.replace(/\/{2,}/g, '/') || '/i3x';
}

export function normalizeI3xBaseUrl(inputUrl: string): string | null {
    try {
        const parsed = new URL(inputUrl.trim());
        parsed.pathname = toNormalizedPath(parsed.pathname);
        parsed.search = '';
        parsed.hash = '';
        return `${trimTrailingSlashes(parsed.toString())}/`;
    } catch {
        return null;
    }
}

function buildFromBase(apiBaseUrl: string, endpointPath: string): URL | null {
    const normalizedBase = normalizeI3xBaseUrl(apiBaseUrl);
    if (!normalizedBase) {
        return null;
    }

    const parsed = new URL(normalizedBase);
    const basePath = trimTrailingSlashes(parsed.pathname);
    parsed.pathname = `${basePath}${endpointPath}`.replace(/\/{2,}/g, '/');
    parsed.search = '';
    parsed.hash = '';
    return parsed;
}

export function getObjectTypesUrl(apiBaseUrl: string): string | null {
    return buildFromBase(apiBaseUrl, '/objecttypes')?.toString() ?? null;
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