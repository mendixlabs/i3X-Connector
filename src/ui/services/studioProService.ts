import type { DataTypes, DomainModels, Mappings, Microflows } from '@mendix/extensions-api';
import {
    IMPLEMENTATION_MODULE,
    DECIMAL_WRITE_MARKER,
    DECIMAL_INTEGER_MARKER,
    OBJECT_PATH,
    JSON_EXTRA_HEADERS,
} from '../constants';
import {
    isArrayProperty,
    isGroupProperty,
    type AnyProperty,
    type ConnectionConfig,
    type LeafProperty,
    type ObjectType,
    type ObjectTypeSchema,
} from '../types';
import { getObjectsUrl, getObjectsValueUrl, unwrapI3xResult } from './i3xUrl';
import { buildI3xRequestHeaders } from './auth';
import {
    buildValueQueryHttpRequestBody,
    buildValueQueryMicroflowRequestBody,
    buildHistoryMicroflowRequestBody,
    populateMicroflowWithRestCall,
} from './microflowBuilder';
import { buildObjectTypeFromSample, buildSyntheticValueResponse, extractValueQueryPayload } from './schemaInference';
import { ensureEndpointConstants, ensureObjectTypeArtifactContext } from './endpointConfiguration';
import { getStudioPro } from './studioProContext';
import { countDirectLeafProperties, getAttributeType, getChildPropertiesIfAny, toModelName } from './modelUtils';
import type { ImplementEntityResult, QueryValuesMicroflowResult } from './artifactResults';
import { createOrUpdateJsonStructure, type JsonStructureResult } from './mappingService';
import {
    buildSubscriptionRestDefinitions,
    buildSubscriptionSyncRequestExpression,
    type SubscriptionArtifactNames,
    type SubscriptionRestDefinition,
} from './subscriptionTemplates';

export { getStudioPro, initStudioPro } from './studioProContext';
export { MENDIX_LONG_MAX } from './modelUtils';
export { summarizeArtifactResult } from './artifactResults';
export type { ArtifactCreationResult, ImplementEntityResult, QueryValuesMicroflowResult } from './artifactResults';

/**
 * Coordinates translating i3X schemas and live samples into Mendix artifacts.
 * Keep this file focused on orchestration and domain-model generation.
 */


interface JsonSampleResponse {
    parsed: unknown;
    rawText: string;
}

interface ValueQueryArtifactsResult extends DomainModelResult {
    jsonStructureName: string;
    jsonStructureCreated: boolean;
    importMappingName: string;
    importMappingCreated: boolean;
    importMappingId: string;
}


// ── Layout constants ──────────────────────────────────────────────────────────
const ATTR_ROW_H  = 20;   // px per attribute row
const ENTITY_HDR_H = 30;  // px for entity header
const H_GAP        = 140; // horizontal gap between entity columns
const V_GAP        = 80;  // vertical gap between entities
const BASE_WIDTH   = 200; // base entity column width
const ENTITY_VISUAL_WIDTH = 100; // Studio Pro entity box width used by relative connector points
const CONNECTION_EDGE = 100; // Association connection points use a 0-100 relative scale
const RELATIONSHIP_STAGGER_X = 24;
function entityHeight(attrCount: number): number {
    return ENTITY_HDR_H + Math.max(1, attrCount) * ATTR_ROW_H;
}

function buildRestLocationTemplate(
    endpointTemplate: string,
    baseUrlRef: string,
    argExpressions: string[] = []
): { text: string; args: string[] } {
    return {
        text: `{1}${endpointTemplate}`,
        args: [baseUrlRef, ...argExpressions],
    };
}

async function findMicroflow(name: string): Promise<Microflows.Microflow | undefined> {
    return (await getStudioPro().app.model.microflows.loadAll(
        unit => unit.moduleName === IMPLEMENTATION_MODULE && unit.name === name,
        1
    ))[0];
}

async function ensureEntity(
    domainModel: DomainModels.DomainModel,
    preferredName: string,
    location?: { x: number; y: number },
    isPersistable = false
): Promise<{ entity: DomainModels.Entity; entityName: string; created: boolean }> {
    const entityName = toModelName(preferredName);
    const existing = domainModel.entities.find(e => e.name === entityName);
    if (existing) {
        return { entity: existing, entityName, created: false };
    }

    const sp = getStudioPro();
    const entity = await sp.app.model.domainModels.createElement<DomainModels.Entity>('DomainModels$Entity', {
        name: entityName,
        isPersistable,
    });
    // Position before push: once pushed into domainModel.entities, the returned
    // reference is detached and later mutations on it can be silently dropped.
    if (location) {
        entity.location = location;
    }
    domainModel.entities.push(entity);

    // Callers add attributes to this entity after it's returned (a child-collection
    // mutation on an already-pushed element) — re-read the live reference so those
    // pushes land on the tracked object instead of the now-detached local one.
    const liveEntity = domainModel.entities.find(e => e.name === entityName) ?? entity;

    return { entity: liveEntity, entityName, created: true };
}

async function ensureAssociation(
    domainModel: DomainModels.DomainModel,
    associationName: string,
    parentEntityId: string,
    childEntityId: string,
    isArrayAssociation: boolean
): Promise<boolean> {
    if (domainModel.associations.find(a => a.name === associationName)) {
        return false;
    }

    const sp = getStudioPro();
    const association = await sp.app.model.domainModels.createElement<DomainModels.Association>(
        'DomainModels$Association',
        {
            name: associationName,
            parentEntity: parentEntityId,
            childEntity: childEntityId,
            multiplicity: isArrayAssociation ? 'many_to_many' : 'one_to_many',
        }
    );
    const parentEntity = domainModel.entities.find(entity => entity.$ID === parentEntityId);
    const childEntity = domainModel.entities.find(entity => entity.$ID === childEntityId);
    if (parentEntity && childEntity) {
        const deltaX = childEntity.location.x - parentEntity.location.x;
        const deltaY = childEntity.location.y - parentEntity.location.y;
        if (Math.abs(deltaY) >= Math.abs(deltaX)) {
            const childIsBelow = deltaY >= 0;
            association.parentConnection = { x: ENTITY_VISUAL_WIDTH / 2, y: childIsBelow ? CONNECTION_EDGE : 0 };
            association.childConnection = { x: ENTITY_VISUAL_WIDTH / 2, y: childIsBelow ? 0 : CONNECTION_EDGE };
        } else {
            const childIsRight = deltaX >= 0;
            association.parentConnection = { x: childIsRight ? CONNECTION_EDGE : 0, y: CONNECTION_EDGE / 2 };
            association.childConnection = { x: childIsRight ? 0 : CONNECTION_EDGE, y: CONNECTION_EDGE / 2 };
        }
    }
    domainModel.associations.push(association);
    return true;
}

async function ensureAttribute(
    entity: DomainModels.Entity,
    attributeName: string,
    type: DomainModels.AttributeCreationOptions['type']
): Promise<{ attribute: DomainModels.Attribute; created: boolean }> {
    const existing = entity.attributes.find(a => a.name === attributeName);
    if (existing) {
        return { attribute: existing, created: false };
    }

    const sp = getStudioPro();
    const attribute = await sp.app.model.domainModels.createElement<DomainModels.Attribute>('DomainModels$Attribute', {
        name: attributeName,
        type,
    });
    entity.attributes.push(attribute);
    return { attribute, created: true };
}

async function fetchJsonSampleResponse(
    url: string,
    connection: ConnectionConfig,
    init?: RequestInit
): Promise<JsonSampleResponse> {
    const sp = getStudioPro();
    const proxyUrl = await sp.network.httpProxy.getProxyUrl(url);
    const response = await fetch(proxyUrl, {
        ...init,
        headers: {
            ...buildI3xRequestHeaders(connection.auth),
            ...(init?.headers ?? {}),
        },
    });

    if (!response.ok) {
        const responseText = (await response.text()).trim();
        const details = responseText ? ` Response: ${responseText}` : '';
        throw new Error(`i3X request failed with status ${response.status} for '${url}'.${details}`);
    }

    const rawText = await response.text();
    return {
        parsed: JSON.parse(rawText),
        rawText,
    };
}

async function getDomainModelOrThrow(): Promise<DomainModels.DomainModel> {
    const sp = getStudioPro();
    const domainModel = await sp.app.model.domainModels.getDomainModel(IMPLEMENTATION_MODULE);
    if (!domainModel) {
        throw new Error(`Module '${IMPLEMENTATION_MODULE}' was not found or has no domain model.`);
    }
    return domainModel;
}

// ── Endpoint folder / constant helpers ───────────────────────────────────────

// ── Domain model helpers ──────────────────────────────────────────────────────

interface DomainModelResult {
    baseEntityName: string;
    baseEntityCreated: boolean;
    groupEntitiesCreated: number;
    attributesCreated: number;
    associationsCreated: number;
}

interface EntityCounters {
    groupEntitiesCreated: number;
    attributesCreated: number;
    associationsCreated: number;
    nextNestedEntityY: number;
}

const OBJECT_LIST_ENTITY_NAME = 'i3X_Object';
const OBJECT_LIST_ATTRIBUTE_NAMES = ['elementId', 'displayName', 'typeElementId', 'parentId'] as const;

// ── Layout strategy ────────────────────────────────────────────────────────
// Top-level group entities (depth 1) are packed into one column right of the
// base entity; their Y position is computed on demand by getGroupY, which sums
// the heights of every earlier group in the list. Anything nested deeper
// (depth >= 2) has no natural column, so it is placed by a single running
// cursor, counters.nextNestedEntityY, that only advances when a new entity is
// actually created.
function computeEntityStartY(domainModel: DomainModels.DomainModel): number {
    let startY = 0;
    for (const ent of domainModel.entities) {
        const bottom = ent.location.y + entityHeight(ent.attributes.length) + V_GAP;
        if (bottom > startY) startY = bottom;
    }
    return startY;
}

