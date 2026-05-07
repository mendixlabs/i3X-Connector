import React, { useState, useEffect } from 'react';
import styles from '../index.module.css';
import { ListProps, ObjectType, isObjectTypeArray } from '../types';

const ITEMS_PER_PAGE = 10;

const EmptyIcon = () => (
    <svg width="48" height="48" viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg">
        <rect x="8" y="12" width="32" height="26" rx="3" stroke="currentColor" strokeWidth="2"/>
        <path d="M8 18h32" stroke="currentColor" strokeWidth="2"/>
        <path d="M16 24h16M16 30h10" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
    </svg>
);

const List: React.FC<ListProps> = ({ apiData, selectedId, onSelect, onCreateObjectsList, isCreatingObjectsList }) => {
    const [items, setItems] = useState<ObjectType[]>([]);
    const [currentPage, setCurrentPage] = useState(1);

    useEffect(() => {
        if (isObjectTypeArray(apiData)) {
            setItems(apiData);
            setCurrentPage(1);
        } else if (apiData !== null && apiData !== undefined) {
            setItems([]);
        }
    }, [apiData]);

    if (!apiData) return null;

    const totalPages = Math.ceil(items.length / ITEMS_PER_PAGE);
    const paginatedItems = items.slice(
        (currentPage - 1) * ITEMS_PER_PAGE,
        currentPage * ITEMS_PER_PAGE
    );

    const shortNs = (uri: string) => uri.split('/').filter(Boolean).pop() ?? uri;

    return (
        <div className={styles.card}>
            <div className={styles.cardHeader}>
                <h2 className={styles.cardTitle}>Object Types</h2>
                <div className={styles.cardHeaderActions}>
                    <span className={styles.detailHeaderActionsLabel}>Generic microflow to retrieve objects for any type:</span>
                    <button
                        className={styles.actionButton}
                        onClick={() => void onCreateObjectsList()}
                        disabled={isCreatingObjectsList}
                    >
                        {isCreatingObjectsList ? 'Creating...' : 'Objects List'}
                    </button>
                    {items.length > 0 && (
                        <span className={styles.badge}>{items.length} results</span>
                    )}
                </div>
            </div>

            {items.length === 0 ? (
                <div className={styles.emptyState}>
                    <EmptyIcon />
                    <p className={styles.emptyMessage}>No object types found in the response.</p>
                </div>
            ) : (
                <>
                    <table className={styles.pipelineTable}>
                        <thead>
                            <tr className={styles.tableHeader}>
                                <th className={styles.tableHeaderCell} style={{ width: '20%' }}>Element ID</th>
                                <th className={styles.tableHeaderCell} style={{ width: '20%' }}>Display Name</th>
                                <th className={styles.tableHeaderCell} style={{ width: '15%' }}>Namespace</th>
                                <th className={styles.tableHeaderCell} style={{ width: '10%' }}>Schema Type</th>
                                <th className={styles.tableHeaderCell} style={{ width: '35%' }}>Description</th>
                            </tr>
                        </thead>
                        <tbody>
                            {paginatedItems.map((item) => (
                                <tr
                                    key={item.elementId}
                                    onClick={() => onSelect(item)}
                                    className={`${styles.tableRow} ${selectedId === item.elementId ? styles.selected : ''}`}
                                >
                                    <td className={styles.tableCell}>
                                        <span className={styles.idCell}>{item.elementId}</span>
                                    </td>
                                    <td className={styles.tableCell}>{item.displayName}</td>
                                    <td className={styles.tableCell}>
                                        <span className={styles.nsBadge}>{shortNs(item.namespaceUri)}</span>
                                    </td>
                                    <td className={styles.tableCell}>
                                        {item.schema?.type
                                            ? <span className={styles.typeBadge}>{item.schema.type as string}</span>
                                            : <span className={styles.textFaint}>—</span>
                                        }
                                    </td>
                                    <td className={`${styles.tableCell} ${styles.descCell}`}>
                                        {item.schema?.description as string ?? <span className={styles.textFaint}>—</span>}
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>

                    {totalPages > 1 && (
                        <div className={styles.pagination}>
                            <button
                                className={styles.pageButton}
                                onClick={() => setCurrentPage(p => p - 1)}
                                disabled={currentPage === 1}
                            >
                                ← Prev
                            </button>
                            {Array.from({ length: totalPages }, (_, i) => i + 1).map(page => (
                                <button
                                    key={page}
                                    onClick={() => setCurrentPage(page)}
                                    className={`${styles.pageButton} ${currentPage === page ? styles.pageButtonActive : ''}`}
                                >
                                    {page}
                                </button>
                            ))}
                            <button
                                className={styles.pageButton}
                                onClick={() => setCurrentPage(p => p + 1)}
                                disabled={currentPage === totalPages}
                            >
                                Next →
                            </button>
                        </div>
                    )}
                </>
            )}
        </div>
    );
};

export default List;
