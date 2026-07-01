import React, { useState } from 'react';
import styles from '../index.module.css';
import {
    ObjectType,
    AnyProperty,
    GroupProperty,
    ArrayProperty,
    isGroupProperty,
    isArrayProperty,
    extractArrayItemProperties,
} from '../types';
import { MENDIX_LONG_MAX } from '../services/studioProService';

// ─── Constraint pills ─────────────────────────────────────────────────────────

function formatConstraint(key: string, value: unknown): string | null {
    if (typeof value !== 'number' && typeof value !== 'string' && typeof value !== 'boolean') return null;
    if (typeof value === 'number') {
        if (Math.abs(value) >= Number.MAX_VALUE * 0.999 || Math.abs(value) >= MENDIX_LONG_MAX * 0.999) return null;
    }
    const labels: Record<string, string> = {
        minimum: 'min', maximum: 'max', maxLength: 'maxLen',
        default: 'default', format: 'format',
    };
    const label = labels[key] ?? key;
    return `${label}: ${value}`;
}

const ConstraintPills: React.FC<{ prop: AnyProperty }> = ({ prop }) => {
    const constraintKeys = ['minimum', 'maximum', 'maxLength', 'default', 'format'];
    const pills = constraintKeys
        .map(k => formatConstraint(k, (prop as Record<string, unknown>)[k]))
        .filter((v): v is string => v !== null);

    if (pills.length === 0) return null;
    return (
        <span className={styles.constraintList}>
            {pills.map(p => <span key={p} className={styles.constraintPill}>{p}</span>)}
        </span>
    );
};

// ─── Type badge ───────────────────────────────────────────────────────────────

