import {
    isGroupProperty,
    type AnyProperty,
    type ObjectType,
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


/**
 * Unwrap the i3X v1 /objects/value response so entities are inferred from the value
 * payload while the caller can still keep the raw response text for JSON Structure creation.
 *
 * Response shape: { success, results: [{ elementId, success, result: { isComposition, value, quality, timestamp } }] }
 */
export function extractValueQueryPayload(sample: unknown): unknown {
    const normalizedSample = normalizeSampleForMapping(sample);
    const results = (normalizedSample as Record<string, unknown>).results;

    if (!Array.isArray(results)) return normalizedSample;

    const valuePayloads = results
        .map(item => {
            if (item === null || typeof item !== 'object' || Array.isArray(item)) return null;
            const result = (item as Record<string, unknown>).result;
            if (result === null || typeof result !== 'object' || Array.isArray(result)) return null;
            return (result as Record<string, unknown>).value ?? null;
        })
        .filter((v): v is Record<string, unknown> =>
            v !== null && typeof v === 'object' && !Array.isArray(v)
        );

    return mergeObjectSamples(valuePayloads) ?? normalizedSample;
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