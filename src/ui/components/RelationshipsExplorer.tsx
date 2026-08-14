import React, { useEffect, useMemo, useState } from 'react';
import { ComponentContext, getStudioProApi } from '@mendix/extensions-api';
import styles from '../index.module.css';
import type { ConnectionConfig, ObjectType } from '../types';
import { buildI3xRequestHeaders } from '../services/auth';
import { getRelatedObjectsUrl } from '../services/i3xUrl';
import {
    checkRelationshipArtifactsExist,
    checkValueQueryEntitiesExist,
    createRelationshipArtifacts,
} from '../services/studioProService';

interface Props {
    context: ComponentContext;
    connection: ConnectionConfig;
    item: ObjectType;
    sourceElementId: string | null;
    allObjectTypes: ObjectType[];
    onNavigateToType: (item: ObjectType) => void;
}

interface RelatedObject {
    elementId: string;
    displayName: string;
    typeElementId: string;
}

interface RelationshipNode {
    id: string;
    relationship: string;
    direction: 'Outgoing';
    object: RelatedObject;
    targetType: ObjectType | null;
    targetImplemented: boolean;
    relationshipImplemented: boolean;
}

function parseRelationships(raw: unknown): Array<{ relationship: string; object: RelatedObject }> {
    if (!raw || typeof raw !== 'object' || !Array.isArray((raw as { results?: unknown }).results)) {
        throw new Error('Expected i3X bulk response with a results array.');
    }
    const parsed: Array<{ relationship: string; object: RelatedObject }> = [];
    for (const bulkItem of (raw as { results: unknown[] }).results) {
        if (!bulkItem || typeof bulkItem !== 'object') continue;
        const relatedItems = (bulkItem as { result?: unknown }).result;
        if (!Array.isArray(relatedItems)) continue;
        for (const relatedItem of relatedItems) {
            if (!relatedItem || typeof relatedItem !== 'object') continue;
            const record = relatedItem as { sourceRelationship?: unknown; object?: unknown };
            if (typeof record.sourceRelationship !== 'string' || !record.object || typeof record.object !== 'object') continue;
            const object = record.object as Partial<RelatedObject>;
            if (typeof object.elementId !== 'string' || typeof object.displayName !== 'string' || typeof object.typeElementId !== 'string') continue;
            parsed.push({ relationship: record.sourceRelationship, object: object as RelatedObject });
        }
    }
    return parsed;
}

function relationshipArtifactKey(node: RelationshipNode): string {
    return `${node.relationship}\u0000${node.targetType?.elementId ?? node.object.typeElementId}`;
}

