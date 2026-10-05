import { IComponent, getStudioProApi } from "@mendix/extensions-api";
import { registerAiTools } from "./aiTools";
import { listenForConnection } from "./connectionStore";
import { initStudioPro } from "../ui/services/studioProContext";

export const component: IComponent = {
    async loaded(componentContext) {
        const studioPro = getStudioProApi(componentContext);
        // The Maia tools run the same generators as the tab, so main needs its own handle.
        initStudioPro(studioPro);
        await listenForConnection(studioPro);

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

        await registerAiTools(studioPro);
    }
}
