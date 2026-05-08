import {
    isArrayProperty,
    isGroupProperty,
    type AnyProperty,
    type LeafProperty,
    type ObjectType,
    type ObjectTypeSchema,
} from '../types';

function mergeObjectSamples(items: unknown[]): Record<string, unknown> | null {
    const merged: Record<string, unknown> = {};
    let hasObject = false;

    for (const item of items) {
        if (item === null || typeof item !== 'object' || Array.isArray(item)) {
            continue;
        }

        hasObject = true;
        for (const [key, value] of Object.entries(item)) {
            if (!(key in merged) || merged[key] == null) {
                merged[key] = value;
            }
        }
    }

    return hasObject ? merged : null;
}

function getRepresentativeArrayItem(items: unknown[]): unknown {
    const mergedObject = mergeObjectSamples(items);
    if (mergedObject) {
        return mergedObject;
    }

    for (const item of items) {
        if (item !== null && item !== undefined) {
            return item;
        }
    }

    return '';
}

function inferPropertyFromSample(value: unknown): AnyProperty {
    if (Array.isArray(value)) {
        const itemSample = getRepresentativeArrayItem(value);
        return {
            type: 'array',
            items: itemSample !== null && typeof itemSample === 'object' && !Array.isArray(itemSample)
                ? {
                    type: 'object',
                    properties: Object.fromEntries(
                        Object.entries(itemSample).map(([key, childValue]) => [key, inferPropertyFromSample(childValue)])
                    ),
                }
                : inferPropertyFromSample(itemSample),
        };
    }

    if (value !== null && typeof value === 'object') {
        return {
            type: 'object',
            properties: Object.fromEntries(
                Object.entries(value).map(([key, childValue]) => [key, inferPropertyFromSample(childValue)])
            ),
        };
    }

    if (typeof value === 'boolean') {
        return { type: 'boolean' };
    }

    if (typeof value === 'number') {
        return { type: 'number' };
    }

    return { type: 'string' };
}

function normalizeSampleForMapping(sample: unknown): Record<string, unknown> {
    if (sample !== null && typeof sample === 'object' && !Array.isArray(sample)) {
        return sample as Record<string, unknown>;
    }

    if (Array.isArray(sample)) {
        const representativeItem = getRepresentativeArrayItem(sample);
        if (
            representativeItem !== null &&
            typeof representativeItem === 'object' &&
            !Array.isArray(representativeItem)
        ) {
            return representativeItem as Record<string, unknown>;
        }

        return { value: representativeItem };
    }

    return { value: sample };
}

function normalizeValueQueryResultPayload(item: unknown): Record<string, unknown> | null {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) {
        return null;
    }

    const result = (item as Record<string, unknown>).result;
    if (result === null || typeof result !== 'object' || Array.isArray(result)) {
        return null;
    }

    const resultObject = result as Record<string, unknown>;
    const value = resultObject.value ?? null;

    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
        return normalizeSampleForMapping(value);
    }

    return normalizeSampleForMapping({
        value,
        quality: resultObject.quality ?? null,
        timestamp: resultObject.timestamp ?? null,
    });
}


/**
 * Unwrap the i3X v1 /objects/value response so entities are inferred from the live
 * payload shape while the caller can still keep the raw response text for JSON Structure creation.
 *
 * Response shape: { success, results: [{ elementId, success, result: { isComposition, value, quality, timestamp } }] }
 */
export function extractValueQueryPayload(sample: unknown): unknown {
    const normalizedSample = normalizeSampleForMapping(sample);
    const results = (normalizedSample as Record<string, unknown>).results;

    if (!Array.isArray(results)) return normalizedSample;

    const valuePayloads = results
        .map(normalizeValueQueryResultPayload)
        .filter((v): v is Record<string, unknown> => v !== null);

    return mergeObjectSamples(valuePayloads) ?? normalizedSample;
}

function primaryType(type: unknown): string | undefined {
    if (Array.isArray(type)) return (type as string[]).find(t => t !== 'null');
    return typeof type === 'string' ? type : undefined;
}

function buildDummyPropertyValue(prop: AnyProperty, defs: Record<string, unknown>): unknown {
    if ('$ref' in prop && typeof (prop as LeafProperty).$ref === 'string') {
        const key = ((prop as LeafProperty).$ref as string).replace('#/$defs/', '');
        const resolved = defs[key];
        if (resolved && typeof resolved === 'object' && 'properties' in (resolved as object))
            return buildDummyValueFromSchema(resolved as ObjectTypeSchema, defs);
        return {};
    }
    if (isArrayProperty(prop)) return [];
    if (isGroupProperty(prop)) return buildDummyValueFromSchema(prop as unknown as ObjectTypeSchema, defs);
    const leaf = prop as LeafProperty;
    const pType = primaryType(leaf.type);
    if (pType === 'boolean') return false;
    if (pType === 'integer' || pType === 'number') return 0;
    if (pType === 'string')
        return (leaf.format === 'date-time' || leaf.format === 'date') ? '2000-01-01T00:00:00Z' : '';
    return null;
}

function buildDummyValueFromSchema(schema: ObjectTypeSchema, defs: Record<string, unknown>): Record<string, unknown> {
    return Object.fromEntries(
        Object.entries(schema.properties ?? {}).map(([name, prop]) => [
            name,
            buildDummyPropertyValue(prop as AnyProperty, defs),
        ])
    );
}

/**
 * Build a { rawText, parsed } response mimicking a real /objects/value call,
 * using schema-derived dummy values. Used when no object instances exist for a type.
 */
export function buildSyntheticValueResponse(objectType: ObjectType): { rawText: string; parsed: unknown } {
    const defs = (objectType.schema.$defs ?? {}) as Record<string, unknown>;
    const dummyValue = buildDummyValueFromSchema(objectType.schema, defs);
    const parsed = {
        success: true,
        results: [{
            elementId: objectType.elementId || 'synthetic',
            success: true,
            result: { isComposition: false, value: dummyValue, quality: 'Good', timestamp: new Date().toISOString() },
        }],
    };
    return { rawText: JSON.stringify(parsed), parsed };
}

export function buildObjectTypeFromSample(displayName: string, sample: unknown): ObjectType {
    const normalizedSample = normalizeSampleForMapping(sample);
    const rootProperty = inferPropertyFromSample(normalizedSample);

    return {
        elementId: '',
        displayName,
        namespaceUri: '',
        schema: {
            type: 'object',
            properties: isGroupProperty(rootProperty) ? rootProperty.properties : { value: rootProperty },
        },
    };
}