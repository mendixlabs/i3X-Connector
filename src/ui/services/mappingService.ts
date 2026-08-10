import { IMPLEMENTATION_MODULE } from '../constants';
import { getStudioPro } from './studioProContext';

export interface JsonStructureResult {
    jsonStructureId: string;
    created: boolean;
}

export async function createOrUpdateJsonStructure(
    structureName: string,
    jsonSnippet: string,
    parentId: string
): Promise<JsonStructureResult> {
    const sp = getStudioPro();
    const existingInfo = (await sp.app.model.jsonStructures.getUnitsInfo()).find(
        unit => unit.moduleName === IMPLEMENTATION_MODULE && unit.name === structureName
    );
    if (existingInfo) {
        const loaded = await sp.app.model.jsonStructures.loadAll(unit => unit.$ID === existingInfo.$ID);
        if (loaded.length > 0) {
            loaded[0].jsonSnippet = jsonSnippet;
            await sp.app.model.jsonStructures.save(loaded[0]);
            return { jsonStructureId: loaded[0].$ID, created: false };
        }
        return { jsonStructureId: existingInfo.$ID, created: false };
    }

    const created = await sp.app.model.jsonStructures.addJsonStructure(parentId, {
        name: structureName,
        jsonSnippet,
    });
    await sp.app.model.jsonStructures.save(created);
    return { jsonStructureId: created.$ID, created: true };
}
