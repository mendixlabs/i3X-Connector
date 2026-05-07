import React, { useState } from 'react';
import { getStudioProApi } from '@mendix/extensions-api';
import styles from '../index.module.css';
import { LoaderProps } from '../types';
import { getObjectTypesUrl, unwrapI3xResult } from '../services/i3xUrl';
import { buildI3xRequestHeaders } from '../services/auth';

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
