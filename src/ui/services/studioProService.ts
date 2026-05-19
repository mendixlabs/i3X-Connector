import type { DomainModels, Mappings, Projects, StudioProApi } from '@mendix/extensions-api';
import {
    IMPLEMENTATION_MODULE,
    CONSTANT_API_BASE_URL,
    CONSTANT_API_USERNAME,
    CONSTANT_API_PASSWORD,
    CONSTANT_API_TOKEN,
    DECIMAL_WRITE_MARKER,
    DECIMAL_INTEGER_MARKER,
    OBJECT_PATH,
    JSON_EXTRA_HEADERS,
} from '../constants';
import {
    isArrayProperty,
    isGroupProperty,
    extractArrayItemProperties,
    type AnyProperty,
    type AuthConfig,
    type ConnectionConfig,
    type LeafProperty,
    type ObjectType,
    type ObjectTypeSchema,
} from '../types';
import { getApiBaseUrl, getObjectsUrl, getObjectsValueUrl, unwrapI3xResult } from './i3xUrl';
import { buildI3xRequestHeaders, sanitizeHeaderName, type AuthConstantRefs } from './auth';
import {
    buildValueQueryHttpRequestBody,
    buildValueQueryMicroflowRequestBody,
    buildHistoryMicroflowRequestBody,
    populateMicroflowWithRestCall,
} from './microflowBuilder';
import { buildObjectTypeFromSample, buildSyntheticValueResponse, extractValueQueryPayload } from './schemaInference';

/**
 * Coordinates translating i3X schemas and live samples into Mendix artifacts.
 * Keep this file focused on orchestration and domain-model generation.
 */

let studioPro: StudioProApi | null = null;

export function initStudioPro(sp: StudioProApi): void {
    studioPro = sp;
}

export function getStudioPro(): StudioProApi {
    if (!studioPro) {
        throw new Error('StudioPro not initialized. Call initStudioPro() first.');
    }
    return studioPro;
}

export interface ArtifactCreationResult {
    baseEntityName: string;
    baseEntityCreated: boolean;
    groupEntitiesCreated: number;
    attributesCreated: number;
    associationsCreated: number;
    jsonStructureName: string;
    jsonStructureCreated: boolean;
    importMappingName: string;
    importMappingCreated: boolean;
    microflowName: string;
    microflowId?: string;
    microflowCreated: boolean;
    jsonFetchFailed: boolean;
}

export type ImplementEntityResult = ArtifactCreationResult;
export type QueryValuesMicroflowResult = ArtifactCreationResult;

export function summarizeArtifactResult(result: ArtifactCreationResult): { somethingCreated: boolean; summary: string } {
    const somethingCreated =
        result.baseEntityCreated ||
        result.groupEntitiesCreated > 0 ||
        result.attributesCreated > 0 ||
        result.associationsCreated > 0 ||
        result.jsonStructureCreated ||
        result.importMappingCreated ||
        result.microflowCreated;

    const summary = [
        `Base '${result.baseEntityName}'`,
        `Group entities: ${result.groupEntitiesCreated}`,
        `Attributes: ${result.attributesCreated}`,
        `Associations: ${result.associationsCreated}`,
        `JSON Structure '${result.jsonStructureName}' ${result.jsonStructureCreated ? 'created' : 'updated'}`,
        `Import Mapping '${result.importMappingName}' ${result.importMappingCreated ? 'created' : 'already exists'}`,
        `Microflow '${result.microflowName}' ${result.microflowCreated ? 'created' : 'already exists'}`,
    ].join(' | ');

    return { somethingCreated, summary };
}

interface JsonStructureResult {
    created: boolean;
    jsonStructureId: string;
}

interface ImportMappingResult {
    created: boolean;
    mappingId: string;
}

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


type MendixAttributeType = NonNullable<DomainModels.AttributeCreationOptions['type']>;
export const MENDIX_LONG_MAX = Number('9223372036854775807');

// ── Layout constants ──────────────────────────────────────────────────────────
const ATTR_ROW_H  = 20;   // px per attribute row
const ENTITY_HDR_H = 30;  // px for entity header
const H_GAP        = 80;  // horizontal gap between base and group column
const V_GAP        = 40;  // vertical gap between group entities
const BASE_WIDTH   = 200; // base entity column width
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

