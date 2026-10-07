import type { StudioProApi } from "@mendix/extensions-api";
import type { ConnectionConfig } from "../ui/types/connection";
import { isConnectionMessage, isConnectionRequestMessage, type ConnectionMessage } from "../shared/messages";

// Kept in memory only. The user connects once per Studio Pro session, either in the
// i3X Connector tab or through the i3x_connect tool, and the latest connection wins.
let lastConnection: ConnectionConfig | null = null;

export function getLastConnection(): ConnectionConfig | null {
    return lastConnection;
}

export function setLastConnection(connection: ConnectionConfig): void {
    lastConnection = connection;
}

// Tells an open i3X Connector tab about a connection made by the i3x_connect tool.
export async function shareConnectionWithTab(sp: StudioProApi, connection: ConnectionConfig): Promise<void> {
    const message: ConnectionMessage = { type: "i3x.connection", config: connection };
    await sp.ui.messagePassing.sendMessage(message);
}

export async function listenForConnection(sp: StudioProApi): Promise<void> {
    await sp.ui.messagePassing.addMessageHandler<unknown>(async ({ messageId, message }) => {
        if (isConnectionMessage(message)) {
            setLastConnection(message.config);
        } else if (isConnectionRequestMessage(message) && lastConnection) {
            await sp.ui.messagePassing.sendResponse(messageId, lastConnection);
        }
    });
}
