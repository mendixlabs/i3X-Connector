import type { StudioProApi } from "@mendix/extensions-api";
import { buildI3xTools } from "./i3xTools";

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

async function isRegisterPermissionGranted(sp: StudioProApi): Promise<boolean> {
    const permissions = await sp.ui.extensionPermissions.getPermissions();
    return permissions.some(p => p.name === REGISTER_AI_TOOLS_PERMISSION && p.granted);
}

// registerTool throws when the permission is not granted, so registration waits for the grant.
// After a successful registration the runtime handles later revoke/grant changes itself.
export async function registerAiTools(sp: StudioProApi): Promise<void> {
    let registered = false;

    const tryRegister = async () => {
        if (registered || !(await isRegisterPermissionGranted(sp))) return;
        registered = true;
        for (const tool of buildI3xTools(sp)) {
            try {
                await sp.ai.tools.registerTool(tool);
            } catch (error) {
                console.error(`i3X Connector: could not register AI tool '${tool.name}'.`, error);
            }
        }
    };

    try {
        sp.ui.extensionPermissions.addEventListener("permissionsChanged", () => {
            tryRegister().catch(error => console.error("i3X Connector: AI tool registration failed.", error));
        });
        await tryRegister();
    } catch (error) {
        // A missing grant or registry failure must not break the menu item or the tab.
        console.error("i3X Connector: AI tool registration failed.", error);
    }
}
