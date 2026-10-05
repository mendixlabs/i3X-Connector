import type { StudioProApi } from "@mendix/extensions-api";

export const REGISTER_AI_TOOLS_PERMISSION = "register-ai-tools";

// The extensions-api declares this type by importing it from @mendix/maia-agent, which is not
// published, so it resolves to `any`. Shape taken from the Tools API docs and the 11.15 runtime.
export interface ExternalAIToolDefinition {
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
    run(input: Record<string, unknown>): Promise<string>;
    inProgressMessage?: string | ((input: Record<string, unknown>) => Promise<string>);
}

function buildTools(): ExternalAIToolDefinition[] {
    return [
        {
            name: "i3x_ping",
            description: "Test tool for the i3X Connector extension. Returns a fixed message so you can confirm the extension's tools are reachable.",
            inputSchema: { type: "object", properties: {}, additionalProperties: false },
            inProgressMessage: "Pinging the i3X Connector...",
            run: async () => "i3X Connector tools are registered and reachable.",
        },
    ];
}

async function isRegisterPermissionGranted(sp: StudioProApi): Promise<boolean> {
    const permissions = await sp.ui.extensionPermissions.getPermissions();
    return permissions.some(p => p.name === REGISTER_AI_TOOLS_PERMISSION && p.granted);
}

// Spike diagnostics: Studio Pro's log does not capture extension console output.
const statusLog: string[] = [];
function logStatus(message: string): void {
    statusLog.push(`${new Date().toLocaleTimeString()} ${message}`);
}

export async function showAiToolStatus(sp: StudioProApi): Promise<void> {
    let permissionsText: string;
    try {
        const permissions = await sp.ui.extensionPermissions.getPermissions();
        permissionsText = permissions.length === 0
            ? "(none reported)"
            : permissions.map(p => `${p.name}: ${p.granted ? "granted" : "not granted"}`).join("\n");
    } catch (error) {
        permissionsText = `getPermissions failed: ${String(error)}`;
    }
    await sp.ui.messageBoxes.show(
        "info",
        `Permissions:\n${permissionsText}`,
        statusLog.length === 0 ? "(no registration events)" : statusLog.join("\n")
    );
}

// registerTool throws when the permission is not granted, so registration waits for the grant.
// After a successful registration the runtime handles later revoke/grant changes itself.
export async function registerAiTools(sp: StudioProApi): Promise<void> {
    let registered = false;

    const tryRegister = async () => {
        if (registered) return;
        if (!(await isRegisterPermissionGranted(sp))) {
            logStatus(`'${REGISTER_AI_TOOLS_PERMISSION}' not granted; waiting for permissionsChanged.`);
            return;
        }
        registered = true;
        for (const tool of buildTools()) {
            try {
                await sp.ai.tools.registerTool(tool);
                logStatus(`Registered '${tool.name}'.`);
            } catch (error) {
                logStatus(`Could not register '${tool.name}': ${String(error)}`);
            }
        }
    };

    logStatus("Starting AI tool registration.");
    try {
        sp.ui.extensionPermissions.addEventListener("permissionsChanged", () => {
            logStatus("permissionsChanged received.");
            void tryRegister().catch(error => logStatus(`Registration failed: ${String(error)}`));
        });
        await tryRegister();
    } catch (error) {
        logStatus(`Registration failed: ${String(error)}`);
    }
}
