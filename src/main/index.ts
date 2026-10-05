import { IComponent, getStudioProApi } from "@mendix/extensions-api";
import { registerAiTools, showAiToolStatus } from "./aiTools";

export const component: IComponent = {
    async loaded(componentContext) {
        const studioPro = getStudioProApi(componentContext);

        await studioPro.ui.extensionsMenu.add({
            menuId: "i3X-Connector.MainMenu",
            caption: "i3X Connector",
            action: async () => {
                await studioPro.ui.tabs.open(
                    {
                        title: "i3X Connector"
                    },
                    {
                        componentName: "extension/i3X-Connector",
                        uiEntrypoint: "list"
                    }
                );
            }
        });

        // Spike diagnostics; remove once the Maia tools are confirmed working.
        await studioPro.ui.extensionsMenu.add({
            menuId: "i3X-Connector.AiToolStatus",
            caption: "i3X Connector: AI tool status",
            action: async () => { await showAiToolStatus(studioPro); }
        });

        await registerAiTools(studioPro);
    }
}
