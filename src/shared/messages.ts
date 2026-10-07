import type { ConnectionConfig } from '../ui/types/connection';

// Shares a connection between the UI tab and the Maia tools in main, in both directions:
// the tab sends it after Load, and main sends it after the i3x_connect tool connects.
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

// Sent by the tab when it opens, so it can show a connection the Maia tools made before.
// Main answers with sendResponse and the current ConnectionConfig, if there is one.
export interface ConnectionRequestMessage {
    type: 'i3x.connectionRequest';
}

export function isConnectionRequestMessage(value: unknown): value is ConnectionRequestMessage {
    return typeof value === 'object'
        && value !== null
        && (value as { type?: unknown }).type === 'i3x.connectionRequest';
}