const TypeBadge: React.FC<{ prop: AnyProperty }> = ({ prop }) => {
    if (!prop.type) return <span className={styles.unknownBadge}>unknown</span>;
    if (prop.type === 'array') return <span className={styles.arrayBadge}>array</span>;
    return <span className={styles.typeBadge}>{prop.type}</span>;
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function extractRefName(ref: string): string | null {
    const match = ref.match(/#\/\$defs\/(.+)/);
    return match?.[1] ?? null;
}

export type RefResolver = (ref: string) => ObjectType | null;
export type ComponentTypeResolver = (name: string, prop: AnyProperty) => ObjectType | null;

// Classifies a schema property into the four shapes GroupSection renders differently.
// Carrying the narrowed prop alongside the tag keeps each branch below type-safe without
// re-running the isGroupProperty/isArrayProperty checks.
type PropertyClassification =
    | { kind: 'ref'; ref: string }
    | { kind: 'array'; prop: ArrayProperty }
    | { kind: 'group'; prop: GroupProperty }
    | { kind: 'leaf' };

function classifyProperty(prop: AnyProperty): PropertyClassification {
    if (!prop.type && '$ref' in prop) {
        return { kind: 'ref', ref: (prop as Record<string, unknown>).$ref as string };
    }
    if (isArrayProperty(prop)) return { kind: 'array', prop };
    if (isGroupProperty(prop)) return { kind: 'group', prop };
    return { kind: 'leaf' };
}

// ─── Leaf property row ────────────────────────────────────────────────────────

const LeafRow: React.FC<{
    name: string;
    prop: AnyProperty;
    required: boolean;
    depth?: number;
    linkedType?: ObjectType | null;
    onNavigate?: (type: ObjectType) => void;
}> = ({ name, prop, required, depth = 0, linkedType, onNavigate }) => (
    <tr className={styles.propRow}>
        <td className={styles.propNameCell}>
            {Array.from({ length: depth }, (_, i) => <span key={i} className={styles.indent} />)}
            <span className={styles.propName}>{name}</span>
        </td>
        <td className={styles.tableCell}>
            {linkedType
                ? <span className={styles.componentBadge}>component</span>
                : <TypeBadge prop={prop} />}
        </td>
        <td className={styles.tableCell}>
            {required
                ? <span className={styles.requiredBadge}>required</span>
                : <span className={styles.textFaint}>optional</span>}
        </td>
        <td className={styles.tableCell}>
            {linkedType
                ? (onNavigate
                    ? <button className={styles.componentLink} onClick={() => onNavigate(linkedType)}>{linkedType.displayName}</button>
                    : <span className={styles.componentBadge}>{linkedType.displayName}</span>)
                : <ConstraintPills prop={prop} />}
        </td>
    </tr>
);

// ─── Array section (collapsible) ─────────────────────────────────────────────

const ArraySection: React.FC<{ name: string; prop: AnyProperty; isRequired: boolean; depth?: number; resolveRef: RefResolver }> = ({ name, prop, isRequired, depth = 0, resolveRef }) => {
    const [open, setOpen] = useState(true);

    if (!isArrayProperty(prop)) return null;

    let itemProps = extractArrayItemProperties(prop);

    const rawItems = (prop as unknown as Record<string, unknown>).items as Record<string, unknown> | undefined;

    // Fall back to resolving the first $ref entry in anyOf
    if (!itemProps && rawItems && Array.isArray(rawItems.anyOf)) {
        for (const candidate of rawItems.anyOf as unknown[]) {
            const c = candidate as Record<string, unknown>;
            if (typeof c.$ref === 'string') {
                const resolved = resolveRef(c.$ref);
                if (resolved?.schema.properties) {
                    itemProps = resolved.schema.properties as Record<string, AnyProperty>;
                    break;
                }
            }
        }
    }

    // Detect scalar item type (e.g. array of strings) for display when there are no object fields
    let scalarItemType: string | null = null;
    if (!itemProps && rawItems) {
        const directType = typeof rawItems.type === 'string' ? rawItems.type : null;
        if (directType && directType !== 'object' && directType !== 'array') {
            scalarItemType = directType;
        } else if (Array.isArray(rawItems.anyOf)) {
            for (const candidate of rawItems.anyOf as unknown[]) {
                const c = candidate as Record<string, unknown>;
                if (typeof c.type === 'string' && c.type !== 'object' && c.type !== 'array') {
                    scalarItemType = c.type;
                    break;
                }
            }
        }
    }

    const indentSpans = Array.from({ length: depth }, (_, i) => <span key={i} className={styles.indent} />);

    return (
        <>
            <tr
                className={`${styles.propRow} ${styles.groupRow}`}
                onClick={() => setOpen(o => !o)}
            >
                <td className={styles.propNameCell} colSpan={4}>
                    {indentSpans}
                    <span className={styles.groupChevron}>{open ? '▾' : '▸'}</span>
                    <span className={styles.groupName}>{name}</span>
                    <span className={styles.arrayBadge} style={{ marginLeft: 6 }}>array</span>
                    {itemProps
                        ? <span className={styles.groupCount}>{Object.keys(itemProps).length} fields → entity</span>
                        : scalarItemType
                            ? <span className={styles.groupCount}>items: {scalarItemType}</span>
                            : <span className={styles.groupCount}>no resolvable item schema</span>}
                    {isRequired && <span className={`${styles.requiredBadge} ${styles.groupRequiredBadge}`}>required</span>}
                </td>
            </tr>
            {open && scalarItemType && !itemProps && (
                <tr className={`${styles.propRow} ${styles.propRowNested}`}>
                    <td className={styles.propNameCell}>
                        {Array.from({ length: depth + 1 }, (_, i) => <span key={i} className={styles.indent} />)}
                        <span className={styles.propName}>(items)</span>
                    </td>
                    <td className={styles.tableCell}><span className={styles.typeBadge}>{scalarItemType}</span></td>
                    <td className={styles.tableCell}><span className={styles.textFaint}>optional</span></td>
                    <td className={styles.tableCell} />
                </tr>
            )}
            {open && itemProps && Object.entries(itemProps).map(([leafName, leafProp]) => (
                <tr key={leafName} className={`${styles.propRow} ${styles.propRowNested}`}>
                    <td className={styles.propNameCell}>
                        {Array.from({ length: depth + 1 }, (_, i) => <span key={i} className={styles.indent} />)}
                        <span className={styles.propName}>{leafName}</span>
                    </td>
                    <td className={styles.tableCell}><TypeBadge prop={leafProp} /></td>
                    <td className={styles.tableCell}><span className={styles.textFaint}>optional</span></td>
                    <td className={styles.tableCell}><ConstraintPills prop={leafProp} /></td>
                </tr>
            ))}
        </>
    );
};

// ─── Group section (collapsible, recursive) ───────────────────────────────────

export const GroupSection: React.FC<{
    name: string;
    prop: AnyProperty;
    topRequired: string[];
    depth?: number;
    resolveRef: RefResolver;
    resolveComponentType: ComponentTypeResolver;
    onNavigate: (type: ObjectType) => void;
}> = ({ name, prop, topRequired, depth = 0, resolveRef, resolveComponentType, onNavigate }) => {
    const [open, setOpen] = useState(true);
    const isRequired = topRequired.includes(name);
    const classification = classifyProperty(prop);

    if (classification.kind === 'ref') {
        const resolved = resolveRef(classification.ref);
        if (resolved) {
            const resolvedProp: AnyProperty = {
                type: 'object',
                properties: (resolved.schema.properties ?? {}) as Record<string, AnyProperty>,
                required: resolved.schema.required,
            };
            return <GroupSection name={name} prop={resolvedProp} topRequired={topRequired} depth={depth} resolveRef={resolveRef} resolveComponentType={resolveComponentType} onNavigate={onNavigate} />;
        }
        return <LeafRow name={name} prop={prop} required={isRequired} depth={depth} linkedType={resolveComponentType(name, prop)} onNavigate={onNavigate} />;
    }

    if (classification.kind === 'array') {
        return <ArraySection name={name} prop={classification.prop} isRequired={isRequired} depth={depth} resolveRef={resolveRef} />;
    }

    if (classification.kind === 'leaf') {
        return <LeafRow name={name} prop={prop} required={isRequired} depth={depth} linkedType={resolveComponentType(name, prop)} onNavigate={onNavigate} />;
    }

    const childEntries = Object.entries(classification.prop.properties ?? {});
    const groupRequired = classification.prop.required ?? [];
    const indentSpans = Array.from({ length: depth }, (_, i) => <span key={i} className={styles.indent} />);

    return (
        <>
            <tr
                className={`${styles.propRow} ${styles.groupRow}`}
                onClick={() => setOpen(o => !o)}
            >
                <td className={styles.propNameCell} colSpan={4}>
                    {indentSpans}
                    <span className={styles.groupChevron}>{open ? '▾' : '▸'}</span>
                    <span className={styles.groupName}>{name}</span>
                    <span className={styles.groupCount}>{childEntries.length} fields</span>
                    {isRequired && <span className={`${styles.requiredBadge} ${styles.groupRequiredBadge}`}>required</span>}
                </td>
            </tr>
            {open && childEntries.map(([childName, childProp]) => (
                <GroupSection
                    key={childName}
                    name={childName}
                    prop={childProp}
                    topRequired={groupRequired}
                    depth={depth + 1}
                    resolveRef={resolveRef}
                    resolveComponentType={resolveComponentType}
                    onNavigate={onNavigate}
                />
            ))}
        </>
    );
};