function getGroupY(groupEntryList: [string, AnyProperty][], startY: number, groupIndex: number): number {
    let groupY = startY;
    for (let i = 0; i < groupIndex; i++) {
        const [, previousProperty] = groupEntryList[i];
        const previousAttrCount = countDirectLeafProperties(getChildPropertiesIfAny(previousProperty) ?? {});
        groupY += entityHeight(previousAttrCount) + V_GAP;
    }
    return groupY;
}

// Creates (or finds) a group entity for one object/array property, associates it to its
// parent, and recurses into its own properties. Shared by the top-level group loop in
// buildDomainModelEntities (depth 1, column-packed via getGroupY) and by the nested case
// below (depth >= 2, placed via the running nextNestedEntityY cursor) — the two differ only
// in how they compute `location`, which the caller works out before calling this.
async function ensureGroupEntityAndAssociation(
    domainModel: DomainModels.DomainModel,
    parentEntityName: string,
    parentEntity: DomainModels.Entity,
    propertyName: string,
    nestedProperties: Record<string, AnyProperty>,
    isResolvableArray: boolean,
    location: { x: number; y: number },
    depth: number,
    counters: EntityCounters
): Promise<boolean> {
    // Sanitize the property-name segment before concatenating, matching how
    // buildMappingEntries names the same entity on the import-mapping side —
    // sanitizing the whole compound string afterward isn't equivalent, since a
    // reserved word embedded mid-name (e.g. "type") only gets caught this way.
    const groupEntityInfo = await ensureEntity(domainModel, `${parentEntityName}_${toModelName(propertyName)}`, location);
    if (groupEntityInfo.created) {
        counters.groupEntitiesCreated += 1;
    }

    const assocName = `${parentEntityName}_${groupEntityInfo.entityName}`;
    if (await ensureAssociation(domainModel, assocName, parentEntity.$ID, groupEntityInfo.entity.$ID, isResolvableArray)) {
        counters.associationsCreated += 1;
    }

    await populateEntityProperties(domainModel, groupEntityInfo.entityName, groupEntityInfo.entity, nestedProperties, depth + 1, counters);
    return groupEntityInfo.created;
}

async function populateEntityProperties(
    domainModel: DomainModels.DomainModel,
    parentEntityName: string,
    parentEntity: DomainModels.Entity,
    properties: Record<string, AnyProperty>,
    depth: number,
    counters: EntityCounters
): Promise<void> {
    for (const [propertyName, property] of Object.entries(properties)) {
        const nestedProperties = getChildPropertiesIfAny(property);

        if (nestedProperties) {
            const isResolvableArray = isArrayProperty(property);
            const location = { x: depth * (BASE_WIDTH + H_GAP), y: counters.nextNestedEntityY };
            const created = await ensureGroupEntityAndAssociation(
                domainModel, parentEntityName, parentEntity, propertyName, nestedProperties, isResolvableArray, location, depth, counters
            );
            if (created) {
                counters.nextNestedEntityY += entityHeight(countDirectLeafProperties(nestedProperties)) + V_GAP;
            }
            continue;
        }

        if (isArrayProperty(property)) continue;

        const attributeName = toModelName(propertyName);
        const { created } = await ensureAttribute(parentEntity, attributeName, getAttributeType(property as LeafProperty));
        if (created) counters.attributesCreated += 1;
    }
}

async function buildDomainModelEntities(selectedObject: ObjectType): Promise<DomainModelResult> {
    const sp = getStudioPro();
    const baseEntityName = toModelName(selectedObject.displayName);
    if (!baseEntityName) {
        throw new Error('Selected object has no valid name.');
    }

    const domainModel = await getDomainModelOrThrow();

    const allProperties = selectedObject.schema.properties ?? {};
    const groupEntryList = Object.entries(allProperties).filter(([, p]) => getChildPropertiesIfAny(p) !== null);
    const leafCount = Object.entries(allProperties).filter(([, p]) => getChildPropertiesIfAny(p) === null).length;

    const startY = computeEntityStartY(domainModel);

    // Centre the base entity vertically against the group column.
    const groupColumnHeight = groupEntryList.reduce((sum, [, p]) => {
        return sum + entityHeight(countDirectLeafProperties(getChildPropertiesIfAny(p) ?? {})) + V_GAP;
    }, -V_GAP);
    const baseY = startY + Math.max(0, (groupColumnHeight - entityHeight(leafCount)) / 2);

    const baseEntityInfo = await ensureEntity(domainModel, baseEntityName, { x: 0, y: baseY });

    const counters: EntityCounters = {
        groupEntitiesCreated: 0,
        attributesCreated: 0,
        associationsCreated: 0,
        nextNestedEntityY: startY,
    };

    // ── Group properties → associated entities ────────────────────────────────
    for (const [groupIndex, [propertyName, property]] of groupEntryList.entries()) {
        const nestedProperties = getChildPropertiesIfAny(property)!;
        const isResolvableArray = isArrayProperty(property);
        const groupY = getGroupY(groupEntryList, startY, groupIndex);
        const created = await ensureGroupEntityAndAssociation(
            domainModel, baseEntityName, baseEntityInfo.entity, propertyName, nestedProperties, isResolvableArray,
            { x: BASE_WIDTH + H_GAP, y: groupY }, 1, counters
        );
        if (created) {
            counters.nextNestedEntityY = Math.max(counters.nextNestedEntityY, groupY + entityHeight(countDirectLeafProperties(nestedProperties)) + V_GAP);
        }
    }

    // ── Leaf properties → attributes on base entity ───────────────────────────
    for (const [propertyName, property] of Object.entries(allProperties)) {
        if (getChildPropertiesIfAny(property) !== null || isArrayProperty(property)) continue;

        const attributeName = toModelName(propertyName);
        const { created } = await ensureAttribute(baseEntityInfo.entity, attributeName, getAttributeType(property as LeafProperty));
        if (created) counters.attributesCreated += 1;
    }

    await sp.app.model.domainModels.save(domainModel);

    return {
        baseEntityName,
        baseEntityCreated: baseEntityInfo.created,
        groupEntitiesCreated: counters.groupEntitiesCreated,
        attributesCreated: counters.attributesCreated,
        associationsCreated: counters.associationsCreated,
    };
}

async function ensureObjectListEntity(): Promise<DomainModelResult> {
    const sp = getStudioPro();
    const domainModel = await getDomainModelOrThrow();

    const startY = computeEntityStartY(domainModel);
    const entityInfo = await ensureEntity(domainModel, OBJECT_LIST_ENTITY_NAME, { x: 0, y: startY });

    let attributesCreated = 0;
    for (const attributeName of OBJECT_LIST_ATTRIBUTE_NAMES) {
        const { created } = await ensureAttribute(entityInfo.entity, attributeName, 'String');
        if (created) attributesCreated += 1;
    }

    await sp.app.model.domainModels.save(domainModel);

    return {
        baseEntityName: entityInfo.entityName,
        baseEntityCreated: entityInfo.created,
        groupEntitiesCreated: 0,
        attributesCreated,
        associationsCreated: 0,
    };
}

async function ensureDateTimeAttribute(entityName: string, attributeName: string): Promise<void> {
    const sp = getStudioPro();
    const domainModel = await getDomainModelOrThrow();

    const entity = domainModel.entities.find(e => e.name === entityName);
    const attribute = entity?.attributes.find(a => a.name === attributeName);
    if (!attribute || attribute.type.$Type === 'DomainModels$DateTimeAttributeType') {
        return;
    }

    const dateTimeType = await sp.app.model.domainModels.createElement<DomainModels.DateTimeAttributeType>('DomainModels$DateTimeAttributeType');
    dateTimeType.localizeDate = false;
    attribute.type = dateTimeType;
    await sp.app.model.domainModels.save(domainModel);
}

function buildGenericObjectListSnippet(): string {
    return JSON.stringify({
        success: true,
        result: [
            {
                elementId: 'Example.Object',
                displayName: 'Example Object',
                typeElementId: 'ExampleObjectType',
                parentId: 'Example.Parent',
                isComposition: false,
                isExtended: false,
                namespaceUri: 'http://highbyte.com/default',
            },
        ],
    }, null, 2);
}

// Paths in the v1 /objects/value envelope that sit above the actual value payload.
// Array items use |(Object)| as a path segment, as confirmed by jsonStructures.getElements().
const VALUE_RESPONSE_PATH = `${OBJECT_PATH}|results|${OBJECT_PATH}|result|value`;
const VALUE_RESULT_PATH = `${OBJECT_PATH}|results|${OBJECT_PATH}|result`;
const WRITE_VALUE_OBJECT_PATH = `${OBJECT_PATH}|value`;

// Paths in the official /objects/history response.
const HISTORY_VALUE_PATH = `${OBJECT_PATH}|results|${OBJECT_PATH}|result|values|${OBJECT_PATH}`;

