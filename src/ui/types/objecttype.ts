export interface LeafProperty {
    type?: string;
    format?: string;
    minimum?: number;
    maximum?: number;
    default?: unknown;
    maxLength?: number;
    [key: string]: unknown;
}

export interface GroupProperty {
    type: 'object';
    properties: Record<string, AnyProperty>;
    required?: string[];
    additionalProperties?: boolean;
    $defs?: Record<string, unknown>;
}

export interface ArrayProperty {
    type: 'array';
    items: unknown;
}

export type AnyProperty = LeafProperty | GroupProperty | ArrayProperty;

export interface ObjectTypeSchema {
    type: string;
    description?: string;
    properties?: Record<string, AnyProperty>;
    required?: string[];
    additionalProperties?: boolean;
    [key: string]: unknown;
}

export interface ObjectType {
    elementId: string;
    displayName: string;
    namespaceUri: string;
    schema: ObjectTypeSchema;
    [key: string]: unknown;
}

export function isGroupProperty(p: AnyProperty): p is GroupProperty {
    return p.type === 'object' && 'properties' in p && typeof p.properties === 'object';
}

export function isArrayProperty(p: AnyProperty): p is ArrayProperty {
    return p.type === 'array';
}

/**
 * Given an array property, extract the leaf properties from its items schema.
 * Handles the anyOf pattern where the first entry is the actual object schema,
 * e.g. items: { anyOf: [{ type: 'object', properties: {...} }, ...] }
 * Returns null if no usable object schema can be found in the items.
 */
export function extractArrayItemProperties(
    prop: ArrayProperty
): Record<string, AnyProperty> | null {
    const items = prop.items as Record<string, unknown> | undefined;
    if (!items) return null;

    // Direct object: items: { type: 'object', properties: {...} }
    if (items.type === 'object' && items.properties && typeof items.properties === 'object') {
        return items.properties as Record<string, AnyProperty>;
    }

    // anyOf: items: { anyOf: [...] } — take the first entry that is a plain object schema
    if (Array.isArray(items.anyOf)) {
        for (const candidate of items.anyOf as unknown[]) {
            const c = candidate as Record<string, unknown>;
            if (c.type === 'object' && c.properties && typeof c.properties === 'object') {
                return c.properties as Record<string, AnyProperty>;
            }
        }
    }

    return null;
}

export function shortNs(uri: string): string {
    return uri.split('/').filter(Boolean).pop() ?? uri;
}

export function isObjectTypeArray(value: unknown): value is ObjectType[] {
    return (
        Array.isArray(value) &&
        value.every(
            (item) =>
                typeof item === 'object' &&
                item !== null &&
                'elementId' in item &&
                'displayName' in item &&
                'namespaceUri' in item
        )
    );
}