function toModelName(raw: string): string {
    const compact = raw.trim().replace(/[^A-Za-z0-9_]/g, '_').replace(/_+/g, '_');
    const startsWithLetter = /^[A-Za-z]/.test(compact) ? compact : `N_${compact}`;
    return startsWithLetter || 'Unnamed';
}

function primaryType(type: unknown): string | undefined {
    if (Array.isArray(type)) return (type as string[]).find(t => t !== 'null');
    return typeof type === 'string' ? type : undefined;
}

function getAttributeType(property: LeafProperty): MendixAttributeType {
    const pType = primaryType(property.type);

    if (pType === 'string') {
        if (property.format === 'date-time' || property.format === 'date') {
            return 'DateTime';
        }
        return 'String';
    }

    if (pType === 'boolean') {
        return 'Boolean';
    }

    if (pType === 'integer') {
        if (property.format === 'int64' || property.format === 'long') {
            return 'Long';
        }
        return 'Integer';
    }

    if (pType === 'number') {
        return 'Decimal';
    }

    return 'String';
}

function getChildPropertiesIfAny(property: AnyProperty): Record<string, AnyProperty> | null {
    if (isGroupProperty(property)) {
        return property.properties as Record<string, AnyProperty>;
    }

    if (isArrayProperty(property)) {
        return extractArrayItemProperties(property) as Record<string, AnyProperty> | null;
    }

    return null;
}

function countDirectLeafProperties(properties: Record<string, AnyProperty>): number {
    return Object.values(properties).filter(property => getChildPropertiesIfAny(property) === null).length;
}

async function ensureEntity(
    domainModel: DomainModels.DomainModel,
    preferredName: string
): Promise<{ entity: DomainModels.Entity; entityName: string; created: boolean }> {
    const entityName = toModelName(preferredName);
    const existing = domainModel.getEntity(entityName);
    if (existing) {
        return { entity: existing, entityName, created: false };
    }

    const entity = await domainModel.addEntity({ name: entityName });
    if (entity.generalization.$Type === 'DomainModels$NoGeneralization') {
        entity.generalization.persistable = false;
    }

    return { entity, entityName, created: true };
}

