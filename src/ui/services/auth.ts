import type { AuthConfig } from '../types';
import type { StudioProApi } from '@mendix/extensions-api';
import type { Microflows } from '@mendix/extensions-api';

export type AuthConstantRefs =
    | { mode: 'none' }
    | { mode: 'basic'; usernameRef: string; passwordRef: string }
    | { mode: 'token'; tokenRef: string; headerName: string; prefix: string };

function toBase64(value: string): string {
    return btoa(value);
}

// RFC 7230 token chars; strips anything that could inject extra headers.
export function sanitizeHeaderName(raw: string): string {
    return raw.replace(/[^\w!#$%&'*+\-.^`|~]/g, '').trim();
}

function toTokenHeaderValue(auth: Extract<AuthConfig, { mode: 'token' }>): string {
    const token = auth.token.trim();
    const prefix = auth.prefix.trim();
    const headerName = sanitizeHeaderName(auth.headerName) || 'Authorization';

    if (/^i3x\./i.test(token) && /^authorization$/i.test(headerName) && /^bearer$/i.test(prefix)) {
        return token;
    }

    return prefix ? `${prefix} ${token}`.trim() : token;
}

function buildAuthHeaderValue(auth: AuthConfig): { key: string; value: string } | null {
    if (auth.mode === 'none') {
        return null;
    }

    if (auth.mode === 'basic') {
        const basicToken = toBase64(`${auth.username}:${auth.password}`);
        return { key: 'Authorization', value: `Basic ${basicToken}` };
    }

    const headerName = sanitizeHeaderName(auth.headerName) || 'Authorization';
    return { key: headerName, value: toTokenHeaderValue(auth) };
}

export function buildI3xRequestHeaders(auth: AuthConfig): Record<string, string> {
    const headers: Record<string, string> = {
        accept: 'application/json',
    };

    const authHeader = buildAuthHeaderValue(auth);
    if (authHeader) {
        headers[authHeader.key] = authHeader.value;
    }

    return headers;
}

export async function configureHttpAuthForMicroflow(
    sp: StudioProApi,
    httpConfiguration: Microflows.HttpConfiguration,
    authRefs: AuthConstantRefs
): Promise<void> {
    if (authRefs.mode === 'basic') {
        httpConfiguration.useAuthentication = true;
        httpConfiguration.httpAuthenticationUserName = authRefs.usernameRef;
        httpConfiguration.authenticationPassword = authRefs.passwordRef;
    }

    if (authRefs.mode === 'token') {
        const authHeader = (await sp.app.model.microflows.createElement(
            'Microflows$HttpHeaderEntry'
        )) as Microflows.HttpHeaderEntry;
        authHeader.key = authRefs.headerName;
        authHeader.value = authRefs.prefix ? `'${authRefs.prefix} ' + ${authRefs.tokenRef}` : authRefs.tokenRef;
        httpConfiguration.headerEntries.push(authHeader);
    }
}


