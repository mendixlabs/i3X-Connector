import type { DomainModels } from '@mendix/extensions-api';
import {
    extractArrayItemProperties,
    isArrayProperty,
    isGroupProperty,
    type AnyProperty,
    type LeafProperty,
} from '../types';

type MendixAttributeType = NonNullable<DomainModels.AttributeCreationOptions['type']>;

export const MENDIX_LONG_MAX = Number('9223372036854775807');

const RESERVED_MODEL_NAMES = new Set([
    '_', 'abstract', 'assert', 'boolean', 'break', 'byte', 'case', 'catch', 'changedby', 'changeddate',
    'char', 'class', 'com', 'con', 'const', 'context', 'continue', 'createddate', 'currentuser', 'default',
    'do', 'double', 'else', 'empty', 'enum', 'extends', 'false', 'final', 'finally', 'float', 'for', 'goto',
    'guid', 'id', 'if', 'implements', 'import', 'instanceof', 'int', 'interface', 'long', 'mendixobject',
    'native', 'new', 'null', 'object', 'owner', 'package', 'private', 'protected', 'public', 'return',
    'short', 'static', 'strictfp', 'submetaobjectname', 'super', 'switch', 'synchronized', 'this', 'throw',
    'throws', 'transient', 'true', 'try', 'type', 'void', 'volatile', 'while',
]);

export function toModelName(raw: string): string {
    const compact = raw.trim().replace(/[^A-Za-z0-9_]/g, '_').replace(/_+/g, '_');
    const startsWithLetter = /^[A-Za-z]/.test(compact) ? compact : `N_${compact}`;
    const name = startsWithLetter || 'Unnamed';
    return RESERVED_MODEL_NAMES.has(name.toLowerCase()) ? `${name}_` : name;
}

function primaryType(type: unknown): string | undefined {
    if (Array.isArray(type)) return (type as string[]).find(value => value !== 'null');
    return typeof type === 'string' ? type : undefined;
}

export function getAttributeType(property: LeafProperty): MendixAttributeType {
    const propertyType = primaryType(property.type);

    if (propertyType === 'string') {
        return property.format === 'date-time' || property.format === 'date' ? 'DateTime' : 'String';
    }
    if (propertyType === 'boolean') return 'Boolean';
    if (propertyType === 'integer') {
        return property.format === 'int64' || property.format === 'long' ? 'Long' : 'Integer';
    }
    if (propertyType === 'number') return 'Decimal';
    return 'String';
}

export function getChildPropertiesIfAny(property: AnyProperty): Record<string, AnyProperty> | null {
    if (isGroupProperty(property)) {
        return property.properties as Record<string, AnyProperty>;
    }
    if (isArrayProperty(property)) {
        return extractArrayItemProperties(property) as Record<string, AnyProperty> | null;
    }
    return null;
}

export function countDirectLeafProperties(properties: Record<string, AnyProperty>): number {
    return Object.values(properties).filter(property => getChildPropertiesIfAny(property) === null).length;
}