async function createValueQueryArtifacts(
    objectType: ObjectType,
    selectedObject: { elementId: string } | null,
    connection: ConnectionConfig,
    objectsValueUrl: string,
    endpointFolderId: string
): Promise<ValueQueryArtifactsResult & { syntheticData: boolean }> {
    const baseEntityName = toModelName(objectType.displayName);
    const liveSampleResponse = selectedObject !== null
        ? await fetchJsonSampleResponse(objectsValueUrl, connection, {
              method: 'POST',
              headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
              body: buildValueQueryHttpRequestBody(selectedObject.elementId.trim()),
          })
        : buildSyntheticValueResponse(objectType);

    // ObjectTypes used as containers can return value: null with GoodNoData. Mendix
    // cannot create an object mapping at the surrounding polymorphic result node.
    // Use the declared object shape for the JSON Structure so the regular value path
    // remains mappable; a runtime null then naturally produces no mapped object.
    const sampleResponse = selectedObject !== null
        ? replaceNullObjectValueWithDeclaredShape(liveSampleResponse, objectType)
        : liveSampleResponse;

    // Value-query entities come from the unwrapped latest-value payload, while
    // the JSON Structure is intentionally created from the raw response body.
    const valuePayload = extractValueQueryPayload(sampleResponse.parsed);
    const valueImportEntityPath = getValueQueryImportEntityPath(sampleResponse.parsed);
    const generatedObjectType = buildObjectTypeFromSample(baseEntityName, valuePayload, objectType.schema);
    const domainModelResult = await buildDomainModelEntities(generatedObjectType);

    const jsonStructureName = `JSON_${baseEntityName}`;
    const importMappingName = `IM_${baseEntityName}`;
    const jsonStructureResult = await createOrUpdateJsonStructure(jsonStructureName, sampleResponse.rawText, endpointFolderId);
    const importMappingResult = await createOrUpdateValueImportMapping(
        importMappingName,
        `${IMPLEMENTATION_MODULE}.${jsonStructureName}`,
        valuePayload,
        baseEntityName,
        valueImportEntityPath,
        endpointFolderId
    );

    return {
        ...domainModelResult,
        jsonStructureName,
        jsonStructureCreated: jsonStructureResult.created,
        importMappingName,
        importMappingCreated: importMappingResult.created,
        importMappingId: importMappingResult.mappingId,
        syntheticData: selectedObject === null,
    };
}

async function createOrUpdateObjectListImportMapping(
    mappingName: string,
    jsonStructureQualifiedName: string,
    jsonStructureId: string,
    parentId: string
): Promise<ImportMappingResult> {
    const sp = getStudioPro();
    const elementsResult = await sp.app.model.jsonStructures.getElements(jsonStructureId);
    if (!elementsResult.success) {
        throw new Error(`Could not inspect JSON Structure '${jsonStructureQualifiedName}' for object-list mapping.`);
    }

    const fieldPaths = OBJECT_LIST_ATTRIBUTE_NAMES.map(attributeName => {
        const path = Object.keys(elementsResult.elements).find(key => key.endsWith(`|${attributeName}`));
        if (!path) {
            throw new Error(`JSON Structure '${jsonStructureQualifiedName}' does not contain '${attributeName}' in the expected object-list format.`);
        }
        return path;
    });

    const itemPath = fieldPaths[0].split('|').slice(0, -1).join('|');
    const selectionPaths = [itemPath, ...fieldPaths];
    const valueMappings = Object.fromEntries(
        OBJECT_LIST_ATTRIBUTE_NAMES.map(attributeName => [attributeName, attributeName])
    );

    const existingMappings = await sp.app.model.importMappings.getUnitsInfo();
    const existingInfo = existingMappings.find(
        u => u.moduleName === IMPLEMENTATION_MODULE && u.name === mappingName
    );

    const mapping = existingInfo
        ? (await sp.app.model.importMappings.loadAll(u => u.$ID === existingInfo.$ID))[0] ?? null
        : await sp.app.model.importMappings.addImportMapping(parentId, {
            name: mappingName,
            selectStructure: {
                structureType: 'jsonStructure',
                structureQualifiedName: jsonStructureQualifiedName,
                selectElements: {
                    selectionType: 'paths',
                    selection: selectionPaths,
                },
            },
        });

    if (!mapping) {
        throw new Error(`Import mapping '${mappingName}' could not be loaded.`);
    }

    await sp.app.model.importMappings.clearElementMapping(mapping.$ID);
    await sp.app.model.importMappings.setElementMapping(mapping.$ID, [
        {
            path: itemPath,
            entityQualifiedName: `${IMPLEMENTATION_MODULE}.${OBJECT_LIST_ENTITY_NAME}`,
            valueMappings,
        },
    ]);

    const hydratedMapping = (await sp.app.model.importMappings.loadAll(u => u.$ID === mapping.$ID))[0] ?? mapping;
    fixMappingElements(hydratedMapping.rootMappingElements, null, 'Create');
    await sp.app.model.importMappings.save(hydratedMapping);

    return { created: !existingInfo, mappingId: mapping.$ID };
}


export async function createQueryValuesMicroflow(
    objectType: ObjectType,
    selectedObject: { elementId: string } | null,
    connection: ConnectionConfig
): Promise<QueryValuesMicroflowResult> {
    const sp = getStudioPro();
    const objectTypeName = toModelName(objectType.displayName);
    const { baseUrlConstantRef, authRefs, objectTypeFolderId, mappingsFolderId } =
        await ensureObjectTypeArtifactContext(connection, objectTypeName);
    const microflowName = `MF_${objectTypeName}`;

    const objectsValueUrl = getObjectsValueUrl(connection.apiBaseUrl);
    if (!objectsValueUrl) {
        throw new Error(`Cannot build /objects/value URL from '${connection.apiBaseUrl}'.`);
    }

    const artifactResult = await createValueQueryArtifacts(
        objectType,
        selectedObject,
        connection,
        objectsValueUrl,
        mappingsFolderId
    );

    const existingMicroflows = await sp.app.model.microflows.loadAll(
        unitInfo => unitInfo.moduleName === IMPLEMENTATION_MODULE && unitInfo.name === microflowName,
        1
    );
    if (existingMicroflows.length > 0) {
        return {
            ...artifactResult,
            microflowName,
            microflowCreated: false,
            jsonFetchFailed: artifactResult.syntheticData,
        };
    }

    const microflow = await sp.app.model.microflows.addMicroflow(objectTypeFolderId, { name: microflowName }, false);
    await addMicroflowParameters(microflow, [{ name: 'ElementId' }]);

    const requestBody = buildValueQueryMicroflowRequestBody();
    const locationTemplate = buildRestLocationTemplate('/objects/value', baseUrlConstantRef);
    await populateMicroflowWithRestCall(sp, microflow, {
        url: locationTemplate.text,
        urlArgs: locationTemplate.args,
        requestBody: requestBody.text,
        requestBodyArgs: requestBody.args,
        extraHeaders: JSON_EXTRA_HEADERS,
        authRefs,
        importMappingQualifiedName: `${IMPLEMENTATION_MODULE}.IM_${objectTypeName}`,
        importMappingOutput: {
            outputVariableName: 'MappedObject',
            entityQualifiedName: `${IMPLEMENTATION_MODULE}.${objectTypeName}`,
            isList: false,
        },
        returnMappedResult: true,
    });
    await sp.app.model.microflows.save(microflow);
    return {
        ...artifactResult,
        microflowName,
        microflowCreated: true,
        jsonFetchFailed: artifactResult.syntheticData,
    };
}

export interface HistoryMicroflowResult {
    microflowName: string;
    microflowCreated: boolean;
    jsonStructureName: string;
    jsonStructureCreated: boolean;
    importMappingName: string;
    importMappingCreated: boolean;
}

export async function createHistoryMicroflow(
    objectType: ObjectType,
    connection: ConnectionConfig
): Promise<HistoryMicroflowResult> {
    const sp = getStudioPro();
    const baseEntityName = toModelName(objectType.displayName);
    const { baseUrlConstantRef, authRefs, objectTypeFolderId, mappingsFolderId } =
        await ensureObjectTypeArtifactContext(connection, baseEntityName);
    const historyEntityName = `${baseEntityName}_History`;
    const microflowName = `MF_${baseEntityName}_History`;
    const jsonStructureName = `JSON_${baseEntityName}_History`;
    const importMappingName = `IM_${baseEntityName}_History`;

    // Require value-query artifacts to exist first so we can reuse the sampled
    // latest-value payload when building the history entry shape.
    const domainModel = await sp.app.model.domainModels.getDomainModel(IMPLEMENTATION_MODULE);
    if (!domainModel || !domainModel.entities.find(e => e.name === baseEntityName)) {
        throw new Error(
            `Entity '${baseEntityName}' not found in module '${IMPLEMENTATION_MODULE}'. ` +
            `Run "Create last-known-value query microflow" first.`
        );
    }

    // Build a representative history response from the existing JSON_<Name>
    // structure so the generated JSON Structure matches the official server.
    const rawStructures = await sp.app.model.jsonStructures.getUnitsInfo();
    const valueStructureInfo = rawStructures.find(
        u => u.moduleName === IMPLEMENTATION_MODULE && u.name === `JSON_${baseEntityName}`
    );
    let historyValuePayload: unknown = extractFirstResultValue(buildSyntheticValueResponse(objectType).parsed);
    if (valueStructureInfo) {
        const loaded = await sp.app.model.jsonStructures.loadAll(u => u.$ID === valueStructureInfo.$ID);
        if (loaded.length > 0 && loaded[0].jsonSnippet) {
            try {
                historyValuePayload = extractFirstResultValue(JSON.parse(loaded[0].jsonSnippet));
            } catch { /* keep synthetic fallback */ }
        }
    }

    await buildHistoryEntities(historyEntityName, baseEntityName);
    await ensureDateTimeAttribute(historyEntityName, 'timestamp');

    const historySnippet = buildSchemaAwareHistorySnippet(objectType, historyValuePayload);
    const jsonStructureResult = await createOrUpdateJsonStructure(jsonStructureName, historySnippet, mappingsFolderId);
    const { selectionPaths: historySelPaths, mapObjects: historyMapObjects } = buildHistoryImportMappingEntries(
        HISTORY_VALUE_PATH, historyEntityName, baseEntityName, historyValuePayload
    );
    const importMappingResult = await createOrUpdateImportMapping(
        importMappingName,
        `${IMPLEMENTATION_MODULE}.${jsonStructureName}`,
        historySelPaths,
        historyMapObjects,
        mappingsFolderId
    );

    const existing = await sp.app.model.microflows.loadAll(
        u => u.moduleName === IMPLEMENTATION_MODULE && u.name === microflowName,
        1
    );
    if (existing.length > 0) {
        return {
            microflowName, microflowCreated: false,
            jsonStructureName, jsonStructureCreated: jsonStructureResult.created,
            importMappingName, importMappingCreated: importMappingResult.created,
        };
    }

    const microflow = await sp.app.model.microflows.addMicroflow(objectTypeFolderId, { name: microflowName }, false);

    await addMicroflowParameters(microflow, [
        { name: 'ElementId' },
        { name: 'StartTime', type: 'DateTime' },
        { name: 'EndTime', type: 'DateTime' },
    ]);

    const { text: bodyText, args: bodyArgs } = buildHistoryMicroflowRequestBody();
    const locationTemplate = buildRestLocationTemplate('/objects/history', baseUrlConstantRef);
    await populateMicroflowWithRestCall(sp, microflow, {
        url: locationTemplate.text,
        urlArgs: locationTemplate.args,
        requestBody: bodyText,
        requestBodyArgs: bodyArgs,
        extraHeaders: JSON_EXTRA_HEADERS,
        authRefs,
        importMappingQualifiedName: `${IMPLEMENTATION_MODULE}.${importMappingName}`,
        importMappingOutput: {
            outputVariableName: 'HistoryList',
            entityQualifiedName: `${IMPLEMENTATION_MODULE}.${historyEntityName}`,
            isList: true,
        },
        returnMappedResult: true,
    });
    await sp.app.model.microflows.save(microflow);
    return {
        microflowName, microflowCreated: true,
        jsonStructureName, jsonStructureCreated: jsonStructureResult.created,
        importMappingName, importMappingCreated: importMappingResult.created,
    };
}

