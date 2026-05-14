import React, { useState, useEffect } from 'react';
import { getStudioProApi, type Constants } from '@mendix/extensions-api';
import styles from '../index.module.css';
import { LoaderProps } from '../types';
import { getObjectTypesUrl, unwrapI3xResult } from '../services/i3xUrl';
import { buildI3xRequestHeaders } from '../services/auth';
import { IMPLEMENTATION_MODULE } from '../types/connection';

const Loader: React.FC<LoaderProps> = ({ context, setApiData, setConnection }) => {
    const studioPro = getStudioProApi(context);
    const messageApi = studioPro.ui.messageBoxes;
    const [url, setUrl] = useState('https://api.i3x.dev/v1/');
    const [loading, setLoading] = useState(false);
    const [authMode, setAuthMode] = useState<'none' | 'basic' | 'token'>('none');
    const [username, setUsername] = useState('');
    const [password, setPassword] = useState('');
    const [token, setToken] = useState('');
    const [tokenHeaderMode, setTokenHeaderMode] = useState<'bearer' | 'custom'>('bearer');
    const [customHeaderName, setCustomHeaderName] = useState('x-api-key');
    const [customPrefix, setCustomPrefix] = useState('');
    const [multiServerMode, setMultiServerMode] = useState(false);

    useEffect(() => {
        const preloadFromConstants = async () => {
            try {
                const units = await studioPro.app.model.constants.getUnitsInfo();
                const mine = units.filter(u => u.moduleName === IMPLEMENTATION_MODULE);

                const baseUrlUnit = mine.find(u => u.name === 'API_BaseUrl');
                if (!baseUrlUnit) return;

                const baseUrlConstant = await studioPro.app.model.constants.load<Constants.Constant>(
                    'Constants$Constant', baseUrlUnit.$ID
                );
                if (!baseUrlConstant?.defaultValue) return;

                setUrl(baseUrlConstant.defaultValue);

                const usernameUnit = mine.find(u => u.name === 'API_Username');
                const passwordUnit = mine.find(u => u.name === 'API_Password');
                if (usernameUnit && passwordUnit) {
                    const [uc, pc] = await Promise.all([
                        studioPro.app.model.constants.load<Constants.Constant>('Constants$Constant', usernameUnit.$ID),
                        studioPro.app.model.constants.load<Constants.Constant>('Constants$Constant', passwordUnit.$ID),
                    ]);
                    setAuthMode('basic');
                    setUsername(uc?.defaultValue ?? '');
                    setPassword(pc?.defaultValue ?? '');
                    return;
                }

                const tokenUnit = mine.find(u => u.name === 'API_Token');
                if (tokenUnit) {
                    const tc = await studioPro.app.model.constants.load<Constants.Constant>('Constants$Constant', tokenUnit.$ID);
                    if (tc?.defaultValue) {
                        setAuthMode('token');
                        setToken(tc.defaultValue);
                        setTokenHeaderMode('bearer');
                    }
                }
            } catch {
                // silently skip preload if model access fails
            }
        };
        preloadFromConstants();
    }, []);

    const resolveAuth = () => {
        if (authMode === 'none') {
            return { mode: 'none' as const };
        }

        if (authMode === 'basic') {
            return {
                mode: 'basic' as const,
                username: username.trim(),
                password,
            };
        }

        return {
            mode: 'token' as const,
            token: token.trim(),
            headerName: tokenHeaderMode === 'bearer' ? 'Authorization' : customHeaderName.trim(),
            prefix: tokenHeaderMode === 'bearer' ? 'Bearer' : customPrefix.trim(),
        };
    };

    const handleLoad = async () => {
        if (authMode === 'basic' && (!username.trim() || !password)) {
            await messageApi.show('error', 'Basic authentication requires both username and password.');
            return;
        }

        if (authMode === 'token' && !token.trim()) {
            await messageApi.show('error', 'Token authentication requires a token value.');
            return;
        }

        if (authMode === 'token' && tokenHeaderMode === 'custom' && !customHeaderName.trim()) {
            await messageApi.show('error', 'Token authentication with custom header requires a header name.');
            return;
        }

        const auth = resolveAuth();

        const objectTypesUrl = getObjectTypesUrl(url);
        if (!objectTypesUrl) {
            await messageApi.show('error', `Invalid URL: "${url}". Please enter a valid i3X endpoint.`);
            return;
        }

        setLoading(true);
        try {
            const proxy = await studioPro.network.httpProxy.getProxyUrl(objectTypesUrl);
            const response = await fetch(proxy, { headers: buildI3xRequestHeaders(auth) });
            if (!response.ok) {
                await messageApi.show('error', `Request failed with status ${response.status} for '${objectTypesUrl}'.`);
                return;
            }
            const raw = await response.json();
            const data = unwrapI3xResult(raw);
            setConnection({
                apiBaseUrl: url.trim(),
                auth,
                multiServerMode,
            });
            setApiData(data);
        } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            await messageApi.show('error', `Error fetching data: ${msg}`);
        } finally {
            setLoading(false);
        }
    };

    const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
        if (e.key === 'Enter') handleLoad();
    };

    return (
        <div className={styles.loaderPanel}>
            <div className={styles.loaderContainer}>
                <input
                    className={styles.loaderInput}
                    type="text"
                    value={url}
                    placeholder="Enter i3X base URL, e.g. https://api.i3x.dev/v1/"
                    onChange={(e) => setUrl(e.target.value)}
                    onKeyDown={handleKeyDown}
                    disabled={loading}
                />
                <button className={styles.loaderButton} onClick={handleLoad} disabled={loading}>
                    {loading ? 'Loading…' : 'Load'}
                </button>
            </div>

            <div className={styles.multiServerRow}>
                <label className={styles.multiServerLabel}>
                    <input
                        type="checkbox"
                        checked={multiServerMode}
                        onChange={(e) => setMultiServerMode(e.target.checked)}
                        disabled={loading}
                    />
                    <span>Multiple servers</span>
                </label>
                <div className={styles.multiServerInfoWrap}>
                    <span className={styles.multiServerInfoIcon}>?</span>
                    <div className={styles.multiServerTooltip}>
                        <p className={styles.tooltipPara}>
                            <strong>Off (default):</strong> Artifacts go directly in <code className={styles.tooltipCode}>i3X_Implementation</code> with simple constant names: <code className={styles.tooltipCode}>API_BaseUrl</code>, <code className={styles.tooltipCode}>API_Token</code>, etc. Saved values are preloaded when the extension opens.
                        </p>
                        <p className={styles.tooltipPara}>
                            <strong>On:</strong> Each endpoint gets its own subfolder and constants are suffixed with the server name, e.g. <code className={styles.tooltipCode}>API_BaseUrl_api_example_com</code>. Use this when connecting to multiple i3X endpoints in the same Mendix project.
                        </p>
                    </div>
                </div>
            </div>

            <div className={styles.authCard}>
                <div className={styles.authHeader}>Authentication</div>
                <div className={styles.authModeRow}>
                    <button
                        type="button"
                        className={`${styles.authModeBtn} ${authMode === 'none' ? styles.authModeBtnActive : ''}`}
                        onClick={() => setAuthMode('none')}
                        disabled={loading}
                    >
                        None
                    </button>
                    <button
                        type="button"
                        className={`${styles.authModeBtn} ${authMode === 'basic' ? styles.authModeBtnActive : ''}`}
                        onClick={() => setAuthMode('basic')}
                        disabled={loading}
                    >
                        Username/Password
                    </button>
                    <button
                        type="button"
                        className={`${styles.authModeBtn} ${authMode === 'token' ? styles.authModeBtnActive : ''}`}
                        onClick={() => setAuthMode('token')}
                        disabled={loading}
                    >
                        Token
                    </button>
                </div>

                {authMode === 'basic' && (
                    <div className={styles.authFieldsGrid}>
                        <input
                            className={styles.loaderInput}
                            type="text"
                            value={username}
                            placeholder="Username"
                            onChange={(e) => setUsername(e.target.value)}
                            disabled={loading}
                        />
                        <input
                            className={styles.loaderInput}
                            type="password"
                            value={password}
                            placeholder="Password"
                            onChange={(e) => setPassword(e.target.value)}
                            disabled={loading}
                        />
                    </div>
                )}

                {authMode === 'token' && (
                    <div className={styles.authFieldsStack}>
                        <div className={styles.authModeRow}>
                            <button
                                type="button"
                                className={`${styles.authModeBtn} ${tokenHeaderMode === 'bearer' ? styles.authModeBtnActive : ''}`}
                                onClick={() => setTokenHeaderMode('bearer')}
                                disabled={loading}
                            >
                                Bearer
                            </button>
                            <button
                                type="button"
                                className={`${styles.authModeBtn} ${tokenHeaderMode === 'custom' ? styles.authModeBtnActive : ''}`}
                                onClick={() => setTokenHeaderMode('custom')}
                                disabled={loading}
                            >
                                Custom Header
                            </button>
                        </div>
                        {tokenHeaderMode === 'custom' && (
                            <div className={styles.authFieldsGrid}>
                                <input
                                    className={styles.loaderInput}
                                    type="text"
                                    value={customHeaderName}
                                    placeholder="Header name (e.g. x-api-key)"
                                    onChange={(e) => setCustomHeaderName(e.target.value)}
                                    disabled={loading}
                                />
                                <input
                                    className={styles.loaderInput}
                                    type="text"
                                    value={customPrefix}
                                    placeholder="Prefix (optional)"
                                    onChange={(e) => setCustomPrefix(e.target.value)}
                                    disabled={loading}
                                />
                            </div>
                        )}
                        <input
                            className={styles.loaderInput}
                            type="password"
                            value={token}
                            placeholder={tokenHeaderMode === 'bearer' ? 'Bearer token' : 'Token value'}
                            onChange={(e) => setToken(e.target.value)}
                            disabled={loading}
                        />
                    </div>
                )}
            </div>
        </div>
    );
};

export default Loader;
