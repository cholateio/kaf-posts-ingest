import { describe, expect, it } from 'vitest';
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