function extractFirstResultValue(raw: unknown): unknown {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const results = (raw as Record<string, unknown>).results;
    if (!Array.isArray(results) || results.length === 0) return null;

    const firstEntry = results[0];
    if (firstEntry === null || typeof firstEntry !== 'object' || Array.isArray(firstEntry)) return null;
    const result = (firstEntry as Record<string, unknown>).result;
    if (result === null || typeof result !== 'object' || Array.isArray(result)) return null;

    return (result as Record<string, unknown>).value ?? null;
}

function buildWriteRequestPayload(valuePayload: unknown): {
    requestBody: Record<string, unknown>;
    mappingPayload: unknown;
    entityPath: string;
} {
    if (valuePayload !== null && typeof valuePayload === 'object' && !Array.isArray(valuePayload)) {
        return {
            requestBody: { value: valuePayload as Record<string, unknown> },
            mappingPayload: valuePayload,
            entityPath: WRITE_VALUE_OBJECT_PATH,
        };
    }

    return {
        requestBody: { value: valuePayload },
        mappingPayload: { value: valuePayload },
        entityPath: OBJECT_PATH,
    };
}

function buildHistoryEntrySample(valuePayload: unknown): Record<string, unknown> {
    return {
        value: valuePayload,
        quality: 'Good',
        timestamp: '2026-01-01T00:00:00.000Z',
    };
}

function buildHistoryResponseSample(objectType: ObjectType, valuePayload: unknown): Record<string, unknown> {
    return {
        success: true,
        results: [{
            elementId: objectType.elementId || 'synthetic',
            success: true,
            result: {
                isComposition: false,
                values: [buildHistoryEntrySample(valuePayload)],
            },
        }],
    };
}

// Like stringifyJsonWithDecimalIntegers but skips the decimal conversion for fields whose
// schema declares type='integer'. Prevents Mendix from inferring Decimal for Integer fields
// in the JSON Write structure, which would cause an Integer↔Decimal type mismatch in the
// generated export mapping.
function tagResponseValueFromSchema(
    value: unknown,
    properties: Record<string, AnyProperty> | null,
    defs: Record<string, unknown>
): unknown {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return value;
    return Object.fromEntries(
        Object.entries(value as Record<string, unknown>).map(([key, childValue]) => {
            const property = properties?.[key] as AnyProperty | undefined;
            let childProperties: Record<string, AnyProperty> | null = null;
            if (property && isGroupProperty(property)) {
                childProperties = property.properties as Record<string, AnyProperty>;
            } else if (property && '$ref' in property && typeof (property as LeafProperty).$ref === 'string') {
                const refKey = ((property as LeafProperty).$ref as string).replace('#/$defs/', '');
                const resolved = defs[refKey];
                if (resolved && typeof resolved === 'object' && 'properties' in resolved) {
                    childProperties = (resolved as ObjectTypeSchema).properties as Record<string, AnyProperty>;
                }
            }
            if (childValue !== null && typeof childValue === 'object' && !Array.isArray(childValue)) {
                return [key, tagResponseValueFromSchema(childValue, childProperties, defs)];
            }
            if (typeof childValue === 'number' && Number.isFinite(childValue) && Number.isInteger(childValue)) {
                const leafType = (property as LeafProperty | undefined)?.type;
                if (leafType !== 'integer') return [key, `${DECIMAL_WRITE_MARKER}${childValue.toFixed(1)}`];
            }
            return [key, childValue];
        })
    );
}

function replaceNullObjectValueWithDeclaredShape(
    sample: JsonSampleResponse,
    objectType: ObjectType
): JsonSampleResponse {
    if (objectType.schema.type !== 'object' || sample.parsed === null || typeof sample.parsed !== 'object') {
        return sample;
    }
    const results = (sample.parsed as { results?: unknown }).results;
    if (!Array.isArray(results)) return sample;

    let replaced = false;
    const normalizedResults = results.map(item => {
        if (item === null || typeof item !== 'object' || Array.isArray(item)) return item;
        const result = (item as { result?: unknown }).result;
        if (result === null || typeof result !== 'object' || Array.isArray(result)) return item;
        if ((result as { value?: unknown }).value !== null) return item;
        replaced = true;
        return { ...item, result: { ...result, value: {} } };
    });
    if (!replaced) return sample;

    const parsed = { ...(sample.parsed as Record<string, unknown>), results: normalizedResults };
    return { parsed, rawText: JSON.stringify(parsed) };
}

function stringifySchemaAwareResponse(value: unknown): string {
    return JSON.stringify(value, null, 2).replace(
        new RegExp(`"${DECIMAL_WRITE_MARKER}(-?(?:0|[1-9]\\d*)\\.0)"`, 'g'),
        '$1'
    );
}

function buildSchemaAwareHistorySnippet(objectType: ObjectType, valuePayload: unknown): string {
    const defs = (objectType.schema.$defs ?? {}) as Record<string, unknown>;
    const taggedValue = tagResponseValueFromSchema(valuePayload, objectType.schema.properties ?? {}, defs);
    return stringifySchemaAwareResponse(buildHistoryResponseSample(objectType, taggedValue));
}

function buildSchemaAwareSubscriptionSnippet(valuePayload: unknown, schema: ObjectTypeSchema): string {
    const defs = (schema.$defs ?? {}) as Record<string, unknown>;
    const taggedValue = tagResponseValueFromSchema(valuePayload, schema.properties ?? {}, defs);
    return stringifySchemaAwareResponse({
        success: true,
        result: [{
            sequenceNumber: 1,
            updates: [{ elementId: 'example-element', value: taggedValue, quality: 'Good', timestamp: '2026-01-01T00:00:00Z' }],
        }],
    });
}

function buildSchemaAwareWriteSnippet(
    requestBody: Record<string, unknown>,
    valueSchema: ObjectTypeSchema
): string {
    const defs = (valueSchema.$defs ?? {}) as Record<string, unknown>;

    function tagValues(value: unknown, props: Record<string, AnyProperty> | null): unknown {
        if (value === null || typeof value !== 'object' || Array.isArray(value)) {
            return value;
        }
        const obj = value as Record<string, unknown>;
        return Object.fromEntries(
            Object.entries(obj).map(([key, childValue]) => {
                const propSchema = props?.[key] as AnyProperty | undefined;

                let childProps: Record<string, AnyProperty> | null = null;
                if (propSchema) {
                    if (isGroupProperty(propSchema)) {
                        childProps = propSchema.properties as Record<string, AnyProperty>;
                    } else if ('$ref' in propSchema && typeof (propSchema as LeafProperty).$ref === 'string') {
                        const refKey = ((propSchema as LeafProperty).$ref as string).replace('#/$defs/', '');
                        const resolved = defs[refKey];
                        if (resolved && typeof resolved === 'object' && 'properties' in (resolved as object)) {
                            childProps = (resolved as ObjectTypeSchema).properties as Record<string, AnyProperty>;
                        }
                    }
                }

                if (childValue !== null && typeof childValue === 'object' && !Array.isArray(childValue)) {
                    return [key, tagValues(childValue, childProps)];
                }

                if (typeof childValue === 'number' && Number.isFinite(childValue) && Number.isInteger(childValue)) {
                    const leafType = (propSchema as LeafProperty | undefined)?.type;
                    if (leafType !== 'integer') {
                        return [key, `${DECIMAL_WRITE_MARKER}${childValue.toFixed(1)}`];
                    }
                }

                return [key, childValue];
            })
        );
    }

    const tagged = tagValues(requestBody, {
        value: { type: 'object', properties: valueSchema.properties ?? {} } as AnyProperty,
    });

    const json = JSON.stringify(tagged, null, 2);
    return json.replace(
        new RegExp(`"${DECIMAL_WRITE_MARKER}(-?(?:0|[1-9]\\d*)\\.0)"`, 'g'),
        '$1'
    );
}

