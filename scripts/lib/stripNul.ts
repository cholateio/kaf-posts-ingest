// Postgres text/jsonb cannot store U+0000 ("unsupported Unicode escape
// sequence"). Gemini emitted one on 2026-10-10 (1 in ~400 posts) and the
// whole row update was rejected.
export function stripNul<T>(value: T): T {
    if (typeof value === 'string') return value.replaceAll('\u0000', '') as T;
    if (Array.isArray(value)) return value.map(stripNul) as T;
    if (value && typeof value === 'object') {
        return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, stripNul(v)])) as T;
    }
    return value;
}
