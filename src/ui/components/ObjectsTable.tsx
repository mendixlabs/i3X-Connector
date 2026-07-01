import React, { useMemo } from 'react';
import styles from '../index.module.css';

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

const isElementIdColumn = (column: string) =>
    (column.split('.').pop()?.toLowerCase() ?? '') === 'elementid';

interface Props {
    isLoadingObjects: boolean;
    objectsLoadError: string | null;
    retrievedObjects: unknown[];
    selectedObjectIndex: number | null;
    onSelectIndex: (index: number) => void;
}

const ObjectsTable: React.FC<Props> = ({ isLoadingObjects, objectsLoadError, retrievedObjects, selectedObjectIndex, onSelectIndex }) => {
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

    if (isLoadingObjects) {
        return <p className={styles.noPropsMessage}>Loading objects...</p>;
    }
    if (objectsLoadError) {
        return <p className={styles.noPropsMessage}>Could not load objects: {objectsLoadError}</p>;
    }
    if (retrievedObjects.length === 0) {
        return <p className={styles.noPropsMessage}>No objects returned for this type.</p>;
    }

    return (
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
                        onClick={() => onSelectIndex(index)}
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
    );
};

export default ObjectsTable;