function stringifyJsonWithDecimalIntegers(value: unknown): string {
    const json = JSON.stringify(
        value,
        (_key, currentValue) => {
            if (typeof currentValue === 'number' && Number.isFinite(currentValue) && Number.isInteger(currentValue)) {
                return `${DECIMAL_INTEGER_MARKER}${currentValue.toFixed(1)}`;
            }

            return currentValue;
        },
        2
    );

    return json.replace(
        new RegExp(`"${DECIMAL_INTEGER_MARKER}(-?(?:0|[1-9]\\d*)\\.0)"`, 'g'),
        '$1'
    );
}

function fixMappingElements(
    elements: Mappings.ObjectMappingElement[],
    parentEntityQualifiedName: string | null,
    objectHandling: 'Create' | 'Parameter' | 'Find'
): void {
    for (const el of elements) {
        el.objectHandling = objectHandling;

        if (parentEntityQualifiedName && el.entity) {
            const parentEntityName = parentEntityQualifiedName.split('.').pop() ?? '';
            const childEntityName = el.entity.split('.').pop() ?? '';
            el.association = `${IMPLEMENTATION_MODULE}.${parentEntityName}_${childEntityName}`;
        } else {
            el.association = null;
        }

        const childHandling = objectHandling === 'Parameter' && el.entity ? 'Find' : objectHandling;
        fixMappingElements(
            el.children.filter((c): c is Mappings.ObjectMappingElement => 'children' in c),
            el.entity,
            childHandling
        );
    }
}

// Build the selection paths and MapObject list for a mapping from a parsed JSON value object.
// Pass includeArrayWrapperPaths=true for export mappings (which need the array wrapper element
// selected), false for import mappings (the |(Object)| item path is sufficient).
function buildMappingEntries(
    value: unknown,
    path: string,
    entityName: string,
    includeArrayWrapperPaths: boolean
): { selectionPaths: string[]; mapObjects: { path: string; entityQualifiedName: string; valueMappings: Record<string, string> }[] } {
    const selectionPaths: string[] = [path];
    const mapObjects: { path: string; entityQualifiedName: string; valueMappings: Record<string, string> }[] = [];

    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        return { selectionPaths, mapObjects };
    }

    const obj = value as Record<string, unknown>;
    const valueMappings: Record<string, string> = {};

    for (const [key, childValue] of Object.entries(obj)) {
        if (Array.isArray(childValue)) {
            const mergedItem = mergeArrayObjectItems(childValue);
            if (mergedItem !== null) {
                if (includeArrayWrapperPaths) {
                    selectionPaths.push(`${path}|${key}`);
                }
                const child = buildMappingEntries(mergedItem, `${path}|${key}|${OBJECT_PATH}`, `${entityName}_${toModelName(key)}`, includeArrayWrapperPaths);
                selectionPaths.push(...child.selectionPaths);
                mapObjects.push(...child.mapObjects);
            }
            continue;
        }

        selectionPaths.push(`${path}|${key}`);
        if (childValue !== null && typeof childValue === 'object') {
            const child = buildMappingEntries(
                childValue,
                `${path}|${key}`,
                `${entityName}_${toModelName(key)}`,
                includeArrayWrapperPaths
            );
            selectionPaths.push(...child.selectionPaths.slice(1));
            mapObjects.push(...child.mapObjects);
        } else {
            valueMappings[key] = toModelName(key);
        }
    }

    mapObjects.unshift({ path, entityQualifiedName: `${IMPLEMENTATION_MODULE}.${entityName}`, valueMappings });
    return { selectionPaths, mapObjects };
}

async function createOrUpdateExportMapping(
    mappingName: string,
    jsonStructureQualifiedName: string,
    parsedWriteValue: unknown,
    baseEntityName: string,
    entityVariableName: string,
    entityPath: string,
    parentId: string
): Promise<{ created: boolean; mappingId: string }> {
    const sp = getStudioPro();
    const existingMappings = await sp.app.model.exportMappings.getUnitsInfo();
    const existingInfo = existingMappings.find(
        u => u.moduleName === IMPLEMENTATION_MODULE && u.name === mappingName
    );

    const { selectionPaths, mapObjects } = buildMappingEntries(parsedWriteValue, entityPath, baseEntityName, true);

    // Export mappings require the document root '(Object)' to be selected for any child
    // elements to be usable. Import mappings navigate inward from a deep path and don't
    // need it, but for export the root anchors the serialization traversal.
    const exportSelectionPaths = ['(Object)', ...selectionPaths];

    const mapping = existingInfo
        ? (await sp.app.model.exportMappings.loadAll(u => u.$ID === existingInfo.$ID))[0] ?? null
        : await sp.app.model.exportMappings.addExportMapping(parentId, {
            name: mappingName,
            selectStructure: {
                structureType: 'jsonStructure',
                structureQualifiedName: jsonStructureQualifiedName,
                selectElements: {
                    selectionType: 'paths',
                    selection: exportSelectionPaths,
                },
            },
        });

    if (!mapping) {
        throw new Error(`Export mapping '${mappingName}' could not be loaded.`);
    }

    mapping.parameterName = entityVariableName;
    await sp.app.model.exportMappings.clearElementMapping(mapping.$ID);
    await sp.app.model.exportMappings.setElementMapping(mapping.$ID, mapObjects);

    const hydratedMapping = (await sp.app.model.exportMappings.loadAll(u => u.$ID === mapping.$ID))[0] ?? mapping;
    hydratedMapping.parameterName = entityVariableName;
    fixMappingElements(hydratedMapping.rootMappingElements, null, 'Parameter');
    await sp.app.model.exportMappings.save(hydratedMapping);

    return { created: !existingInfo, mappingId: mapping.$ID };
}

function getValueQueryImportEntityPath(raw: unknown): string {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
        return VALUE_RESPONSE_PATH;
    }

    const results = (raw as Record<string, unknown>).results;
    if (!Array.isArray(results)) {
        return VALUE_RESPONSE_PATH;
    }

    for (const item of results) {
        if (item === null || typeof item !== 'object' || Array.isArray(item)) {
            continue;
        }

        const result = (item as Record<string, unknown>).result;
        if (result === null || typeof result !== 'object' || Array.isArray(result)) {
            continue;
        }

        const value = (result as Record<string, unknown>).value;
        return value !== null && typeof value === 'object' && !Array.isArray(value)
            ? VALUE_RESPONSE_PATH
            : VALUE_RESULT_PATH;
    }

    return VALUE_RESPONSE_PATH;
}

function mergeArrayObjectItems(arr: unknown[]): Record<string, unknown> | null {
    const merged: Record<string, unknown> = {};
    let found = false;
    for (const item of arr) {
        if (item !== null && typeof item === 'object' && !Array.isArray(item)) {
            found = true;
            for (const [k, v] of Object.entries(item as Record<string, unknown>)) {
                if (!(k in merged) || merged[k] == null) merged[k] = v;
            }
        }
    }
    return found ? merged : null;
}

async function createOrUpdateImportMapping(
    mappingName: string,
    jsonStructureQualifiedName: string,
    allSelectionPaths: string[],
    mapObjects: { path: string; entityQualifiedName: string; valueMappings: Record<string, string> }[],
    parentId: string
): Promise<ImportMappingResult> {
    const sp = getStudioPro();
    const existingMappings = await sp.app.model.importMappings.getUnitsInfo();
    const existingInfo = existingMappings.find(
        u => u.moduleName === IMPLEMENTATION_MODULE && u.name === mappingName
    );

    const mapping = existingInfo
        ? (await sp.app.model.importMappings.loadAll(u => u.$ID === existingInfo.$ID))[0] ?? null
        : await sp.app.model.importMappings.addImportMapping(parentId, {
            name: mappingName,
            selectStructure: {
                structureType: 'jsonStructure',
                structureQualifiedName: jsonStructureQualifiedName,
                selectElements: {
                    selectionType: 'paths',
                    selection: allSelectionPaths,
                },
            },
        });

    if (!mapping) {
        throw new Error(`Import mapping '${mappingName}' could not be loaded.`);
    }

    await sp.app.model.importMappings.clearElementMapping(mapping.$ID);
    await sp.app.model.importMappings.setElementMapping(mapping.$ID, mapObjects);

    const hydratedMapping = (await sp.app.model.importMappings.loadAll(u => u.$ID === mapping.$ID))[0] ?? mapping;
    fixMappingElements(hydratedMapping.rootMappingElements, null, 'Create');
    await sp.app.model.importMappings.save(hydratedMapping);

    return { created: !existingInfo, mappingId: mapping.$ID };
}

async function createOrUpdateValueImportMapping(
    mappingName: string,
    jsonStructureQualifiedName: string,
    parsedValuePayload: unknown,
    baseEntityName: string,
    entityPath: string,
    parentId: string
): Promise<ImportMappingResult> {
    const { selectionPaths, mapObjects } = buildMappingEntries(parsedValuePayload, entityPath, baseEntityName, false);
    return createOrUpdateImportMapping(mappingName, jsonStructureQualifiedName, selectionPaths, mapObjects, parentId);
}

// Builds import mapping entries for a history response entry, reusing the existing value
// entity structure instead of duplicating it under a _History_value sub-entity tree.
function buildHistoryImportMappingEntries(
    historyPath: string,
    historyEntityName: string,
    baseEntityName: string,
    valuePayload: unknown
): { selectionPaths: string[]; mapObjects: { path: string; entityQualifiedName: string; valueMappings: Record<string, string> }[] } {
    const valuePath = `${historyPath}|value`;
    const valueEntries = buildMappingEntries(valuePayload, valuePath, baseEntityName, false);

    return {
        selectionPaths: [
            historyPath,
            `${historyPath}|quality`,
            `${historyPath}|timestamp`,
            ...valueEntries.selectionPaths,
        ],
        mapObjects: [
            {
                path: historyPath,
                entityQualifiedName: `${IMPLEMENTATION_MODULE}.${historyEntityName}`,
                valueMappings: { quality: 'quality', timestamp: 'timestamp' },
            },
            ...valueEntries.mapObjects,
        ],
    };
}

