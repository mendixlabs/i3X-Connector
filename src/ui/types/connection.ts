export const IMPLEMENTATION_MODULE = 'i3X_Implementation';

export type AuthConfig =
    | { mode: 'none' }
    | { mode: 'basic'; username: string; password: string }
    | { mode: 'token'; token: string; headerName: string; prefix: string };

export interface ConnectionConfig {
    apiBaseUrl: string;
    auth: AuthConfig;
}