const RelationshipsExplorer: React.FC<Props> = ({ context, connection, item, sourceElementId, allObjectTypes, onNavigateToType }) => {
    const studioPro = getStudioProApi(context);
    const [nodes, setNodes] = useState<RelationshipNode[]>([]);
    const [selectedId, setSelectedId] = useState<string | null>(null);
    const [checkedIds, setCheckedIds] = useState<Set<string>>(new Set());
    const [isLoading, setIsLoading] = useState(false);
    const [isGenerating, setIsGenerating] = useState(false);
    const [loadError, setLoadError] = useState<string | null>(null);

    useEffect(() => {
        let cancelled = false;
        const load = async () => {
            setNodes([]);
            setSelectedId(null);
            setCheckedIds(new Set());
            setLoadError(null);
            if (!sourceElementId) return;
            const url = getRelatedObjectsUrl(connection.apiBaseUrl);
            if (!url) {
                setLoadError(`Cannot build related objects URL from '${connection.apiBaseUrl}'.`);
                return;
            }
            setIsLoading(true);
            try {
                const proxy = await studioPro.network.httpProxy.getProxyUrl(url);
                const response = await fetch(proxy, {
                    method: 'POST',
                    headers: { ...buildI3xRequestHeaders(connection.auth), 'Content-Type': 'application/json' },
                    body: JSON.stringify({ elementIds: [sourceElementId], includeMetadata: false }),
                });
                if (response.status === 401) {
                    throw new Error('You do not have access to relationships for this connection.');
                }
                if (response.status === 404) {
                    if (!cancelled) setNodes([]);
                    return;
                }
                if (!response.ok) throw new Error(`The i3X service returned status ${response.status}.`);
                const relationships = parseRelationships(await response.json());
                const loadedNodes = await Promise.all(relationships.map(async ({ relationship, object }, index) => {
                    const targetType = allObjectTypes.find(type => type.elementId === object.typeElementId) ?? null;
                    const targetImplemented = targetType ? await checkValueQueryEntitiesExist(targetType) : false;
                    const relationshipImplemented = targetType
                        ? await checkRelationshipArtifactsExist(item, targetType, relationship)
                        : false;
                    return {
                        id: `${relationship}-${object.elementId}-${index}`,
                        relationship,
                        direction: 'Outgoing' as const,
                        object,
                        targetType,
                        targetImplemented,
                        relationshipImplemented,
                    };
                }));
                if (!cancelled) {
                    setNodes(loadedNodes);
                    setSelectedId(loadedNodes[0]?.id ?? null);
                    setCheckedIds(new Set(loadedNodes.filter(node => node.targetType && !node.relationshipImplemented).map(node => node.id)));
                }
            } catch (error) {
                if (!cancelled) setLoadError(error instanceof Error ? error.message : String(error));
            } finally {
                if (!cancelled) setIsLoading(false);
            }
        };
        void load();
        return () => { cancelled = true; };
    }, [allObjectTypes, connection, sourceElementId, studioPro.network.httpProxy]);

    const selected = useMemo(() => nodes.find(node => node.id === selectedId) ?? null, [nodes, selectedId]);
    const toggleChecked = (id: string) => setCheckedIds(current => {
        const next = new Set(current);
        if (next.has(id)) next.delete(id); else next.add(id);
        return next;
    });

    const generateNodes = async (nodesToGenerate: RelationshipNode[]) => {
        if (isGenerating || !sourceElementId || nodesToGenerate.length === 0) return;
        const uniqueNodes = [...new Map(
            nodesToGenerate
                .filter(node => node.targetType)
                .map(node => [relationshipArtifactKey(node), node])
        ).values()];
        if (uniqueNodes.length === 0) return;
        setIsGenerating(true);
        try {
            for (const node of uniqueNodes) {
                if (!node.targetType) continue;
                await createRelationshipArtifacts(
                    item,
                    node.targetType,
                    node.relationship,
                    sourceElementId,
                    node.object,
                    connection
                );
            }
            const generatedKeys = new Set(uniqueNodes.map(relationshipArtifactKey));
            setNodes(current => current.map(node => generatedKeys.has(relationshipArtifactKey(node))
                ? { ...node, targetImplemented: true, relationshipImplemented: true }
                : node));
            setCheckedIds(current => new Set([...current].filter(id => {
                const node = nodes.find(candidate => candidate.id === id);
                return node ? !generatedKeys.has(relationshipArtifactKey(node)) : false;
            })));
            await studioPro.ui.notifications.show({
                title: uniqueNodes.length === 1 ? 'Relationship generated' : 'Relationships generated',
                message: `${uniqueNodes.length} relationship${uniqueNodes.length === 1 ? '' : 's'} prepared in ${item.displayName}.`,
                displayDurationInSeconds: 6,
            });
        } catch (error) {
            await studioPro.ui.messageBoxes.show(
                'error',
                'Could not generate relationship',
                error instanceof Error ? error.message : String(error)
            );
        } finally {
            setIsGenerating(false);
        }
    };

    const checkedNodes = nodes.filter(node => checkedIds.has(node.id) && node.targetType && !node.relationshipImplemented);

    return (
        <div className={styles.relationshipExplorer}>
            <div className={styles.relationshipExplorerBody}>
                <div className={styles.relationshipTree}>
                    <div className={styles.relationshipTreeHeader}>
                        <strong>{item.displayName}</strong>
                        <span>{nodes.length} relationships</span>
                    </div>
                    {!sourceElementId ? <p className={styles.noPropsMessage}>Select an object in the Objects tab first.</p>
                        : isLoading ? <p className={styles.noPropsMessage}>Loading relationships...</p>
                        : loadError ? <p className={styles.noPropsMessage}>Could not load relationships: {loadError}</p>
                        : nodes.length === 0 ? <p className={styles.noPropsMessage}>No relationships are available for this object.</p>
                        : nodes.map(node => (
                            <button key={node.id} className={`${styles.relationshipNode} ${selectedId === node.id ? styles.relationshipNodeSelected : ''}`} onClick={() => setSelectedId(node.id)}>
                                <input type="checkbox" checked={checkedIds.has(node.id)} disabled={!node.targetType || node.relationshipImplemented || isGenerating} onClick={event => event.stopPropagation()} onChange={() => toggleChecked(node.id)} />
                                <span className={styles.relationshipBranch}>└─</span>
                                <span className={styles.relationshipNodeContent}>
                                    <span className={styles.relationshipName}>{node.relationship}</span>
                                    <span className={styles.relationshipTarget}>{node.object.displayName}</span>
                                </span>
                                <span className={node.relationshipImplemented ? styles.relationshipImplemented : styles.relationshipNotImplemented}>
                                    {node.relationshipImplemented ? 'Generated' : node.targetImplemented ? 'Target ready' : 'Not generated'}
                                </span>
                            </button>
                        ))}
                </div>
                <div className={styles.relationshipDetails}>
                    <h3 className={styles.sectionTitle}>Relationship details</h3>
                    {selected ? <>
                        <dl className={styles.relationshipDetailList}>
                            <div><dt>Target</dt><dd>{selected.object.displayName}</dd></div>
                            <div><dt>Type</dt><dd>{selected.targetType?.displayName ?? selected.object.typeElementId}</dd></div>
                            <div><dt>Relationship</dt><dd>{selected.relationship}</dd></div>
                            <div><dt>Direction</dt><dd>{selected.direction}</dd></div>
                            <div><dt>Element ID</dt><dd>{selected.object.elementId}</dd></div>
                        </dl>
                        <div className={styles.relationshipActions}>
                            <button className={styles.secondaryButton} disabled={!selected.targetType} onClick={() => selected.targetType && onNavigateToType(selected.targetType)}>Open ObjectType</button>
                            <button
                                className={styles.actionButton}
                                disabled={!selected.targetType || isGenerating}
                                onClick={() => void generateNodes([selected])}
                            >{isGenerating ? 'Generating...' : selected.relationshipImplemented ? 'Regenerate relationship' : 'Generate relationship'}</button>
                        </div>
                    </> : <p className={styles.noPropsMessage}>Select a relationship to inspect it.</p>}
                </div>
            </div>
            <div className={styles.relationshipFooter}>
                <span>{checkedIds.size} relationships selected</span>
                <button
                    className={styles.actionButton}
                    disabled={checkedNodes.length === 0 || isGenerating}
                    onClick={() => void generateNodes(checkedNodes)}
                >{isGenerating ? 'Generating...' : 'Implement selected relationships'}</button>
            </div>
        </div>
    );
};

export default RelationshipsExplorer;