// Creates the history entity with quality/timestamp attributes and a direct association
// to the existing base value entity, without duplicating the value entity sub-tree.
async function buildHistoryEntities(
    historyEntityName: string,
    baseEntityName: string
): Promise<DomainModelResult> {
    const sp = getStudioPro();
    const domainModel = await getDomainModelOrThrow();

    const startY = computeEntityStartY(domainModel);
    const historyEntityInfo = await ensureEntity(domainModel, historyEntityName, { x: 0, y: startY });

    let attributesCreated = 0;
    if ((await ensureAttribute(historyEntityInfo.entity, 'quality', 'String')).created) {
        attributesCreated++;
    }
    if ((await ensureAttribute(historyEntityInfo.entity, 'timestamp', 'DateTime')).created) {
        attributesCreated++;
    }

    const baseEntity = domainModel.entities.find(e => e.name === baseEntityName);
    let associationsCreated = 0;
    if (baseEntity) {
        const assocName = `${historyEntityInfo.entityName}_${baseEntityName}`;
        if (await ensureAssociation(domainModel, assocName, historyEntityInfo.entity.$ID, baseEntity.$ID, false)) {
            associationsCreated++;
        }
    }

    await sp.app.model.domainModels.save(domainModel);

    return {
        baseEntityName: historyEntityInfo.entityName,
        baseEntityCreated: historyEntityInfo.created,
        groupEntitiesCreated: 0,
        attributesCreated,
        associationsCreated,
    };
}

export async function checkValueQueryEntitiesExist(
    objectType: ObjectType
): Promise<boolean> {
    const sp = getStudioPro();
    const domainModel = await sp.app.model.domainModels.getDomainModel(IMPLEMENTATION_MODULE);
    if (!domainModel) return false;
    const entityName = toModelName(objectType.displayName);
    return domainModel.entities.find(e => e.name === entityName) !== undefined;
}

async function configureImportMappingParameter(
    mappingId: string,
    parameterEntityQualifiedName: string,
    associationQualifiedName: string
): Promise<void> {
    const sp = getStudioPro();
    const mapping = (await sp.app.model.importMappings.loadAll(unit => unit.$ID === mappingId))[0];
    if (!mapping) throw new Error(`Import mapping '${mappingId}' could not be loaded.`);

    const parameterType = await sp.app.model.importMappings.createElement<DataTypes.ObjectType>(
        'DataTypes$ObjectType',
        { entity: parameterEntityQualifiedName }
    );
    mapping.parameterType = parameterType;
    for (const rootElement of mapping.rootMappingElements) {
        rootElement.association = associationQualifiedName;
        rootElement.objectHandling = 'Create';
    }
    await sp.app.model.importMappings.save(mapping);
}

export interface RelationshipArtifactsResult {
    microflowName: string;
    microflowCreated: boolean;
    jsonStructureName: string;
    jsonStructureCreated: boolean;
    importMappingName: string;
    importMappingCreated: boolean;
    associationName: string;
    associationCreated: boolean;
}

export interface RelatedObjectSample {
    elementId: string;
    displayName: string;
    typeElementId: string;
}

function getRelationshipArtifactNames(sourceType: ObjectType, targetType: ObjectType, relationship: string) {
    const sourceName = toModelName(sourceType.displayName);
    const targetName = toModelName(targetType.displayName);
    const relationshipName = toModelName(relationship);
    const artifactStem = `${sourceName}_Related_${relationshipName}_${targetName}`;
    return {
        sourceName,
        targetName,
        microflowName: `MF_${artifactStem}`,
        jsonStructureName: `JSON_${artifactStem}`,
        importMappingName: `IM_${artifactStem}`,
        associationName: toModelName(`${sourceName}_${relationshipName}_${targetName}`),
    };
}

export async function checkRelationshipArtifactsExist(
    sourceType: ObjectType,
    targetType: ObjectType,
    relationship: string
): Promise<boolean> {
    const { microflowName } = getRelationshipArtifactNames(sourceType, targetType, relationship);
    return Boolean(await findMicroflow(microflowName));
}

