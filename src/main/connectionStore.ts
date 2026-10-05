import type { StudioProApi } from "@mendix/extensions-api";
import type { ConnectionConfig } from "../ui/types/connection";
import { isConnectionMessage } from "../shared/messages";

// Kept in memory only, so credentials never reach disk or the Maia chat.
// The user connects once per Studio Pro session in the i3X Connector tab.
let lastConnection: ConnectionConfig | null = null;

export function getLastConnection(): ConnectionConfig | null {
    return lastConnection;
}

export async function listenForConnection(sp: StudioProApi): Promise<void> {
    await sp.ui.messagePassing.addMessageHandler<unknown>(async ({ message }) => {
        if (isConnectionMessage(message)) {
            lastConnection = message.config;
        }
    });
}
