import React, { useEffect, useMemo, useState } from 'react';
import { ComponentContext, getStudioProApi } from '@mendix/extensions-api';
import styles from '../index.module.css';
import { ObjectType, AnyProperty, ConnectionConfig, isGroupProperty, isArrayProperty, extractArrayItemProperties, shortNs } from '../types';
import { createQueryValuesMicroflow, createHistoryMicroflow, createWriteMicroflow, checkValueQueryEntitiesExist, summarizeArtifactResult, MENDIX_LONG_MAX } from '../services/studioProService';
import { getObjectsUrl, unwrapI3xResult } from '../services/i3xUrl';
import { buildI3xRequestHeaders } from '../services/auth';

interface Props {
    context: ComponentContext;
    connection: ConnectionConfig;
    item: ObjectType;
    allObjectTypes: ObjectType[];
    onClose: () => void;
    onNavigateToType: (type: ObjectType) => void;
}

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

type RefResolver = (ref: string) => ObjectType | null;

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

type ComponentTypeResolver = (name: string, prop: AnyProperty) => ObjectType | null;

// ─── Group section (collapsible, recursive) ───────────────────────────────────

const GroupSection: React.FC<{
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

    // Resolve $ref to an objecttype and render as a group
    if (!prop.type && '$ref' in prop) {
        const ref = (prop as Record<string, unknown>).$ref as string;
        const resolved = resolveRef(ref);
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

    if (isArrayProperty(prop)) {
        return <ArraySection name={name} prop={prop} isRequired={isRequired} depth={depth} resolveRef={resolveRef} />;
    }

    if (!isGroupProperty(prop)) {
        return <LeafRow name={name} prop={prop} required={isRequired} depth={depth} linkedType={resolveComponentType(name, prop)} onNavigate={onNavigate} />;
    }

    const childEntries = Object.entries(prop.properties ?? {});
    const groupRequired = prop.required ?? [];
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

function flattenObjectToColumns(
    value: unknown,
    prefix = '',
    out: Record<string, string> = {}
): Record<string, string> {
    if (value === null || value === undefined) {
        if (prefix) out[prefix] = '—';
        return out;
    }

    if (Array.isArray(value)) {
        if (prefix) out[prefix] = JSON.stringify(value);
        return out;
    }

    if (typeof value === 'object') {
        for (const [key, child] of Object.entries(value)) {
            const nextPrefix = prefix ? `${prefix}.${key}` : key;
            flattenObjectToColumns(child, nextPrefix, out);
        }
        return out;
    }

    if (prefix) {
        out[prefix] = String(value);
    }
    return out;
}

// ─── Main component ───────────────────────────────────────────────────────────

const DetailPanel: React.FC<Props> = ({ context, connection, item, allObjectTypes, onClose, onNavigateToType }) => {
    const studioPro = getStudioProApi(context);
    const [activeTab, setActiveTab] = useState<'attributes' | 'objects'>('attributes');
    const [isLoadingObjects, setIsLoadingObjects] = useState(true);
    const [isCreatingQuery, setIsCreatingQuery] = useState(false);
    const [isCreatingHistory, setIsCreatingHistory] = useState(false);
    const [isCreatingWrite, setIsCreatingWrite] = useState(false);
    const [writeEntitiesExist, setWriteEntitiesExist] = useState(false);
    const [retrievedObjects, setRetrievedObjects] = useState<unknown[]>([]);
    const [objectsLoadError, setObjectsLoadError] = useState<string | null>(null);
    const [selectedObjectIndex, setSelectedObjectIndex] = useState<number | null>(null);
    const schema = item.schema;
    const properties = schema.properties ?? {};
    const topRequired = schema.required ?? [];
    const entries = Object.entries(properties);

    const resolveRef: RefResolver = (ref: string) => {
        const name = extractRefName(ref);
        if (!name) return null;
        return allObjectTypes.find(t => t.elementId === name) ?? null;
    };

    const resolveComponentType: ComponentTypeResolver = (name: string, prop: AnyProperty): ObjectType | null => {
        const desc = (prop as Record<string, unknown>).description;
        if (typeof desc !== 'string' || !desc.toLowerCase().startsWith('composed child:')) return null;

        const related = item['related'] as { types?: string[] } | null | undefined;
        if (!related?.types?.length) return null;

        const relatedIds = related.types.map((uri: string) => {
            const colonIdx = uri.lastIndexOf(':');
            return colonIdx >= 0 ? uri.slice(colonIdx + 1) : uri;
        });

        const normalized = name.toLowerCase().replace(/[^a-z0-9]/g, '');
        const matchedId = relatedIds.find(id => id.toLowerCase().replace(/[^a-z0-9]/g, '').includes(normalized)) ?? relatedIds[0];
        return allObjectTypes.find(t => t.elementId === matchedId) ?? null;
    };

    const totalLeafs = entries.reduce((acc, [, prop]) => {
        if (isGroupProperty(prop)) return acc + Object.keys(prop.properties ?? {}).length;
        if (isArrayProperty(prop)) {
            const itemProps = extractArrayItemProperties(prop);
            return acc + (itemProps ? Object.keys(itemProps).length : 0);
        }
        return acc + 1;
    }, 0);

    const flattenedObjects = useMemo(
        () => retrievedObjects.map(obj => flattenObjectToColumns(obj)),
        [retrievedObjects]
    );
    const objectColumns = useMemo(
        () =>
            Array.from(new Set(flattenedObjects.flatMap(obj => Object.keys(obj))))
                .filter(column => {
                    const lastSegment = column.split('.').pop()?.toLowerCase() ?? '';
                    return lastSegment !== 'typeelementid' && lastSegment !== 'namespaceuri'
                        && lastSegment !== 'iscomposition' && lastSegment !== 'isextended';
                }),
        [flattenedObjects]
    );
    const isElementIdColumn = (column: string) =>
        (column.split('.').pop()?.toLowerCase() ?? '') === 'elementid';

    const selectedObjectSample = useMemo(() => {
        if (selectedObjectIndex === null) return null;

        const selected = retrievedObjects[selectedObjectIndex];
        if (!selected || typeof selected !== 'object') return null;

        const selectedRecord = selected as Record<string, unknown>;
        const elementIdEntry = Object.entries(selectedRecord).find(([key]) => key.toLowerCase() === 'elementid');
        const elementIdValue = elementIdEntry?.[1];

        if (typeof elementIdValue !== 'string' || !elementIdValue.trim()) {
            return null;
        }

        return { elementId: elementIdValue };
    }, [selectedObjectIndex, retrievedObjects]);

    useEffect(() => {
        let cancelled = false;

        const loadObjects = async () => {
            setIsLoadingObjects(true);
            setObjectsLoadError(null);
            setRetrievedObjects([]);
            setSelectedObjectIndex(null);

            const objectsUrl = getObjectsUrl(connection.apiBaseUrl, item.elementId);
            if (!objectsUrl) {
                if (!cancelled) {
                    setObjectsLoadError(`Cannot build objects URL from '${connection.apiBaseUrl}'.`);
                    setIsLoadingObjects(false);
                }
                return;
            }

            try {
                const proxy = await studioPro.network.httpProxy.getProxyUrl(objectsUrl);
                const response = await fetch(proxy, { headers: buildI3xRequestHeaders(connection.auth) });
                if (!response.ok) {
                    if (!cancelled) {
                        setObjectsLoadError(`Request failed with status ${response.status} for '${objectsUrl}'.`);
                    }
                    return;
                }

                const raw = await response.json();
                const unwrappedObjects = unwrapI3xResult<unknown[]>(raw);
                const objects = Array.isArray(unwrappedObjects)
                    ? unwrappedObjects
                    : [];
                if (!cancelled) {
                    setRetrievedObjects(objects);
                    setSelectedObjectIndex(objects.length > 0 ? 0 : null);
                }
            } catch (error) {
                if (!cancelled) {
                    setObjectsLoadError(error instanceof Error ? error.message : String(error));
                }
            } finally {
                if (!cancelled) {
                    setIsLoadingObjects(false);
                }
            }
        };

        setActiveTab('attributes');
        void loadObjects();

        return () => {
            cancelled = true;
        };
    }, [connection, item.elementId, studioPro.network.httpProxy]);

    useEffect(() => {
        let cancelled = false;

        setWriteEntitiesExist(false);
        checkValueQueryEntitiesExist(item)
            .then(exists => {
                if (!cancelled) {
                    setWriteEntitiesExist(exists);
                }
            })
            .catch((error: unknown) => {
                if (!cancelled) {
                    console.error('checkValueQueryEntitiesExist failed:', error instanceof Error ? error.message : String(error));
                    setWriteEntitiesExist(false);
                }
            });

        return () => {
            cancelled = true;
        };
    }, [item]);

    const handleCreateValueQuery = async () => {
        if (isCreatingQuery) return;

        if (!selectedObjectSample) {
            const confirmed = await studioPro.ui.messageBoxes.ask({
                type: 'confirmation',
                question: 'No objects were found for this type. The microflows can still be generated using the object type schema as a template, but the property types may not fully match what the server actually returns. Continue?',
            });
            if (!confirmed) return;
        }

        setIsCreatingQuery(true);
        try {
            const result = await createQueryValuesMicroflow(
                item,
                selectedObjectSample,
                connection
            );
            const { somethingCreated, summary } = summarizeArtifactResult(result);

            if (result.jsonFetchFailed) {
                await studioPro.ui.notifications.show({
                    title: 'Generated from schema — not from live data',
                    message: `No objects were available, so '${result.jsonStructureName}' was built from the object type schema. Property types may not exactly match what the server returns.`,
                    displayDurationInSeconds: 10,
                });
            }

            await studioPro.ui.notifications.show({
                title: somethingCreated ? 'Value query artifacts prepared' : 'Value query artifacts already exist',
                message: summary,
                displayDurationInSeconds: 6,
            });
            setWriteEntitiesExist(true);
        } catch (error) {
            const details = error instanceof Error ? error.message : String(error);
            await studioPro.ui.messageBoxes.show('error', 'Could not create value query microflow', details);
        } finally {
            setIsCreatingQuery(false);
        }
    };

    const handleCreateHistoryMicroflow = async () => {
        if (isCreatingHistory) return;

        setIsCreatingHistory(true);
        try {
            const result = await createHistoryMicroflow(item, connection);
            await studioPro.ui.notifications.show({
                title: result.microflowCreated ? 'History microflow created' : 'History microflow already exists',
                message: result.microflowCreated
                    ? `'${result.microflowName}' created. JSON: '${result.jsonStructureName}', Mapping: '${result.importMappingName}'.`
                    : `'${result.microflowName}' already exists. JSON: '${result.jsonStructureName}', Mapping: '${result.importMappingName}'.`,
                displayDurationInSeconds: 10,
            });
        } catch (error) {
            const details = error instanceof Error ? error.message : String(error);
            await studioPro.ui.messageBoxes.show('error', 'Could not create history microflow', details);
        } finally {
            setIsCreatingHistory(false);
        }
    };

    const handleCreateWriteMicroflow = async () => {
        if (!writeEntitiesExist || isCreatingWrite) return;

        setIsCreatingWrite(true);
        try {
            const result = await createWriteMicroflow(item, connection);
            await studioPro.ui.notifications.show({
                title: result.microflowCreated ? 'Write microflow created' : 'Write microflow already exists',
                message: result.microflowCreated
                    ? `'${result.microflowName}' created. Open it in Studio Pro and change the REST call HTTP method to PUT.`
                    : `'${result.microflowName}' already exists.`,
                displayDurationInSeconds: 10,
            });
            if (result.microflowCreated) {
                await studioPro.ui.editors.editDocument(result.microflowId);
                await studioPro.ui.messageBoxes.show(
                    'warning',
                    'Set writeback REST method to PUT',
                    `Open '${result.microflowName}' in Studio Pro and change the generated REST call HTTP method to PUT before using the microflow.`
                );
            }
        } catch (error) {
            const details = error instanceof Error ? error.message : String(error);
            await studioPro.ui.messageBoxes.show('error', 'Could not create write microflow', details);
        } finally {
            setIsCreatingWrite(false);
        }
    };

    const noObjects = !isLoadingObjects && retrievedObjects.length === 0;
    const btnClass = noObjects
        ? `${styles.actionButton} ${styles.actionButtonWarning}`
        : styles.actionButton;

    return (
        <div className={styles.detailPanel}>
            {/* Header */}
            <div className={styles.detailHeader}>
                <div>
                    <h2 className={styles.detailTitle}>{item.displayName}</h2>
                    <span className={styles.idCell}>{item.elementId}</span>
                </div>
                <div className={styles.detailHeaderActions}>
                    <span className={styles.detailHeaderActionsLabel}>Create for this ObjectType:</span>
                    <>
                        <button
                            className={btnClass}
                            onClick={handleCreateValueQuery}
                            disabled={isLoadingObjects || isCreatingQuery}
                        >
                            {isCreatingQuery ? 'Creating...' : 'Latest Values'}
                        </button>
                        <button
                            className={btnClass}
                            onClick={handleCreateHistoryMicroflow}
                            disabled={!writeEntitiesExist || isCreatingHistory}
                            title={!writeEntitiesExist ? 'Create Latest Values first.' : undefined}
                        >
                            {isCreatingHistory ? 'Creating...' : 'History'}
                        </button>
                        <button
                            className={btnClass}
                            onClick={handleCreateWriteMicroflow}
                            disabled={!writeEntitiesExist || isCreatingWrite}
                            title={!writeEntitiesExist ? 'Create Latest Values first.' : undefined}
                        >
                            {isCreatingWrite ? 'Creating...' : 'Writeback'}
                        </button>
                    </>
                    <button className={styles.closeButton} onClick={onClose} title="Close">✕</button>
                </div>
            </div>

            {!isLoadingObjects && (objectsLoadError ? (
                <p className={styles.noPropsMessage}>
                    Could not load objects for this type — microflows cannot be created without sample data.
                </p>
            ) : retrievedObjects.length === 0 ? (
                <p className={styles.noPropsMessage}>
                    No objects found for this type. Any microflows generated will be based on a synthetic template derived from the schema, and may not fully match what the server actually returns.
                </p>
            ) : null)}

            {/* Meta bar */}
            <div className={styles.detailMeta}>
                <div className={styles.metaItem}>
                    <span className={styles.metaLabel}>Namespace</span>
                    <span className={styles.nsBadge}>{shortNs(item.namespaceUri)}</span>
                </div>
                <div className={styles.metaItem}>
                    <span className={styles.metaLabel}>URI</span>
                    <span className={styles.metaValue}>{item.namespaceUri}</span>
                </div>
                {schema.type && (
                    <div className={styles.metaItem}>
                        <span className={styles.metaLabel}>Schema type</span>
                        <span className={styles.typeBadge}>{schema.type}</span>
                    </div>
                )}
                <div className={styles.metaItem}>
                    <span className={styles.metaLabel}>Groups</span>
                    <span className={styles.metaValue}>{entries.length}</span>
                </div>
                <div className={styles.metaItem}>
                    <span className={styles.metaLabel}>Total fields</span>
                    <span className={styles.metaValue}>{totalLeafs}</span>
                </div>
            </div>

            {schema.description && (
                <p className={styles.detailDescription}>{schema.description}</p>
            )}

            <div className={styles.detailTabs}>
                <button
                    className={`${styles.detailTabButton} ${activeTab === 'attributes' ? styles.detailTabButtonActive : ''}`}
                    onClick={() => setActiveTab('attributes')}
                >
                    Attributes
                </button>
                <button
                    className={`${styles.detailTabButton} ${activeTab === 'objects' ? styles.detailTabButtonActive : ''}`}
                    onClick={() => setActiveTab('objects')}
                >
                    Objects
                </button>
            </div>

            {/* Properties or retrieved objects */}
            {activeTab === 'objects' ? (
                <div className={styles.detailSection}>
                    {isLoadingObjects ? (
                        <p className={styles.noPropsMessage}>Loading objects...</p>
                    ) : objectsLoadError ? (
                        <p className={styles.noPropsMessage}>Could not load objects: {objectsLoadError}</p>
                    ) : retrievedObjects.length === 0 ? (
                        <p className={styles.noPropsMessage}>No objects returned for this type.</p>
                    ) : (
                        <>
                            <table className={styles.pipelineTable}>
                                <thead>
                                    <tr className={styles.tableHeader}>
                                        <th className={`${styles.tableHeaderCell} ${styles.rowNumberCell}`}>#</th>
                                        {objectColumns.map(column => (
                                            <th
                                                key={column}
                                                className={`${styles.tableHeaderCell} ${isElementIdColumn(column) ? styles.elementIdCell : ''}`}
                                            >
                                                {column}
                                            </th>
                                        ))}
                                    </tr>
                                </thead>
                                <tbody>
                                    {flattenedObjects.map((obj, index) => (
                                        <tr
                                            key={index}
                                            onClick={() => setSelectedObjectIndex(index)}
                                            className={`${styles.tableRow} ${selectedObjectIndex === index ? styles.selected : ''}`}
                                        >
                                            <td className={`${styles.tableCell} ${styles.rowNumberCell}`}>{index + 1}</td>
                                            {objectColumns.map(column => {
                                                const cellValue = obj[column] ?? '—';
                                                const valueText = String(cellValue);
                                                return (
                                                    <td
                                                        key={column}
                                                        className={`${styles.tableCell} ${styles.descCell} ${isElementIdColumn(column) ? styles.elementIdCell : ''}`}
                                                        title={valueText}
                                                    >
                                                        {valueText}
                                                    </td>
                                                );
                                            })}
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </>
                    )}
                </div>
            ) : entries.length > 0 ? (
                <div className={styles.detailSection}>
                    <table className={styles.propTable}>
                        <thead>
                            <tr className={styles.tableHeader}>
                                <th className={styles.tableHeaderCell} style={{ width: '32%' }}>Property</th>
                                <th className={styles.tableHeaderCell} style={{ width: '14%' }}>Type</th>
                                <th className={styles.tableHeaderCell} style={{ width: '14%' }}>Required</th>
                                <th className={styles.tableHeaderCell} style={{ width: '40%' }}>Details</th>
                            </tr>
                        </thead>
                        <tbody>
                            {entries.map(([name, prop]) => (
                                <GroupSection
                                    key={name}
                                    name={name}
                                    prop={prop}
                                    topRequired={topRequired}
                                    resolveRef={resolveRef}
                                    resolveComponentType={resolveComponentType}
                                    onNavigate={onNavigateToType}
                                />
                            ))}
                        </tbody>
                    </table>
                </div>
            ) : (
                <p className={styles.noPropsMessage}>
                    This type has no properties defined — it is a scalar or metadata-only type.
                </p>
            )}
        </div>
    );
};

export default DetailPanel;