export async function createRelationshipArtifacts(
    sourceType: ObjectType,
    targetType: ObjectType,
    relationship: string,
    sourceElementId: string,
    targetSample: RelatedObjectSample,
    connection: ConnectionConfig
): Promise<RelationshipArtifactsResult> {
    const sp = getStudioPro();
    const names = getRelationshipArtifactNames(sourceType, targetType, relationship);

    if (!(await checkValueQueryEntitiesExist(sourceType))) {
        await createQueryValuesMicroflow(sourceType, { elementId: sourceElementId }, connection);
    }
    const targetEntityAlreadyExisted = await checkValueQueryEntitiesExist(targetType);
    if (!targetEntityAlreadyExisted) {
        await createQueryValuesMicroflow(targetType, { elementId: targetSample.elementId }, connection);
    }

    const { baseUrlConstantRef, authRefs, objectTypeFolderId, mappingsFolderId } =
        await ensureObjectTypeArtifactContext(connection, names.sourceName);
    const domainModel = await sp.app.model.domainModels.getDomainModel(IMPLEMENTATION_MODULE);
    if (!domainModel) throw new Error(`Module '${IMPLEMENTATION_MODULE}' has no domain model.`);

    const sourceEntity = domainModel.entities.find(entity => entity.name === names.sourceName);
    const targetEntity = domainModel.entities.find(entity => entity.name === names.targetName);
    if (!sourceEntity || !targetEntity) {
        throw new Error(`Could not prepare '${names.sourceName}' and '${names.targetName}' entities.`);
    }

    if (!targetEntityAlreadyExisted && sourceEntity.$ID !== targetEntity.$ID) {
        const relationshipIndex = domainModel.associations.filter(
            association => association.parent === sourceEntity.$ID
        ).length + 1;
        targetEntity.location = {
            x: sourceEntity.location.x + relationshipIndex * RELATIONSHIP_STAGGER_X,
            y: targetEntity.location.y,
        };
    }

    await ensureAttribute(sourceEntity, 'elementId', 'String');
    await ensureAttribute(targetEntity, 'elementId', 'String');
    await ensureAttribute(targetEntity, 'displayName', 'String');
    await ensureAttribute(targetEntity, 'typeElementId', 'String');
    const associationCreated = await ensureAssociation(
        domainModel,
        names.associationName,
        sourceEntity.$ID,
        targetEntity.$ID,
        true
    );
    await sp.app.model.domainModels.save(domainModel);

    const objectPath = `${OBJECT_PATH}|results|${OBJECT_PATH}|result|${OBJECT_PATH}|object`;
    const responseSample = {
        success: true,
        results: [{
            success: true,
            elementId: sourceElementId,
            result: [{ sourceRelationship: relationship, object: targetSample }],
        }],
    };
    const jsonStructureResult = await createOrUpdateJsonStructure(
        names.jsonStructureName,
        JSON.stringify(responseSample, null, 2),
        mappingsFolderId
    );
    const importMappingResult = await createOrUpdateImportMapping(
        names.importMappingName,
        `${IMPLEMENTATION_MODULE}.${names.jsonStructureName}`,
        [
            objectPath,
            `${objectPath}|elementId`,
            `${objectPath}|displayName`,
            `${objectPath}|typeElementId`,
        ],
        [{
            path: objectPath,
            entityQualifiedName: `${IMPLEMENTATION_MODULE}.${names.targetName}`,
            valueMappings: { elementId: 'elementId', displayName: 'displayName', typeElementId: 'typeElementId' },
        }],
        mappingsFolderId
    );
    await configureImportMappingParameter(
        importMappingResult.mappingId,
        `${IMPLEMENTATION_MODULE}.${names.sourceName}`,
        `${IMPLEMENTATION_MODULE}.${names.associationName}`
    );

    const existingMicroflow = await findMicroflow(names.microflowName);
    if (existingMicroflow) await sp.app.model.microflows.deleteUnit(existingMicroflow.$ID);
    const microflow = await sp.app.model.microflows.addMicroflow(
        objectTypeFolderId,
        { name: names.microflowName },
        false
    );
    await addMicroflowParameters(microflow, [{
        name: names.sourceName,
        entityQualifiedName: `${IMPLEMENTATION_MODULE}.${names.sourceName}`,
    }]);
    const escapedRelationship = relationship.replace(/'/g, "''");
    await populateMicroflowWithRestCall(sp, microflow, {
            url: buildRestLocationTemplate('/objects/related', baseUrlConstantRef).text,
            urlArgs: [baseUrlConstantRef],
            requestBody: '{{"elementIds":["{1}"],"relationshipType":"{2}","includeMetadata":false}',
            requestBodyArgs: [`$${names.sourceName}/elementId`, `'${escapedRelationship}'`],
            extraHeaders: JSON_EXTRA_HEADERS,
            authRefs,
            importMappingQualifiedName: `${IMPLEMENTATION_MODULE}.${names.importMappingName}`,
            importMappingOutput: {
                outputVariableName: 'RelatedObjects',
                entityQualifiedName: `${IMPLEMENTATION_MODULE}.${names.targetName}`,
                isList: true,
                mappingArgumentVariableName: names.sourceName,
            },
            returnMappedResult: true,
            annotationText: `The ${names.sourceName}/elementId must contain the i3X element ID. Imported ${names.targetName} objects are associated through ${names.associationName}.`,
    });
    await sp.app.model.microflows.save(microflow);

    return {
        microflowName: names.microflowName,
        microflowCreated: !existingMicroflow,
        jsonStructureName: names.jsonStructureName,
        jsonStructureCreated: jsonStructureResult.created,
        importMappingName: names.importMappingName,
        importMappingCreated: importMappingResult.created,
        associationName: names.associationName,
        associationCreated,
    };
}

export interface WriteMicroflowResult {
    microflowName: string;
    microflowId: string;
    exportMappingName: string;
    microflowCreated: boolean;
    exportMappingCreated: boolean;
}

interface ImportMappingResult {
    created: boolean;
    mappingId: string;
}

export interface SubscriptionArtifactsResult {
    subscriptionEntityName: string;
    batchEntityName: string;
    updateEntityName: string;
    jsonStructuresCreated: number;
    importMappingsCreated: number;
    microflowNames: string[];
    microflowsCreated: number;
}

async function ensureSubscriptionEntities(baseEntityName: string): Promise<SubscriptionArtifactNames> {
    const sp = getStudioPro();
    const domainModel = await getDomainModelOrThrow();
    const startY = computeEntityStartY(domainModel);
    const subscription = await ensureEntity(
        domainModel,
        `${baseEntityName}_Subscription`,
        { x: 0, y: startY },
        true
    );
    const columnWidth = BASE_WIDTH + H_GAP;
    const batch = await ensureEntity(domainModel, `${baseEntityName}_SubscriptionBatch`, { x: columnWidth, y: startY });
    const update = await ensureEntity(domainModel, `${baseEntityName}_SubscriptionUpdate`, { x: columnWidth * 2, y: startY });

    for (const name of ['clientId', 'subscriptionId', 'displayName', 'elementId', 'lastSequenceNumber']) {
        await ensureAttribute(subscription.entity, name, 'String');
    }
    await ensureAttribute(batch.entity, 'sequenceNumber', 'Decimal');
    await ensureAttribute(update.entity, 'elementId', 'String');
    await ensureAttribute(update.entity, 'quality', 'String');
    await ensureAttribute(update.entity, 'timestamp', 'DateTime');

    await ensureAssociation(
        domainModel,
        `${batch.entityName}_${update.entityName}`,
        batch.entity.$ID,
        update.entity.$ID,
        true
    );
    const valueEntity = domainModel.entities.find(entity => entity.name === baseEntityName);
    if (!valueEntity) {
        throw new Error(`Entity '${baseEntityName}' not found. Create Latest Values first.`);
    }
    await ensureAssociation(
        domainModel,
        `${update.entityName}_${baseEntityName}`,
        update.entity.$ID,
        valueEntity.$ID,
        false
    );
    await sp.app.model.domainModels.save(domainModel);
    return { subscription: subscription.entityName, batch: batch.entityName, update: update.entityName };
}

async function addMicroflowParameters(
    microflow: Microflows.Microflow,
    parameters: Array<{ name: string; type?: 'String' | 'DateTime'; entityQualifiedName?: string }>
): Promise<void> {
    const sp = getStudioPro();
    for (const [index, parameter] of parameters.entries()) {
        const parameterObject = await sp.app.model.microflows.createElement<Microflows.MicroflowParameterObject>(
            'Microflows$MicroflowParameterObject',
            parameter.entityQualifiedName
                ? { name: parameter.name, type: 'Object', entity: parameter.entityQualifiedName }
                : { name: parameter.name, type: parameter.type ?? 'String' }
        );
        parameterObject.size = { width: 30, height: 30 };
        parameterObject.relativeMiddlePoint = { x: 100 + index * 100, y: 0 };
        microflow.objectCollection.objects.push(parameterObject);
    }
}

async function createSubscriptionRestMicroflow(options: SubscriptionRestDefinition & {
    baseUrlConstantRef: string;
    authRefs: Awaited<ReturnType<typeof ensureEndpointConstants>>['authRefs'];
    endpointFolderId: string;
}): Promise<boolean> {
    const sp = getStudioPro();
    if (await findMicroflow(options.name)) return false;

    const microflow = await sp.app.model.microflows.addMicroflow(options.endpointFolderId, { name: options.name }, false);
    await addMicroflowParameters(microflow, options.parameters);
    await populateMicroflowWithRestCall(sp, microflow, {
        url: buildRestLocationTemplate(options.endpoint, options.baseUrlConstantRef).text,
        urlArgs: [options.baseUrlConstantRef],
        requestBody: options.requestBody,
        requestBodyArgs: options.requestBodyArgs,
        extraHeaders: JSON_EXTRA_HEADERS,
        authRefs: options.authRefs,
        importMappingQualifiedName: options.importMappingName
            ? `${IMPLEMENTATION_MODULE}.${options.importMappingName}`
            : undefined,
        importMappingOutput: options.output
            ? {
                  outputVariableName: options.output.variableName,
                  entityQualifiedName: `${IMPLEMENTATION_MODULE}.${options.output.entityName}`,
                  isList: options.output.isList,
              }
            : undefined,
        returnMappedResult: Boolean(options.output),
        commitImportedResult: options.commitImportedResult,
        annotationText: options.annotationText,
    });
    await sp.app.model.microflows.save(microflow);
    return true;
}

async function createSubscriptionSyncMicroflow(options: {
    name: string;
    baseUrlConstantRef: string;
    subscriptionClientIdConstantRef: string;
    authRefs: Awaited<ReturnType<typeof ensureEndpointConstants>>['authRefs'];
    endpointFolderId: string;
    importMappingName: string;
    subscriptionEntityName: string;
    outputEntityName: string;
}): Promise<boolean> {
    const sp = getStudioPro();
    if (await findMicroflow(options.name)) return false;

    const microflow = await sp.app.model.microflows.addMicroflow(options.endpointFolderId, { name: options.name }, false);
    const subscriptionQualifiedName = `${IMPLEMENTATION_MODULE}.${options.subscriptionEntityName}`;
    await addMicroflowParameters(microflow, [{ name: 'Subscription', entityQualifiedName: subscriptionQualifiedName }]);
    const lastSequenceNumberMember = `${subscriptionQualifiedName}.lastSequenceNumber`;
    const requestBodyExpression = buildSubscriptionSyncRequestExpression(options.subscriptionClientIdConstantRef);
    await populateMicroflowWithRestCall(sp, microflow, {
        url: buildRestLocationTemplate('/subscriptions/sync', options.baseUrlConstantRef).text,
        urlArgs: [options.baseUrlConstantRef],
        requestBody: '{1}',
        requestBodyArgs: ['$RequestBody'],
        requestBodyVariable: { name: 'RequestBody', expression: requestBodyExpression },
        extraHeaders: JSON_EXTRA_HEADERS,
        authRefs: options.authRefs,
        importMappingQualifiedName: `${IMPLEMENTATION_MODULE}.${options.importMappingName}`,
        importMappingOutput: {
            outputVariableName: 'SubscriptionBatches',
            entityQualifiedName: `${IMPLEMENTATION_MODULE}.${options.outputEntityName}`,
            isList: true,
        },
        returnMappedResult: true,
        persistMaxSequence: {
            inputListVariableName: 'SubscriptionBatches',
            sequenceAttribute: `${IMPLEMENTATION_MODULE}.${options.outputEntityName}.sequenceNumber`,
            outputVariableName: 'HighestSequenceNumber',
            targetObjectVariableName: 'Subscription',
            targetAttribute: lastSequenceNumberMember,
        },
    });
    await sp.app.model.microflows.save(microflow);
    return true;
}

export async function createSubscriptionArtifacts(
    objectType: ObjectType,
    connection: ConnectionConfig
): Promise<SubscriptionArtifactsResult> {
    const baseEntityName = toModelName(objectType.displayName);
    const { baseUrlConstantRef, subscriptionClientIdConstantRef, authRefs, objectTypeFolderId, mappingsFolderId } =
        await ensureObjectTypeArtifactContext(connection, baseEntityName);
    const entityNames = await ensureSubscriptionEntities(baseEntityName);

    const createJsonName = `JSON_${baseEntityName}_SubscribeCreate`;
    const createMappingName = `IM_${baseEntityName}_SubscribeCreate`;
    const createSnippet = JSON.stringify({
        success: true,
        result: { clientId: 'mendix-client-id', subscriptionId: 'subscription-id', displayName: baseEntityName },
    }, null, 2);
    const createJson = await createOrUpdateJsonStructure(createJsonName, createSnippet, mappingsFolderId);
    const createMapping = await createOrUpdateImportMapping(
        createMappingName,
        `${IMPLEMENTATION_MODULE}.${createJsonName}`,
        [`${OBJECT_PATH}|result`, `${OBJECT_PATH}|result|clientId`, `${OBJECT_PATH}|result|subscriptionId`, `${OBJECT_PATH}|result|displayName`],
        [{
            path: `${OBJECT_PATH}|result`,
            entityQualifiedName: `${IMPLEMENTATION_MODULE}.${entityNames.subscription}`,
            valueMappings: { clientId: 'clientId', subscriptionId: 'subscriptionId', displayName: 'displayName' },
        }],
        mappingsFolderId
    );

    const rawStructures = await getStudioPro().app.model.jsonStructures.getUnitsInfo();
    const valueStructureInfo = rawStructures.find(
        unit => unit.moduleName === IMPLEMENTATION_MODULE && unit.name === `JSON_${baseEntityName}`
    );
    let valuePayload: unknown = extractFirstResultValue(buildSyntheticValueResponse(objectType).parsed);
    if (valueStructureInfo) {
        const loaded = await getStudioPro().app.model.jsonStructures.loadAll(unit => unit.$ID === valueStructureInfo.$ID);
        try {
            valuePayload = extractFirstResultValue(JSON.parse(loaded[0]?.jsonSnippet ?? ''));
        } catch { /* use the schema-derived payload */ }
    }

    const syncJsonName = `JSON_${baseEntityName}_SubscribeSync`;
    const syncMappingName = `IM_${baseEntityName}_SubscribeSync`;
    const syncSnippet = buildSchemaAwareSubscriptionSnippet(valuePayload, objectType.schema);
    const syncJson = await createOrUpdateJsonStructure(syncJsonName, syncSnippet, mappingsFolderId);
    const batchPath = `${OBJECT_PATH}|result|${OBJECT_PATH}`;
    const updatePath = `${batchPath}|updates|${OBJECT_PATH}`;
    const valueEntries = buildMappingEntries(valuePayload, `${updatePath}|value`, baseEntityName, false);
    const syncMapping = await createOrUpdateImportMapping(
        syncMappingName,
        `${IMPLEMENTATION_MODULE}.${syncJsonName}`,
        [
            batchPath,
            `${batchPath}|sequenceNumber`,
            updatePath,
            `${updatePath}|elementId`,
            `${updatePath}|quality`,
            `${updatePath}|timestamp`,
            ...valueEntries.selectionPaths,
        ],
        [
            {
                path: batchPath,
                entityQualifiedName: `${IMPLEMENTATION_MODULE}.${entityNames.batch}`,
                valueMappings: { sequenceNumber: 'sequenceNumber' },
            },
            {
                path: updatePath,
                entityQualifiedName: `${IMPLEMENTATION_MODULE}.${entityNames.update}`,
                valueMappings: { elementId: 'elementId', quality: 'quality', timestamp: 'timestamp' },
            },
            ...valueEntries.mapObjects,
        ],
        mappingsFolderId
    );

    const definitions: SubscriptionRestDefinition[] = buildSubscriptionRestDefinitions(
        baseEntityName,
        entityNames,
        subscriptionClientIdConstantRef,
        createMappingName
    );

    const syncMicroflowName = `MF_${baseEntityName}_SubscribeSync`;
    let microflowsCreated = Number(await createSubscriptionSyncMicroflow({
        name: syncMicroflowName,
        baseUrlConstantRef,
        subscriptionClientIdConstantRef,
        authRefs,
        endpointFolderId: objectTypeFolderId,
        importMappingName: syncMappingName,
        subscriptionEntityName: entityNames.subscription,
        outputEntityName: entityNames.batch,
    }));
    for (const definition of definitions) {
        if (await createSubscriptionRestMicroflow({
            ...definition,
            baseUrlConstantRef,
            authRefs,
            endpointFolderId: objectTypeFolderId,
        })) microflowsCreated++;
    }

    return {
        subscriptionEntityName: entityNames.subscription,
        batchEntityName: entityNames.batch,
        updateEntityName: entityNames.update,
        jsonStructuresCreated: Number(createJson.created) + Number(syncJson.created),
        importMappingsCreated: Number(createMapping.created) + Number(syncMapping.created),
        microflowNames: [...definitions.map(definition => definition.name), syncMicroflowName],
        microflowsCreated,
    };
}

export async function createWriteMicroflow(
    objectType: ObjectType,
    connection: ConnectionConfig
): Promise<WriteMicroflowResult> {
    const sp = getStudioPro();
    const baseEntityName = toModelName(objectType.displayName);
    const { baseUrlConstantRef, authRefs, objectTypeFolderId, mappingsFolderId } =
        await ensureObjectTypeArtifactContext(connection, baseEntityName);
    const microflowName = `MF_${baseEntityName}_Write`;
    const exportMappingName = `EM_${baseEntityName}_Write`;

    // Verify the base entity exists — the write microflow reuses entities created
    // by the last-known-values flow and must never create its own.
    const domainModel = await sp.app.model.domainModels.getDomainModel(IMPLEMENTATION_MODULE);
    if (!domainModel || !domainModel.entities.find(e => e.name === baseEntityName)) {
        throw new Error(
            `Entity '${baseEntityName}' not found in module '${IMPLEMENTATION_MODULE}'. ` +
            `Run "Create last-known-value query microflow" first.`
        );
    }

    // Official i3X write calls send a VQT body. We emit the required value field
    // and leave optional quality/timestamp fields unset.
    const writeJsonStructureName = `JSON_${baseEntityName}_Write`;
    const rawStructures = await sp.app.model.jsonStructures.getUnitsInfo();
    const rawStructureInfo = rawStructures.find(
        u => u.moduleName === IMPLEMENTATION_MODULE && u.name === `JSON_${baseEntityName}`
    );
    let writeMappingPayload: unknown = { value: null };
    let writeEntityPath = '(Object)';
    let writeSnippet = stringifyJsonWithDecimalIntegers({ value: null });
    if (rawStructureInfo) {
        const loaded = await sp.app.model.jsonStructures.loadAll(u => u.$ID === rawStructureInfo.$ID);
        if (loaded.length > 0 && loaded[0].jsonSnippet) {
            try {
                const writePayloadConfig = buildWriteRequestPayload(
                    extractFirstResultValue(JSON.parse(loaded[0].jsonSnippet))
                );
                writeMappingPayload = writePayloadConfig.mappingPayload;
                writeEntityPath = writePayloadConfig.entityPath;
                writeSnippet = buildSchemaAwareWriteSnippet(writePayloadConfig.requestBody, objectType.schema);
            } catch {
                // keep defaults
            }
        }
    }
    await createOrUpdateJsonStructure(writeJsonStructureName, writeSnippet, mappingsFolderId);

    const exportMappingResult = await createOrUpdateExportMapping(
        exportMappingName,
        `${IMPLEMENTATION_MODULE}.${writeJsonStructureName}`,
        writeMappingPayload,
        baseEntityName,
        'InputObject',
        writeEntityPath,
        mappingsFolderId
    );

    const existing = await sp.app.model.microflows.loadAll(
        u => u.moduleName === IMPLEMENTATION_MODULE && u.name === microflowName,
        1
    );
    if (existing.length > 0) {
        return {
            microflowName,
            microflowId: existing[0].$ID,
            exportMappingName,
            microflowCreated: false,
            exportMappingCreated: exportMappingResult.created,
        };
    }

    const microflow = await sp.app.model.microflows.addMicroflow(objectTypeFolderId, { name: microflowName }, false);

    await addMicroflowParameters(microflow, [
        { name: 'ElementId' },
        { name: 'InputObject', entityQualifiedName: `${IMPLEMENTATION_MODULE}.${baseEntityName}` },
    ]);

    const locationTemplate = buildRestLocationTemplate('/objects/{2}/value', baseUrlConstantRef, ['$ElementId']);
    await populateMicroflowWithRestCall(sp, microflow, {
        url: locationTemplate.text,
        urlArgs: locationTemplate.args,
        requestBody: '',
        exportMapping: {
            mappingQualifiedName: `${IMPLEMENTATION_MODULE}.${exportMappingName}`,
            entityVariableName: 'InputObject',
        },
        extraHeaders: JSON_EXTRA_HEADERS,
        annotationText: 'Official i3X writeback uses PUT /objects/{elementId}/value. Change this REST call HTTP method to PUT manually before using this microflow.',
        authRefs,
    });
    await sp.app.model.microflows.save(microflow);

    return {
        microflowName,
        microflowId: microflow.$ID,
        exportMappingName,
        microflowCreated: true,
        exportMappingCreated: exportMappingResult.created,
    };
}

export async function createObjectsListMicroflow(
    connection: ConnectionConfig
): Promise<ImplementEntityResult> {
    const { baseUrlConstantRef, authRefs, endpointFolderId } = await ensureEndpointConstants(connection);
    const sp = getStudioPro();
    const domainModelResult = await ensureObjectListEntity();

    const jsonStructureName = 'JSON_GetObjectsForObjectType';
    const importMappingName = 'IM_GetObjectsForObjectType';
    const microflowName = 'MF_GetObjectsForObjectType';

    const jsonSnippet = buildGenericObjectListSnippet();
    const jsonStructureResult = await createOrUpdateJsonStructure(jsonStructureName, jsonSnippet, endpointFolderId);
    const importMappingResult = await createOrUpdateObjectListImportMapping(
        importMappingName,
        `${IMPLEMENTATION_MODULE}.${jsonStructureName}`,
        jsonStructureResult.jsonStructureId,
        endpointFolderId
    );

    const existingMicroflows = await sp.app.model.microflows.loadAll(
        unitInfo => unitInfo.moduleName === IMPLEMENTATION_MODULE && unitInfo.name === microflowName,
        1
    );
    if (existingMicroflows.length > 0) {
        return {
            ...domainModelResult,
            jsonStructureName,
            jsonStructureCreated: jsonStructureResult.created,
            importMappingName,
            importMappingCreated: importMappingResult.created,
            microflowName,
            microflowId: existingMicroflows[0].$ID,
            microflowCreated: false,
            jsonFetchFailed: false,
        };
    }

    const microflow = await sp.app.model.microflows.addMicroflow(endpointFolderId, { name: microflowName }, false);
    await addMicroflowParameters(microflow, [{ name: 'ObjectType' }]);

    const locationTemplate = buildRestLocationTemplate('/objects?typeElementId={2}', baseUrlConstantRef, ['$ObjectType']);
    await populateMicroflowWithRestCall(sp, microflow, {
        url: locationTemplate.text,
        urlArgs: locationTemplate.args,
        requestBody: '',
        authRefs,
        importMappingQualifiedName: `${IMPLEMENTATION_MODULE}.${importMappingName}`,
        importMappingOutput: {
            outputVariableName: 'ImportedObjects',
            entityQualifiedName: `${IMPLEMENTATION_MODULE}.${OBJECT_LIST_ENTITY_NAME}`,
            isList: true,
        },
        annotationText: 'Official i3X object listing uses GET /objects?typeElementId={objectType}. Change this REST call HTTP method to GET manually before using this microflow.',
        returnMappedResult: true,
    });
    await sp.app.model.microflows.save(microflow);

    return {
        ...domainModelResult,
        jsonStructureName,
        jsonStructureCreated: jsonStructureResult.created,
        importMappingName,
        importMappingCreated: importMappingResult.created,
        microflowName,
        microflowId: microflow.$ID,
        microflowCreated: true,
        jsonFetchFailed: false,
    };
}