async function ensureAssociation(
    domainModel: DomainModels.DomainModel,
    associationName: string,
    parentEntityId: string,
    childEntityId: string,
    isArrayAssociation: boolean
): Promise<boolean> {
    if (domainModel.getAssociation(associationName)) {
        return false;
    }

    await domainModel.addAssociation({
        name: associationName,
        parentEntity: parentEntityId,
        childEntity: childEntityId,
        multiplicity: isArrayAssociation ? 'many_to_many' : 'one_to_many',
    });
    return true;
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

async function getRequiredProjectModule(): Promise<Readonly<Projects.Module>> {
    const sp = getStudioPro();
    return (await sp.app.model.modules.getModule(IMPLEMENTATION_MODULE)) ?? sp.app.model.modules.addModule(IMPLEMENTATION_MODULE);
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

interface EndpointSetup {
    baseUrlConstantRef: string;
    authRefs: AuthConstantRefs;
    endpointFolderId: string;
}

function sanitizeFolderName(raw: string): string {
    return raw.trim().replace(/[^A-Za-z0-9_]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '') || 'Endpoint';
}

function deriveEndpointFolderName(normalizedBaseUrl: string): string {
    try {
        const url = new URL(normalizedBaseUrl);
        const host = url.hostname;
        const port = url.port ? `_${url.port}` : '';
        const path = url.pathname.replace(/^\/|\/$/g, '').replace(/\//g, '_');
        const raw = path ? `${host}${port}_${path}` : `${host}${port}`;
        return sanitizeFolderName(raw);
    } catch {
        return sanitizeFolderName(normalizedBaseUrl);
    }
}

async function ensureFolder(parentId: string, name: string): Promise<{ $ID: string }> {
    const sp = getStudioPro();
    return (await sp.app.model.projects.getFolder(parentId, name))
        ?? await sp.app.model.projects.addFolder(parentId, name);
}

function withSuffix(name: string, suffix: string): string {
    return suffix ? `${name}_${suffix}` : name;
}

async function ensureEndpointConstants(connection: ConnectionConfig): Promise<EndpointSetup> {
    const normalizedBaseUrl = getApiBaseUrl(connection.apiBaseUrl);
    if (!normalizedBaseUrl) {
        throw new Error(`Cannot build base API URL from '${connection.apiBaseUrl}'.`);
    }

    const module = await getRequiredProjectModule();

    if (!connection.multiServerMode) {
        return ensureEndpointConstantsSingle(connection, normalizedBaseUrl, module.$ID);
    }

    const sp = getStudioPro();
    const folderName = deriveEndpointFolderName(normalizedBaseUrl);
    const endpointFolder = await ensureFolder(module.$ID, folderName);
    const endpointFolderId = endpointFolder.$ID;

    const baseUrlConstantName = `API_BaseUrl_${folderName}`;
    const existingNames = await getExistingConstantNames(sp);

    if (!existingNames.has(baseUrlConstantName)) {
        const configFolder = await ensureFolder(endpointFolderId, 'Configuration');
        await sp.app.model.constants.addConstant(configFolder.$ID, {
            name: baseUrlConstantName,
            type: 'String',
            defaultValue: normalizedBaseUrl,
            exposedToClient: false,
        });
    }

    const baseUrlConstantRef = `@${IMPLEMENTATION_MODULE}.${baseUrlConstantName}`;
    const authRefs = await ensureAuthConstants(connection.auth, folderName, endpointFolderId, existingNames);
    return { baseUrlConstantRef, authRefs, endpointFolderId };
}

async function ensureEndpointConstantsSingle(
    connection: ConnectionConfig,
    normalizedBaseUrl: string,
    moduleId: string
): Promise<EndpointSetup> {
    const sp = getStudioPro();
    const existingNames = await getExistingConstantNames(sp);

    const baseUrlConstantName = CONSTANT_API_BASE_URL;
    if (!existingNames.has(baseUrlConstantName)) {
        const configFolder = await ensureFolder(moduleId, 'Configuration');
        await sp.app.model.constants.addConstant(configFolder.$ID, {
            name: baseUrlConstantName,
            type: 'String',
            defaultValue: normalizedBaseUrl,
            exposedToClient: false,
        });
    }

    const baseUrlConstantRef = `@${IMPLEMENTATION_MODULE}.${baseUrlConstantName}`;
    const authRefs = await ensureAuthConstants(connection.auth, '', moduleId, existingNames);
    return { baseUrlConstantRef, authRefs, endpointFolderId: moduleId };
}

async function getExistingConstantNames(sp: ReturnType<typeof getStudioPro>): Promise<Set<string>> {
    return new Set(
        (await sp.app.model.constants.getUnitsInfo())
            .filter(u => u.moduleName === IMPLEMENTATION_MODULE)
            .map(u => u.name)
            .filter((n): n is string => n !== undefined)
    );
}

async function ensureAuthConstants(
    auth: AuthConfig,
    suffix: string,
    containerFolderId: string,
    existingNames: Set<string>
): Promise<AuthConstantRefs> {
    if (auth.mode === 'none') return { mode: 'none' };

    const sp = getStudioPro();

    if (auth.mode === 'basic') {
        const usernameName = withSuffix(CONSTANT_API_USERNAME, suffix);
        const passwordName = withSuffix(CONSTANT_API_PASSWORD, suffix);
        const toCreate: { name: string; value: string }[] = [];
        if (!existingNames.has(usernameName)) toCreate.push({ name: usernameName, value: auth.username });
        if (!existingNames.has(passwordName)) toCreate.push({ name: passwordName, value: auth.password });

        if (toCreate.length > 0) {
            const configFolder = await ensureFolder(containerFolderId, 'Configuration');
            const constantNames = toCreate.map(c => `• ${IMPLEMENTATION_MODULE}.${c.name}`).join('\n');
            const prefill = await sp.ui.messageBoxes.ask({
                type: 'confirmation',
                question: `The following Constants will be created to store authentication credentials:\n\n${constantNames}\n\nPrefill with the credentials you entered?`,
            });
            for (const { name, value } of toCreate) {
                await sp.app.model.constants.addConstant(configFolder.$ID, {
                    name, type: 'String', defaultValue: prefill ? value : '', exposedToClient: false,
                });
            }
        }
        return {
            mode: 'basic',
            usernameRef: `@${IMPLEMENTATION_MODULE}.${usernameName}`,
            passwordRef: `@${IMPLEMENTATION_MODULE}.${passwordName}`,
        };
    }

    // token mode
    const tokenName = withSuffix(CONSTANT_API_TOKEN, suffix);
    if (!existingNames.has(tokenName)) {
        const configFolder = await ensureFolder(containerFolderId, 'Configuration');
        const prefill = await sp.ui.messageBoxes.ask({
            type: 'confirmation',
            question: `The Constant '${IMPLEMENTATION_MODULE}.${tokenName}' will be created to store the authentication token.\n\nPrefill with the token you entered?`,
        });
        await sp.app.model.constants.addConstant(configFolder.$ID, {
            name: tokenName, type: 'String', defaultValue: prefill ? auth.token : '', exposedToClient: false,
        });
    }

    const headerName = sanitizeHeaderName(auth.headerName) || 'Authorization';
    return {
        mode: 'token',
        tokenRef: `@${IMPLEMENTATION_MODULE}.${tokenName}`,
        headerName,
        prefix: auth.prefix.trim(),
    };
}

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
            const groupEntityInfo = await ensureEntity(domainModel, `${parentEntityName}_${propertyName}`);

            if (groupEntityInfo.created) {
                counters.groupEntitiesCreated += 1;
                groupEntityInfo.entity.location = {
                    x: depth * (BASE_WIDTH + H_GAP),
                    y: counters.nextNestedEntityY,
                };
                counters.nextNestedEntityY += entityHeight(countDirectLeafProperties(nestedProperties)) + V_GAP;
            }

            const assocName = `${parentEntityName}_${groupEntityInfo.entityName}`;
            if (await ensureAssociation(domainModel, assocName, parentEntity.$ID, groupEntityInfo.entity.$ID, isResolvableArray)) {
                counters.associationsCreated += 1;
            }

            await populateEntityProperties(domainModel, groupEntityInfo.entityName, groupEntityInfo.entity, nestedProperties, depth + 1, counters);
            continue;
        }

        if (isArrayProperty(property)) continue;

        const attributeName = toModelName(propertyName);
        if (parentEntity.getAttribute(attributeName)) continue;

        await parentEntity.addAttribute({ name: attributeName, type: getAttributeType(property as LeafProperty) });
        counters.attributesCreated += 1;
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

    const baseEntityInfo = await ensureEntity(domainModel, baseEntityName);
    if (baseEntityInfo.created) {
        baseEntityInfo.entity.location = { x: 0, y: baseY };
    }

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
        const groupEntityInfo = await ensureEntity(domainModel, `${baseEntityName}_${propertyName}`);

        if (groupEntityInfo.created) {
            counters.groupEntitiesCreated += 1;
            const groupY = getGroupY(groupEntryList, startY, groupIndex);
            groupEntityInfo.entity.location = { x: BASE_WIDTH + H_GAP, y: groupY };
            counters.nextNestedEntityY = Math.max(counters.nextNestedEntityY, groupY + entityHeight(countDirectLeafProperties(nestedProperties)) + V_GAP);
        }

        const assocName = `${baseEntityName}_${groupEntityInfo.entityName}`;
        if (await ensureAssociation(domainModel, assocName, baseEntityInfo.entity.$ID, groupEntityInfo.entity.$ID, isResolvableArray)) {
            counters.associationsCreated += 1;
        }

        await populateEntityProperties(domainModel, groupEntityInfo.entityName, groupEntityInfo.entity, nestedProperties, 2, counters);
    }

    // ── Leaf properties → attributes on base entity ───────────────────────────
    for (const [propertyName, property] of Object.entries(allProperties)) {
        if (getChildPropertiesIfAny(property) !== null || isArrayProperty(property)) continue;

        const attributeName = toModelName(propertyName);
        if (baseEntityInfo.entity.getAttribute(attributeName)) continue;

        await baseEntityInfo.entity.addAttribute({ name: attributeName, type: getAttributeType(property as LeafProperty) });
        counters.attributesCreated += 1;
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
    const entityInfo = await ensureEntity(domainModel, OBJECT_LIST_ENTITY_NAME);
    if (entityInfo.created) {
        entityInfo.entity.location = { x: 0, y: startY };
    }

    let attributesCreated = 0;
    for (const attributeName of OBJECT_LIST_ATTRIBUTE_NAMES) {
        if (entityInfo.entity.getAttribute(attributeName)) continue;
        await entityInfo.entity.addAttribute({ name: attributeName, type: 'String' });
        attributesCreated += 1;
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

    const entity = domainModel.getEntity(entityName);
    const attribute = entity?.getAttribute(attributeName);
    if (!attribute || attribute.type.$Type === 'DomainModels$DateTimeAttributeType') {
        return;
    }

    const dateTimeType = await sp.app.model.domainModels.createElement<DomainModels.DateTimeAttributeType>('DomainModels$DateTimeAttributeType');
    dateTimeType.localizeDate = false;
    attribute.type = dateTimeType;
    await sp.app.model.domainModels.save(domainModel);
}

async function createOrUpdateJsonStructure(
    structureName: string,
    jsonSnippet: string,
    parentId: string
): Promise<JsonStructureResult> {
    const sp = getStudioPro();
    const existingStructures = await sp.app.model.jsonStructures.getUnitsInfo();
    const existingInfo = existingStructures.find(
        u => u.moduleName === IMPLEMENTATION_MODULE && u.name === structureName
    );

    if (existingInfo) {
        const loaded = await sp.app.model.jsonStructures.loadAll(u => u.$ID === existingInfo.$ID);
        if (loaded.length > 0) {
            loaded[0].jsonSnippet = jsonSnippet;
            await sp.app.model.jsonStructures.save(loaded[0]);
            return { created: false, jsonStructureId: loaded[0].$ID };
        }
        return { created: false, jsonStructureId: existingInfo.$ID };
    }

    const created = await sp.app.model.jsonStructures.addJsonStructure(parentId, { name: structureName, jsonSnippet });
    await sp.app.model.jsonStructures.save(created);
    return { created: true, jsonStructureId: created.$ID };
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
const VALUE_ENVELOPE_SELECTION_PATHS: string[] = [];
const WRITE_VALUE_OBJECT_PATH = `${OBJECT_PATH}|value`;

// Paths in the official /objects/history response.
const HISTORY_VALUE_PATH = `${OBJECT_PATH}|results|${OBJECT_PATH}|result|values|${OBJECT_PATH}`;
const HISTORY_ENVELOPE_SELECTION_PATHS: string[] = [];

async function createValueQueryArtifacts(
    objectType: ObjectType,
    selectedObject: { elementId: string } | null,
    connection: ConnectionConfig,
    objectsValueUrl: string,
    endpointFolderId: string
): Promise<ValueQueryArtifactsResult & { syntheticData: boolean }> {
    const baseEntityName = toModelName(objectType.displayName);
    const sampleResponse = selectedObject !== null
        ? await fetchJsonSampleResponse(objectsValueUrl, connection, {
              method: 'POST',
              headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
              body: buildValueQueryHttpRequestBody(selectedObject.elementId.trim()),
          })
        : buildSyntheticValueResponse(objectType);

    // Value-query entities come from the unwrapped latest-value payload, while
    // the JSON Structure is intentionally created from the raw response body.
    const valuePayload = extractValueQueryPayload(sampleResponse.parsed);
    const valueImportEntityPath = getValueQueryImportEntityPath(sampleResponse.parsed);
    const generatedObjectType = buildObjectTypeFromSample(baseEntityName, valuePayload);
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
        VALUE_ENVELOPE_SELECTION_PATHS,
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

    const itemPath = fieldPaths[0].slice(0, -(`|${OBJECT_LIST_ATTRIBUTE_NAMES[0]}`).length);
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
    const endpointSetup = await ensureEndpointConstants(connection);
    const { baseUrlConstantRef, authRefs, endpointFolderId } = endpointSetup;
    const objectTypeName = toModelName(objectType.displayName);
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
        endpointFolderId
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

    const microflow = await sp.app.model.microflows.addMicroflow(endpointFolderId, { name: microflowName }, false);
    const elementIdParam = await microflow.objectCollection.addMicroflowParameterObject({ name: 'ElementId', type: 'String' });
    if (elementIdParam) {
        elementIdParam.size = { width: 30, height: 30 };
        elementIdParam.relativeMiddlePoint = { x: 100, y: 0 };
    }

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
    const { baseUrlConstantRef, authRefs, endpointFolderId } = await ensureEndpointConstants(connection);

    const baseEntityName = toModelName(objectType.displayName);
    const historyEntityName = `${baseEntityName}_History`;
    const microflowName = `MF_${baseEntityName}_History`;
    const jsonStructureName = `JSON_History_${baseEntityName}`;
    const importMappingName = `IM_History_${baseEntityName}`;

    // Require value-query artifacts to exist first so we can reuse the sampled
    // latest-value payload when building the history entry shape.
    const domainModel = await sp.app.model.domainModels.getDomainModel(IMPLEMENTATION_MODULE);
    if (!domainModel || !domainModel.getEntity(baseEntityName)) {
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

    const historySnippet = stringifyJsonWithDecimalIntegers(
        buildHistoryResponseSample(objectType, historyValuePayload)
    );
    const jsonStructureResult = await createOrUpdateJsonStructure(jsonStructureName, historySnippet, endpointFolderId);
    const { selectionPaths: historySelPaths, mapObjects: historyMapObjects } = buildHistoryImportMappingEntries(
        HISTORY_VALUE_PATH, historyEntityName, baseEntityName, historyValuePayload
    );
    const importMappingResult = await createOrUpdateImportMapping(
        importMappingName,
        `${IMPLEMENTATION_MODULE}.${jsonStructureName}`,
        [...HISTORY_ENVELOPE_SELECTION_PATHS, ...historySelPaths],
        historyMapObjects,
        endpointFolderId
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

    const microflow = await sp.app.model.microflows.addMicroflow(endpointFolderId, { name: microflowName }, false);

    const elementIdParam = await microflow.objectCollection.addMicroflowParameterObject({ name: 'ElementId', type: 'String' });
    if (elementIdParam) {
        elementIdParam.size = { width: 30, height: 30 };
        elementIdParam.relativeMiddlePoint = { x: 100, y: 0 };
    }

    await microflow.objectCollection.addMicroflowParameterObject({ name: 'StartTime', type: 'DateTime' });
    const startTimeParam = microflow.objectCollection.getMicroflowParameterObject('StartTime');
    if (startTimeParam) {
        startTimeParam.size = { width: 30, height: 30 };
        startTimeParam.relativeMiddlePoint = { x: 200, y: 0 };
    }

    await microflow.objectCollection.addMicroflowParameterObject({ name: 'EndTime', type: 'DateTime' });
    const endTimeParam = microflow.objectCollection.getMicroflowParameterObject('EndTime');
    if (endTimeParam) {
        endTimeParam.size = { width: 30, height: 30 };
        endTimeParam.relativeMiddlePoint = { x: 300, y: 0 };
    }

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

        if (parentEntityQualifiedName !== null && el.entity) {
            const parentEntityName = parentEntityQualifiedName.split('.').pop() ?? '';
            const childEntityName = el.entity.split('.').pop() ?? '';
            el.association = `${IMPLEMENTATION_MODULE}.${parentEntityName}_${childEntityName}`;
        } else {
            el.association = null;
        }

        fixMappingElements(
            el.children.filter((c): c is Mappings.ObjectMappingElement => 'children' in c),
            el.entity,
            objectHandling === 'Parameter' ? 'Find' : objectHandling
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
    envelopePaths: string[],
    parentId: string
): Promise<ImportMappingResult> {
    const { selectionPaths, mapObjects } = buildMappingEntries(parsedValuePayload, entityPath, baseEntityName, false);
    const allSelectionPaths = [...envelopePaths, ...selectionPaths];
    return createOrUpdateImportMapping(mappingName, jsonStructureQualifiedName, allSelectionPaths, mapObjects, parentId);
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
    const historyEntityInfo = await ensureEntity(domainModel, historyEntityName);
    if (historyEntityInfo.created) {
        historyEntityInfo.entity.location = { x: 0, y: startY };
    }

    let attributesCreated = 0;
    if (!historyEntityInfo.entity.getAttribute('quality')) {
        await historyEntityInfo.entity.addAttribute({ name: 'quality', type: 'String' });
        attributesCreated++;
    }
    if (!historyEntityInfo.entity.getAttribute('timestamp')) {
        await historyEntityInfo.entity.addAttribute({ name: 'timestamp', type: 'DateTime' });
        attributesCreated++;
    }

    const baseEntity = domainModel.getEntity(baseEntityName);
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
    return domainModel.getEntity(entityName) !== undefined;
}

export interface WriteMicroflowResult {
    microflowName: string;
    microflowId: string;
    exportMappingName: string;
    microflowCreated: boolean;
    exportMappingCreated: boolean;
}

export async function createWriteMicroflow(
    objectType: ObjectType,
    connection: ConnectionConfig
): Promise<WriteMicroflowResult> {
    const sp = getStudioPro();
    const { baseUrlConstantRef, authRefs, endpointFolderId } = await ensureEndpointConstants(connection);

    const typeName = toModelName(objectType.displayName);
    const baseEntityName = toModelName(objectType.displayName);
    const microflowName = `MF_${typeName}_Write`;
    const exportMappingName = `EM_Write_${typeName}`;

    // Verify the base entity exists — the write microflow reuses entities created
    // by the last-known-values flow and must never create its own.
    const domainModel = await sp.app.model.domainModels.getDomainModel(IMPLEMENTATION_MODULE);
    if (!domainModel || !domainModel.getEntity(baseEntityName)) {
        throw new Error(
            `Entity '${baseEntityName}' not found in module '${IMPLEMENTATION_MODULE}'. ` +
            `Run "Create last-known-value query microflow" first.`
        );
    }

    // Official i3X write calls send a VQT body. We emit the required value field
    // and leave optional quality/timestamp fields unset.
    const writeJsonStructureName = `JSON_Write_${baseEntityName}`;
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
    await createOrUpdateJsonStructure(writeJsonStructureName, writeSnippet, endpointFolderId);

    const exportMappingResult = await createOrUpdateExportMapping(
        exportMappingName,
        `${IMPLEMENTATION_MODULE}.${writeJsonStructureName}`,
        writeMappingPayload,
        baseEntityName,
        'InputObject',
        writeEntityPath,
        endpointFolderId
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

    const microflow = await sp.app.model.microflows.addMicroflow(endpointFolderId, { name: microflowName }, false);

    const elementIdParam = await microflow.objectCollection.addMicroflowParameterObject({ name: 'ElementId', type: 'String' });
    if (elementIdParam) {
        elementIdParam.size = { width: 30, height: 30 };
        elementIdParam.relativeMiddlePoint = { x: 100, y: 0 };
    }

    const inputParam = await microflow.objectCollection.addMicroflowParameterObject({
        name: 'InputObject',
        type: 'Object',
        entity: `${IMPLEMENTATION_MODULE}.${baseEntityName}`,
    });
    if (inputParam) {
        inputParam.size = { width: 30, height: 30 };
        inputParam.relativeMiddlePoint = { x: 200, y: 0 };
    }

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
    const objectTypeParam = await microflow.objectCollection.addMicroflowParameterObject({ name: 'ObjectType', type: 'String' });
    if (objectTypeParam) {
        objectTypeParam.size = { width: 30, height: 30 };
        objectTypeParam.relativeMiddlePoint = { x: 100, y: 0 };
    }

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
