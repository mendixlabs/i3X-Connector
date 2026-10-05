import type { ConnectionConfig } from '../ui/types/connection';

// Sent from the UI tab to the main entry point after a successful connect, so the
// Maia tools (registered in main) can reach the same i3X server without asking for secrets.
export interface ConnectionMessage {
    type: 'i3x.connection';
    config: ConnectionConfig;
}

export function isConnectionMessage(value: unknown): value is ConnectionMessage {
    return typeof value === 'object'
        && value !== null
        && (value as { type?: unknown }).type === 'i3x.connection'
        && typeof (value as { config?: unknown }).config === 'object';
}
