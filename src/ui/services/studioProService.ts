import type { DataTypes, DomainModels, Mappings, Projects, StudioProApi } from '@mendix/extensions-api';
import {
    isArrayProperty,
    isGroupProperty,
    extractArrayItemProperties,
    type AnyProperty,
    type ConnectionConfig,
    type LeafProperty,
    type ObjectType,
} from '../types';
import { getObjectsUrl, getObjectsValueUrl, getObjectsHistoryUrl, getObjectWriteUrl } from './i3xUrl';
import { buildI3xRequestHeaders } from './auth';
import {
    buildValueQueryHttpRequestBody,
    buildValueQueryMicroflowRequestBody,
    buildHistoryMicroflowRequestBody,
    populateMicroflowWithRestCall,
} from './microflowBuilder';
import { buildObjectTypeFromSample, extractValueQueryPayload } from './schemaInference';

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

type ModuleLookupApi = {
    getModule(name: string): Promise<Readonly<Projects.Module> | null>;
};

type MendixAttributeType = NonNullable<DomainModels.AttributeCreationOptions['type']>;
const MENDIX_LONG_MIN = Number('-9223372036854775808');
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

function toModelName(raw: string): string {
    const compact = raw.trim().replace(/[^A-Za-z0-9_]/g, '_').replace(/_+/g, '_');
    const startsWithLetter = /^[A-Za-z]/.test(compact) ? compact : `N_${compact}`;
    return startsWithLetter || 'Unnamed';
}

function getAttributeType(property: LeafProperty): MendixAttributeType {
    if (property.type === 'string') {
        if (property.format === 'date-time' || property.format === 'date') {
            return 'DateTime';
        }
        return 'String';
    }

    if (property.type === 'boolean') {
        return 'Boolean';
    }

    if (property.type === 'integer') {
        if (property.format === 'int64' || property.format === 'long') {
            return 'Long';
        }
        return 'Integer';
    }

    if (property.type === 'number') {
        return 'Decimal';
    }

    return 'String';
}

function clampToMendixLong(value: number): number {
    if (!Number.isFinite(value)) return value;
    if (value < MENDIX_LONG_MIN) return MENDIX_LONG_MIN;
    if (value > MENDIX_LONG_MAX) return MENDIX_LONG_MAX;
    return value;
}

