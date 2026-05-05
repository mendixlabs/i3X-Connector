import React, { StrictMode, useState, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { IComponent, getStudioProApi } from "@mendix/extensions-api";
import { Loader, List, DetailPanel } from "./components/_components";
import { initStudioPro, implementObjectAsEntity, summarizeArtifactResult } from "./services/studioProService";
import { ConnectionConfig, ObjectType, isObjectTypeArray } from "./types";
import styles from "./index.module.css";
import "./index.module.css";

export const component: IComponent = {
    async loaded(componentContext) {
        const studioPro = getStudioProApi(componentContext);
        initStudioPro(studioPro);

        const preferences = await studioPro.ui.preferences.getPreferences();
        const isDarkMode = preferences.theme === "Dark";

        const AppContent = () => {
            const [apiData, setApiData] = useState<unknown>(null);
            const [connection, setConnection] = useState<ConnectionConfig | null>(null);
            const [selectedItem, setSelectedItem] = useState<ObjectType | null>(null);

            useEffect(() => {
                const link = document.createElement("link");
                link.rel = "stylesheet";
                link.href = "./list.css";
                document.head.appendChild(link);
                return () => { document.head.removeChild(link); };
            }, []);

            const handleSelect = (item: ObjectType) => {
                setSelectedItem(prev => prev?.elementId === item.elementId ? null : item);
            };

            const handleDataLoaded = (data: unknown) => {
                setSelectedItem(null);
                setApiData(data);
            };

            const handleImplement = async (item: ObjectType) => {
                try {
                    if (!connection) {
                        await studioPro.ui.messageBoxes.show(
                            "warning",
                            "No connection configured",
                            "Load an i3X endpoint first before implementing entities."
                        );
                        return;
                    }

                    const result = await implementObjectAsEntity(item, connection);

                    const { somethingCreated, summary } = summarizeArtifactResult(result);

                    if (result.jsonFetchFailed) {
                        await studioPro.ui.notifications.show({
                            title: "JSON Structure uses schema fallback",
                            message: `Could not fetch live object instances from the i3X API. The JSON Structure '${result.jsonStructureName}' was built from the object type schema instead.`,
                            displayDurationInSeconds: 8,
                        });
                    }

                    if (somethingCreated) {
                        await studioPro.ui.notifications.show({
                            title: "Entities implemented",
                            message: summary,
                            displayDurationInSeconds: 6,
                        });
                    } else {
                        await studioPro.ui.messageBoxes.show(
                            "info",
                            "Nothing new to create",
                            `Base entity '${result.baseEntityName}', group entities, associations, attributes, JSON Structure '${result.jsonStructureName}', Import Mapping '${result.importMappingName}', and microflow '${result.microflowName}' already exist in module 'i3X_Implementation'.`
                        );
                    }
                } catch (error) {
                    const details = error instanceof Error ? error.message : String(error);
                    await studioPro.ui.messageBoxes.show(
                        "error",
                        "Could not implement selected object",
                        details
                    );
                }
            };

            return (
                <div className={`${styles.container} ${isDarkMode ? styles.darkMode : ''}`}>
                    <div className={styles.header}>
                        <div className={styles.headerIcon}>
                            <svg width="28" height="28" viewBox="0 0 28 28" fill="none">
                                <rect width="28" height="28" rx="6" fill="currentColor" fillOpacity="0.12"/>
                                <path d="M7 14C7 10.134 10.134 7 14 7s7 3.134 7 7-3.134 7-7 7-7-3.134-7-7z" stroke="currentColor" strokeWidth="1.75"/>
                                <path d="M14 10.5v3.75l2.5 2.5" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round"/>
                            </svg>
                        </div>
                        <div>
                            <h1 className={styles.title}>i3X Connector</h1>
                            <p className={styles.subtitle}>CESMII Smart Manufacturing Platform</p>
                        </div>
                    </div>

                    <p className={styles.description}>
                        Enter an i3X API endpoint URL below and press <kbd className={styles.kbd}>Enter</kbd> or click <strong>Load</strong> to retrieve object types. Click any row to inspect its schema.
                    </p>

                    <Loader context={componentContext} setApiData={handleDataLoaded} setConnection={setConnection} />
                    <List
                        apiData={apiData}
                        selectedId={selectedItem?.elementId ?? null}
                        onSelect={handleSelect}
                    />
                    {selectedItem && connection && (
                        <DetailPanel
                            context={componentContext}
                            connection={connection}
                            item={selectedItem}
                            allObjectTypes={isObjectTypeArray(apiData) ? apiData : []}
                            onClose={() => setSelectedItem(null)}
                            onImplement={handleImplement}
                            onNavigateToType={setSelectedItem}
                        />
                    )}
                </div>
            );
        };

        createRoot(document.getElementById("root")!).render(
            <StrictMode>
                <AppContent />
            </StrictMode>
        );
    }
}
