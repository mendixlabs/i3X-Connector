import React, { useEffect, useMemo, useState } from 'react';
import { ComponentContext, getStudioProApi, StudioProApi } from '@mendix/extensions-api';
import styles from '../index.module.css';
import { ObjectType, AnyProperty, ConnectionConfig, isGroupProperty, isArrayProperty, extractArrayItemProperties, shortNs } from '../types';
import { createQueryValuesMicroflow, createHistoryMicroflow, createWriteMicroflow, checkValueQueryEntitiesExist, summarizeArtifactResult } from '../services/studioProService';
import { getObjectsUrl, unwrapI3xResult } from '../services/i3xUrl';
import { buildI3xRequestHeaders } from '../services/auth';
import { GroupSection, type RefResolver, type ComponentTypeResolver } from './SchemaTree';
import ObjectsTable from './ObjectsTable';

interface Props {
    context: ComponentContext;
    connection: ConnectionConfig;
    item: ObjectType;
    allObjectTypes: ObjectType[];
    onClose: () => void;
    onNavigateToType: (type: ObjectType) => void;
}

function extractRefName(ref: string): string | null {
    const match = ref.match(/#\/\$defs\/(.+)/);
    return match?.[1] ?? null;
}

// Runs one artifact-creation action with the shared loading/error/notification shape used by
// all three "Create for this ObjectType" buttons: flip the loading flag, run the action, show
// an error message box on failure, and always clear the loading flag. Each handler still owns
// its own guard condition and success notifications, since those genuinely differ per action.
async function runArtifactAction(
    studioPro: StudioProApi,
    setLoading: (value: boolean) => void,
    errorTitle: string,
    action: () => Promise<void>
): Promise<void> {
    setLoading(true);
    try {
        await action();
    } catch (error) {
        const details = error instanceof Error ? error.message : String(error);
        await studioPro.ui.messageBoxes.show('error', errorTitle, details);
    } finally {
        setLoading(false);
    }
}

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

    // Links a leaf property to another ObjectType when the i3X schema marks it as a composed
    // child: the property's description carries a "composed child:" prefix, and the object's
    // own `related.types` list (URIs of the form "...:<elementId>") is searched for an entry
    // whose elementId best matches the property name. Falls back to the first related type if
    // no name match is found, since a composed-child link with no confident match is still
    // more useful than none.
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

        await runArtifactAction(studioPro, setIsCreatingQuery, 'Could not create value query microflow', async () => {
            const result = await createQueryValuesMicroflow(item, selectedObjectSample, connection);
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
        });
    };

    const handleCreateHistoryMicroflow = async () => {
        if (isCreatingHistory) return;

        await runArtifactAction(studioPro, setIsCreatingHistory, 'Could not create history microflow', async () => {
            const result = await createHistoryMicroflow(item, connection);
            await studioPro.ui.notifications.show({
                title: result.microflowCreated ? 'History microflow created' : 'History microflow already exists',
                message: result.microflowCreated
                    ? `'${result.microflowName}' created. JSON: '${result.jsonStructureName}', Mapping: '${result.importMappingName}'.`
                    : `'${result.microflowName}' already exists. JSON: '${result.jsonStructureName}', Mapping: '${result.importMappingName}'.`,
                displayDurationInSeconds: 10,
            });
        });
    };

    const handleCreateWriteMicroflow = async () => {
        if (!writeEntitiesExist || isCreatingWrite) return;

        await runArtifactAction(studioPro, setIsCreatingWrite, 'Could not create write microflow', async () => {
            const result = await createWriteMicroflow(item, connection);
            await studioPro.ui.notifications.show({
                title: result.microflowCreated ? 'Write microflow created' : 'Write microflow already exists',
                message: result.microflowCreated
                    ? `'${result.microflowName}' created. Open it in Studio Pro and change the REST call HTTP method to PUT.`
                    : `'${result.microflowName}' already exists.`,
                displayDurationInSeconds: 10,
            });
            if (result.microflowCreated) {
                await studioPro.ui.editors.editDocument({ id: result.microflowId });
                await studioPro.ui.messageBoxes.show(
                    'warning',
                    'Set writeback REST method to PUT',
                    `Open '${result.microflowName}' in Studio Pro and change the generated REST call HTTP method to PUT before using the microflow.`
                );
            }
        });
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
                    <ObjectsTable
                        isLoadingObjects={isLoadingObjects}
                        objectsLoadError={objectsLoadError}
                        retrievedObjects={retrievedObjects}
                        selectedObjectIndex={selectedObjectIndex}
                        onSelectIndex={setSelectedObjectIndex}
                    />
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
