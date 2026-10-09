import { describe, expect, it, vi } from 'vitest';
import { playlistFeedUrl, videoIdsFromYoutubeFeed } from '../rssDiscovery';

const XML = `<?xml version="1.0"?><feed><title>Live streams</title>
<entry><yt:videoId>UuOR80TUvFs</yt:videoId><title>a</title></entry>
<entry><yt:videoId>QIRRaMyVqYg</yt:videoId><title>b</title></entry>
<entry><yt:videoId>UuOR80TUvFs</yt:videoId><title>dup</title></entry></feed>`;

describe('rssDiscovery', () => {
    it('builds UULV / UULF playlist feed urls from a UC channel id', () => {
        expect(playlistFeedUrl('UCkJYa9mVS25eHOO9bM7YK3Q', 'live')).toBe('https://www.youtube.com/feeds/videos.xml?playlist_id=UULVkJYa9mVS25eHOO9bM7YK3Q');
        expect(playlistFeedUrl('UCkJYa9mVS25eHOO9bM7YK3Q', 'uploads')).toBe('https://www.youtube.com/feeds/videos.xml?playlist_id=UULFkJYa9mVS25eHOO9bM7YK3Q');
    });
    it('extracts unique video ids from a feed', () => {
        expect(videoIdsFromYoutubeFeed(XML)).toEqual(['UuOR80TUvFs', 'QIRRaMyVqYg']);
    });
    it('returns [] on garbage', () => {
        expect(videoIdsFromYoutubeFeed('<html>404</html>')).toEqual([]);
    });
});

describe('playlistItemsVideoIds', () => {
    it('reads videoIds out of a playlistItems.list payload, deduped', async () => {
        const { playlistItemsVideoIds } = await import('../rssDiscovery');
        const body = { items: [
            { contentDetails: { videoId: 'UuOR80TUvFs' } },
            { contentDetails: { videoId: 'QIRRaMyVqYg' } },
            { contentDetails: { videoId: 'UuOR80TUvFs' } },
        ] };
        expect(playlistItemsVideoIds(body)).toEqual(['UuOR80TUvFs', 'QIRRaMyVqYg']);
    });
    it('returns [] for a payload without items', async () => {
        const { playlistItemsVideoIds } = await import('../rssDiscovery');
        expect(playlistItemsVideoIds({})).toEqual([]);
    });
});

describe('fetchPlaylistVideoIds', () => {
    it('falls back to playlistItems.list when the RSS endpoint is blocked', async () => {
        const { fetchPlaylistVideoIds } = await import('../rssDiscovery');
        const fetchImpl = vi.fn(async (url: string) =>
            url.includes('feeds/videos.xml')
                ? new Response('blocked', { status: 404 })
                : new Response(JSON.stringify({ items: [{ contentDetails: { videoId: 'UuOR80TUvFs' } }] }), { status: 200 }));
        await expect(fetchPlaylistVideoIds('UCkJYa9mVS25eHOO9bM7YK3Q', 'live', 'KEY', fetchImpl as unknown as typeof fetch))
            .resolves.toEqual({ ids: ['UuOR80TUvFs'], via: 'api' });
    });
    it('treats a playlist that does not exist (404 from both) as empty, not an error', async () => {
        // ヰ世界情緒's stream channel has no long-form uploads: UULF… 404s everywhere.
        const { fetchPlaylistVideoIds } = await import('../rssDiscovery');
        const fetchImpl = vi.fn(async () => new Response('nope', { status: 404 }));
        await expect(fetchPlaylistVideoIds('UC3VN9h8fokwB2XURWHNcdWw', 'uploads', 'KEY', fetchImpl as unknown as typeof fetch))
            .resolves.toEqual({ ids: [], via: 'api' });
    });
    it('still throws when the API fails for another reason', async () => {
        const { fetchPlaylistVideoIds } = await import('../rssDiscovery');
        const fetchImpl = vi.fn(async (url: string) => new Response('x', { status: url.includes('feeds/') ? 500 : 403 }));
        await expect(fetchPlaylistVideoIds('UCkJYa9mVS25eHOO9bM7YK3Q', 'live', 'KEY', fetchImpl as unknown as typeof fetch))
            .rejects.toThrow(/403/);
    });
});