function sanitizeJsonForMendixLimits(value: unknown, parentKey?: string): unknown {
    if (Array.isArray(value)) {
        return value.map(item => sanitizeJsonForMendixLimits(item));
    }

    if (value !== null && typeof value === 'object') {
        const sanitized: Record<string, unknown> = {};
        for (const [key, childValue] of Object.entries(value)) {
            sanitized[key] = sanitizeJsonForMendixLimits(childValue, key);
        }
        return sanitized;
    }

    if (typeof value === 'number' && (parentKey === 'minimum' || parentKey === 'maximum')) {
        return clampToMendixLong(value);
    }

    return value;
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
    sp: StudioProApi,
    url: string,
    connection: ConnectionConfig,
    init?: RequestInit
): Promise<JsonSampleResponse> {
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

async function getProjectModule(
    sp: StudioProApi,
    moduleName: string
): Promise<Readonly<Projects.Module> | null> {
    const modelWithModules = sp.app.model as typeof sp.app.model & {
        modules?: ModuleLookupApi;
    };

    const moduleApi = modelWithModules.modules ?? (sp.app.model.projects as ModuleLookupApi);
    return moduleApi.getModule(moduleName);
}

async function getRequiredProjectModule(
    sp: StudioProApi,
    moduleName: string
): Promise<Readonly<Projects.Module>> {
    const module = await getProjectModule(sp, moduleName);
    if (!module) {
        throw new Error(`Module '${moduleName}' was not found.`);
    }

    return module;
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

function computeEntityStartY(domainModel: DomainModels.DomainModel): number {
    let startY = 0;
    for (const ent of domainModel.entities) {
        const bottom = ent.location.y + ENTITY_HDR_H + ATTR_ROW_H + V_GAP;
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

async function buildDomainModelEntities(
    sp: StudioProApi,
    selectedObject: ObjectType,
    moduleName: string
): Promise<DomainModelResult> {
    const baseEntityName = toModelName(selectedObject.displayName);
    if (!baseEntityName) {
        throw new Error('Selected object has no valid name.');
    }

    const domainModel = await sp.app.model.domainModels.getDomainModel(moduleName);
    if (!domainModel) {
        throw new Error(`Module '${moduleName}' was not found or has no domain model.`);
    }

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

async function createOrUpdateJsonStructure(
    sp: StudioProApi,
    moduleId: string,
    moduleName: string,
    structureName: string,
    jsonSnippet: string
): Promise<JsonStructureResult> {
    const existingStructures = await sp.app.model.jsonStructures.getUnitsInfo();
    const existingInfo = existingStructures.find(
        u => u.moduleName === moduleName && u.name === structureName
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

    const created = await sp.app.model.jsonStructures.addJsonStructure(moduleId, { name: structureName, jsonSnippet });
    await sp.app.model.jsonStructures.save(created);
    return { created: true, jsonStructureId: created.$ID };
}

async function createOrUpdateImportMapping(
    sp: StudioProApi,
    moduleId: string,
    moduleName: string,
    mappingName: string,
    jsonStructureQualifiedName: string
): Promise<ImportMappingResult> {
    const existingMappings = await sp.app.model.importMappings.getUnitsInfo();
    const existingInfo = existingMappings.find(
        u => u.moduleName === moduleName && u.name === mappingName
    );

    if (existingInfo) {
        return { created: false, mappingId: existingInfo.$ID };
    }

    const createdMapping = await sp.app.model.importMappings.addImportMapping(moduleId, {
        name: mappingName,
        selectStructure: {
            structureType: 'jsonStructure',
            structureQualifiedName: jsonStructureQualifiedName,
            mapElements: { mappingType: 'automatic' },
        },
    });
    await sp.app.model.importMappings.save(createdMapping);
    return { created: true, mappingId: createdMapping.$ID };
}

async function createValueQueryArtifacts(
    sp: StudioProApi,
    moduleId: string,
    moduleName: string,
    objectType: ObjectType,
    selectedObject: { elementId: string; displayName: string },
    connection: ConnectionConfig,
    objectsValueUrl: string
): Promise<ValueQueryArtifactsResult> {
    const baseEntityName = toModelName(`${objectType.displayName}_${selectedObject.displayName}`);
    const requestBody = buildValueQueryHttpRequestBody(selectedObject.elementId.trim());
    const sampleResponse = await fetchJsonSampleResponse(sp, objectsValueUrl, connection, {
        method: 'POST',
        headers: {
            Accept: 'application/json',
            'Content-Type': 'application/json',
        },
        body: requestBody,
    });

    // Value-query entities come from the unwrapped latest-value payload, while
    // the JSON Structure is intentionally created from the raw response body.
    const generatedObjectType = buildObjectTypeFromSample(
        baseEntityName,
        extractValueQueryPayload(sampleResponse.parsed)
    );
    const domainModelResult = await buildDomainModelEntities(sp, generatedObjectType, moduleName);

    const jsonStructureName = `JSON_${baseEntityName}`;
    const importMappingName = `IM_${baseEntityName}`;
    const jsonSnippet = sampleResponse.rawText;
    const jsonStructureResult = await createOrUpdateJsonStructure(
        sp,
        moduleId,
        moduleName,
        jsonStructureName,
        jsonSnippet
    );
    const importMappingResult = await createOrUpdateImportMapping(
        sp,
        moduleId,
        moduleName,
        importMappingName,
        `${moduleName}.${jsonStructureName}`
    );

    return {
        ...domainModelResult,
        jsonStructureName,
        jsonStructureCreated: jsonStructureResult.created,
        importMappingName,
        importMappingCreated: importMappingResult.created,
        importMappingId: importMappingResult.mappingId,
    };
}

async function buildObjectTypeJsonSnippet(
    sp: StudioProApi,
    selectedObject: ObjectType,
    connection: ConnectionConfig,
    objectsUrl: string | null
): Promise<{ snippet: string; fetchFailed: boolean }> {
    const fallbackSnippet = JSON.stringify(sanitizeJsonForMendixLimits(selectedObject), null, 2);
    if (!objectsUrl) {
        return { snippet: fallbackSnippet, fetchFailed: false };
    }

    try {
        const proxyUrl = await sp.network.httpProxy.getProxyUrl(objectsUrl);
        const response = await fetch(proxyUrl, {
            headers: buildI3xRequestHeaders(connection.auth),
        });
        if (!response.ok) {
            console.warn(`[i3X] Failed to fetch object instances (HTTP ${response.status}); JSON structure will use schema fallback.`);
            return { snippet: fallbackSnippet, fetchFailed: true };
        }
        const data = await response.json();
        return { snippet: JSON.stringify(sanitizeJsonForMendixLimits(data), null, 2), fetchFailed: false };
    } catch (err) {
        console.warn('[i3X] Error fetching object instances; JSON structure will use schema fallback.', err);
        return { snippet: fallbackSnippet, fetchFailed: true };
    }
}

async function ensureMicroflowForObject(
    sp: StudioProApi,
    moduleId: string,
    moduleName: string,
    microflowName: string,
    objectsUrl: string,
    connection: ConnectionConfig,
    importMappingId: string
): Promise<boolean> {
    const existingMicroflows = await sp.app.model.microflows.loadAll(
        unitInfo => unitInfo.moduleName === moduleName && unitInfo.name === microflowName,
        1
    );
    if (existingMicroflows.length > 0) return false;

    const microflow = await sp.app.model.microflows.addMicroflow(moduleId, { name: microflowName });
    await populateMicroflowWithRestCall(sp, microflow, {
        url: objectsUrl,
        requestBody: '',
        connection,
        importMappingId,
    });
    await sp.app.model.microflows.save(microflow);
    return true;
}

export async function createQueryValuesMicroflow(
    objectType: ObjectType,
    selectedObject: { elementId: string; displayName: string },
    connection: ConnectionConfig,
    moduleName = 'i3X_Connector'
): Promise<QueryValuesMicroflowResult> {
    const sp = getStudioPro();
    const objectTypeName = toModelName(objectType.displayName);
    const objectDisplayName = toModelName(selectedObject.displayName);
    const selectedElementId = selectedObject.elementId.trim();
    const microflowName = `MF_${objectTypeName}_${objectDisplayName}`;

    if (!selectedElementId) {
        throw new Error('Selected object has no valid elementId.');
    }

    const objectsValueUrl = getObjectsValueUrl(connection.apiBaseUrl);
    if (!objectsValueUrl) {
        throw new Error(`Cannot build /objects/value URL from '${connection.apiBaseUrl}'.`);
    }

    const module = await getRequiredProjectModule(sp, moduleName);

    const artifactResult = await createValueQueryArtifacts(
        sp,
        module.$ID,
        moduleName,
        objectType,
        { elementId: selectedElementId, displayName: selectedObject.displayName },
        connection,
        objectsValueUrl
    );

    const existingMicroflows = await sp.app.model.microflows.loadAll(
        unitInfo => unitInfo.moduleName === moduleName && unitInfo.name === microflowName,
        1
    );
    if (existingMicroflows.length > 0) {
        return {
            ...artifactResult,
            microflowName,
            microflowCreated: false,
            jsonFetchFailed: false,
        };
    }

    const microflow = await sp.app.model.microflows.addMicroflow(module.$ID, { name: microflowName });
    await populateMicroflowWithRestCall(sp, microflow, {
        url: objectsValueUrl,
        requestBody: buildValueQueryMicroflowRequestBody(selectedElementId),
        extraHeaders: [
            { key: 'Accept', value: `'application/json'` },
            { key: 'Content-Type', value: `'application/json'` },
        ],
        connection,
        importMappingId: artifactResult.importMappingId,
    });
    await sp.app.model.microflows.save(microflow);
    return {
        ...artifactResult,
        microflowName,
        microflowCreated: true,
        jsonFetchFailed: false,
    };
}

export interface HistoryMicroflowResult {
    microflowName: string;
    microflowCreated: boolean;
}

export async function createHistoryMicroflow(
    objectType: ObjectType,
    selectedObject: { elementId: string; displayName: string },
    connection: ConnectionConfig,
    moduleName = 'i3X_Connector'
): Promise<HistoryMicroflowResult> {
    const sp = getStudioPro();
    const selectedElementId = selectedObject.elementId.trim();

    if (!selectedElementId) {
        throw new Error('Selected object has no valid elementId.');
    }

    const historyUrl = getObjectsHistoryUrl(connection.apiBaseUrl);
    if (!historyUrl) {
        throw new Error(`Cannot build /objects/history URL from '${connection.apiBaseUrl}'.`);
    }

    const typeName = toModelName(objectType.displayName);
    const objectName = toModelName(selectedObject.displayName);
    const microflowName = `MF_${typeName}_${objectName}_History`;

    const module = await getRequiredProjectModule(sp, moduleName);

    const existing = await sp.app.model.microflows.loadAll(
        u => u.moduleName === moduleName && u.name === microflowName,
        1
    );
    if (existing.length > 0) {
        return { microflowName, microflowCreated: false };
    }

    const microflow = await sp.app.model.microflows.addMicroflow(module.$ID, { name: microflowName });

    await microflow.objectCollection.addMicroflowParameterObject({ name: 'StartTime', type: 'DateTime' });
    const startTimeParam = microflow.objectCollection.getMicroflowParameterObject('StartTime');
    if (startTimeParam) {
        startTimeParam.size = { width: 30, height: 30 };
        startTimeParam.relativeMiddlePoint = { x: 100, y: 0 };
    }

    await microflow.objectCollection.addMicroflowParameterObject({ name: 'EndTime', type: 'DateTime' });
    const endTimeParam = microflow.objectCollection.getMicroflowParameterObject('EndTime');
    if (endTimeParam) {
        endTimeParam.size = { width: 30, height: 30 };
        endTimeParam.relativeMiddlePoint = { x: 200, y: 0 };
    }

    const { text: bodyText, args: bodyArgs } = buildHistoryMicroflowRequestBody(selectedElementId);
    await populateMicroflowWithRestCall(sp, microflow, {
        url: historyUrl,
        requestBody: bodyText,
        requestBodyArgs: bodyArgs,
        extraHeaders: [
            { key: 'Accept', value: `'application/json'` },
            { key: 'Content-Type', value: `'application/json'` },
        ],
        connection,
    });
    await sp.app.model.microflows.save(microflow);
    return { microflowName, microflowCreated: true };
}

// Extract the first data[].value object from the raw /objects/value response JSON,
// giving us just the writable properties without quality/timestamp wrappers.
function extractFirstValuePayload(raw: unknown): unknown {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return {};
    for (const container of Object.values(raw as Record<string, unknown>)) {
        if (container !== null && typeof container === 'object' && !Array.isArray(container)) {
            const dataArray = (container as Record<string, unknown>).data;
            if (Array.isArray(dataArray) && dataArray.length > 0) {
                const firstItem = dataArray[0];
                if (firstItem !== null && typeof firstItem === 'object' && !Array.isArray(firstItem)) {
                    const valuePayload = (firstItem as Record<string, unknown>).value;
                    if (valuePayload !== null && typeof valuePayload === 'object' && !Array.isArray(valuePayload)) {
                        return valuePayload;
                    }
                }
            }
        }
    }
    return {};
}

function stringifyJsonWithDecimalIntegers(value: unknown): string {
    const decimalIntegerMarker = '__I3X_DECIMAL_INTEGER__';
    const json = JSON.stringify(
        value,
        (_key, currentValue) => {
            if (typeof currentValue === 'number' && Number.isFinite(currentValue) && Number.isInteger(currentValue)) {
                return `${decimalIntegerMarker}${currentValue.toFixed(1)}`;
            }

            return currentValue;
        },
        2
    );

    return json.replace(
        new RegExp(`"${decimalIntegerMarker}(-?(?:0|[1-9]\\d*)\\.0)"`, 'g'),
        '$1'
    );
}

function fixExportMappingElements(
    elements: Mappings.ObjectMappingElement[],
    parentEntityQualifiedName: string | null,
    moduleName: string
): void {
    for (const el of elements) {
        el.objectHandling = parentEntityQualifiedName === null ? 'Parameter' : 'Find';

        if (parentEntityQualifiedName !== null && el.entity) {
            const parentEntityName = parentEntityQualifiedName.split('.').pop() ?? '';
            const childEntityName = el.entity.split('.').pop() ?? '';
            el.association = `${moduleName}.${parentEntityName}_${childEntityName}`;
        } else {
            el.association = null;
        }

        fixExportMappingElements(
            el.children.filter((c): c is Mappings.ObjectMappingElement => 'children' in c),
            el.entity,
            moduleName
        );
    }
}

// Build the selection paths and MapObject list for an export mapping from a parsed
// JSON value object, deriving entity names from the same convention as the value-query flow.
function buildExportMappingEntries(
    value: unknown,
    path: string,
    entityName: string,
    moduleName: string
): { selectionPaths: string[]; mapObjects: { path: string; entityQualifiedName: string; valueMappings: Record<string, string> }[] } {
    const selectionPaths: string[] = [path];
    const mapObjects: { path: string; entityQualifiedName: string; valueMappings: Record<string, string> }[] = [];

    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        return { selectionPaths, mapObjects };
    }

    const obj = value as Record<string, unknown>;
    const valueMappings: Record<string, string> = {};

    for (const [key, childValue] of Object.entries(obj)) {
        selectionPaths.push(`${path}|${key}`);
        if (childValue !== null && typeof childValue === 'object' && !Array.isArray(childValue)) {
            const child = buildExportMappingEntries(
                childValue,
                `${path}|${key}`,
                `${entityName}_${toModelName(key)}`,
                moduleName
            );
            // Selection paths for child levels are added by the recursive call;
            // avoid duplicating the nested object path we already pushed above.
            selectionPaths.push(...child.selectionPaths.slice(1));
            mapObjects.push(...child.mapObjects);
        } else {
            valueMappings[key] = toModelName(key);
        }
    }

    mapObjects.unshift({ path, entityQualifiedName: `${moduleName}.${entityName}`, valueMappings });
    return { selectionPaths, mapObjects };
}

async function createOrUpdateExportMapping(
    sp: StudioProApi,
    moduleId: string,
    moduleName: string,
    mappingName: string,
    jsonStructureQualifiedName: string,
    parsedWriteValue: unknown,
    baseEntityName: string,
    entityVariableName: string
): Promise<{ created: boolean; mappingId: string }> {
    const existingMappings = await sp.app.model.exportMappings.getUnitsInfo();
    const existingInfo = existingMappings.find(
        u => u.moduleName === moduleName && u.name === mappingName
    );

    const { selectionPaths, mapObjects } = buildExportMappingEntries(
        parsedWriteValue, '(Object)', baseEntityName, moduleName
    );

    const mapping = existingInfo
        ? (await sp.app.model.exportMappings.loadAll(u => u.$ID === existingInfo.$ID))[0] ?? null
        : await sp.app.model.exportMappings.addExportMapping(moduleId, {
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
        throw new Error(`Export mapping '${mappingName}' could not be loaded.`);
    }

    mapping.parameterName = entityVariableName;
    await sp.app.model.exportMappings.clearElementMapping(mapping.$ID);
    await sp.app.model.exportMappings.setElementMapping(mapping.$ID, mapObjects);

    const hydratedMapping = (await sp.app.model.exportMappings.loadAll(u => u.$ID === mapping.$ID))[0] ?? mapping;
    hydratedMapping.parameterName = entityVariableName;
    fixExportMappingElements(hydratedMapping.rootMappingElements, null, moduleName);
    await sp.app.model.exportMappings.save(hydratedMapping);

    return { created: !existingInfo, mappingId: mapping.$ID };
}

export async function checkValueQueryEntitiesExist(
    objectType: ObjectType,
    selectedObject: { displayName: string },
    moduleName = 'i3X_Connector'
): Promise<boolean> {
    const sp = getStudioPro();
    const domainModel = await sp.app.model.domainModels.getDomainModel(moduleName);
    if (!domainModel) return false;
    const entityName = toModelName(`${objectType.displayName}_${selectedObject.displayName}`);
    return domainModel.getEntity(entityName) !== undefined;
}

export interface WriteMicroflowResult {
    microflowName: string;
    exportMappingName: string;
    microflowCreated: boolean;
    exportMappingCreated: boolean;
}

export async function createWriteMicroflow(
    objectType: ObjectType,
    selectedObject: { elementId: string; displayName: string },
    connection: ConnectionConfig,
    moduleName = 'i3X_Connector'
): Promise<WriteMicroflowResult> {
    const sp = getStudioPro();
    const selectedElementId = selectedObject.elementId.trim();

    if (!selectedElementId) {
        throw new Error('Selected object has no valid elementId.');
    }

    const writeUrl = getObjectWriteUrl(connection.apiBaseUrl, selectedElementId);
    if (!writeUrl) {
        throw new Error(`Cannot build write URL from '${connection.apiBaseUrl}'.`);
    }

    const typeName = toModelName(objectType.displayName);
    const objectName = toModelName(selectedObject.displayName);
    const baseEntityName = toModelName(`${objectType.displayName}_${selectedObject.displayName}`);
    const microflowName = `MF_${typeName}_${objectName}_Write`;
    const exportMappingName = `EM_${typeName}_${objectName}`;

    const module = await getRequiredProjectModule(sp, moduleName);

    // Verify the base entity exists — the write microflow reuses entities created
    // by the last-known-values flow and must never create its own.
    const domainModel = await sp.app.model.domainModels.getDomainModel(moduleName);
    if (!domainModel || !domainModel.getEntity(baseEntityName)) {
        throw new Error(
            `Entity '${baseEntityName}' not found in module '${moduleName}'. ` +
            `Run "Create last-known-value query microflow" first.`
        );
    }

    // Build a write-specific JSON structure from just the value properties of the
    // first data point — no quality/timestamp wrappers, no outer container key.
    const writeJsonStructureName = `JSON_Write_${baseEntityName}`;
    const rawStructures = await sp.app.model.jsonStructures.getUnitsInfo();
    const rawStructureInfo = rawStructures.find(
        u => u.moduleName === moduleName && u.name === `JSON_${baseEntityName}`
    );
    let parsedWriteValue: unknown = {};
    let writeSnippet = '{}';
    if (rawStructureInfo) {
        const loaded = await sp.app.model.jsonStructures.loadAll(u => u.$ID === rawStructureInfo.$ID);
        if (loaded.length > 0 && loaded[0].jsonSnippet) {
            try {
                parsedWriteValue = extractFirstValuePayload(JSON.parse(loaded[0].jsonSnippet));
                writeSnippet = stringifyJsonWithDecimalIntegers(parsedWriteValue);
            } catch {
                // keep defaults
            }
        }
    }
    await createOrUpdateJsonStructure(sp, module.$ID, moduleName, writeJsonStructureName, writeSnippet);

    const exportMappingResult = await createOrUpdateExportMapping(
        sp,
        module.$ID,
        moduleName,
        exportMappingName,
        `${moduleName}.${writeJsonStructureName}`,
        parsedWriteValue,
        baseEntityName,
        'InputObject'
    );

    const existing = await sp.app.model.microflows.loadAll(
        u => u.moduleName === moduleName && u.name === microflowName,
        1
    );
    if (existing.length > 0) {
        return { microflowName, exportMappingName, microflowCreated: false, exportMappingCreated: exportMappingResult.created };
    }

    const microflow = await sp.app.model.microflows.addMicroflow(module.$ID, { name: microflowName });

    const inputParam = await microflow.objectCollection.addMicroflowParameterObject({ name: 'InputObject', type: 'Object' });
    if (inputParam) {
        const objType = (await sp.app.model.microflows.createElement('DataTypes$ObjectType')) as DataTypes.ObjectType;
        objType.entity = `${moduleName}.${baseEntityName}`;
        inputParam.variableType = objType as typeof inputParam.variableType;
        inputParam.size = { width: 30, height: 30 };
        inputParam.relativeMiddlePoint = { x: 100, y: 0 };
    }

    await populateMicroflowWithRestCall(sp, microflow, {
        url: writeUrl,
        requestBody: '',
        exportMapping: {
            mappingQualifiedName: `${moduleName}.${exportMappingName}`,
            entityVariableName: 'InputObject',
        },
        extraHeaders: [
            { key: 'Accept', value: `'application/json'` },
            { key: 'Content-Type', value: `'application/json'` },
        ],
        connection,
    });
    await sp.app.model.microflows.save(microflow);

    return { microflowName, exportMappingName, microflowCreated: true, exportMappingCreated: exportMappingResult.created };
}

export async function implementObjectAsEntity(
    selectedObject: ObjectType,
    connection: ConnectionConfig,
    moduleName = 'i3X_Connector'
): Promise<ImplementEntityResult> {
    const sp = getStudioPro();
    const module = await getRequiredProjectModule(sp, moduleName);

    const domainModelResult = await buildDomainModelEntities(sp, selectedObject, moduleName);

    const jsonStructureName = `JSON_${domainModelResult.baseEntityName}`;
    const importMappingName = `IM_${domainModelResult.baseEntityName}`;
    const microflowName = `MF_${domainModelResult.baseEntityName}`;

    const objectTypeId = selectedObject.elementId.trim();
    const objectsUrl = objectTypeId ? getObjectsUrl(connection.apiBaseUrl, objectTypeId) : null;
    const { snippet: jsonSnippet, fetchFailed: jsonFetchFailed } = await buildObjectTypeJsonSnippet(sp, selectedObject, connection, objectsUrl);
    const jsonStructureResult = await createOrUpdateJsonStructure(
        sp,
        module.$ID,
        moduleName,
        jsonStructureName,
        jsonSnippet
    );
    const importMappingResult = await createOrUpdateImportMapping(
        sp,
        module.$ID,
        moduleName,
        importMappingName,
        `${moduleName}.${jsonStructureName}`
    );
    const microflowCreated = objectsUrl
        ? await ensureMicroflowForObject(
            sp,
            module.$ID,
            moduleName,
            microflowName,
            objectsUrl,
            connection,
            importMappingResult.mappingId
        )
        : false;

    return {
        ...domainModelResult,
        jsonStructureName,
        jsonStructureCreated: jsonStructureResult.created,
        importMappingName,
        importMappingCreated: importMappingResult.created,
        microflowName,
        microflowCreated,
        jsonFetchFailed,
    };
}
