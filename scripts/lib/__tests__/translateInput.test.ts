import { describe, expect, it } from 'vitest';
import { translateInput } from '../translateInput';

describe('translateInput', () => {
    it('skips tag-only, link-only and mention-only posts even with the attribution line', () => {
        expect(translateInput('#花譜 #歌ってみた\n\n— 花譜-KAF- (@virtual_kaf) Oct 9, 2026')).toBeNull();
        expect(translateInput('https://t.co/XdArZsGodl — @kafeoren0225 Aug 12, 2026')).toBeNull();
        expect(translateInput('#可不 #rkgk #kafu — @someone Aug 1, 2026')).toBeNull();
        expect(translateInput('@virtual_kaf 💕💕 — @fan Aug 1, 2026')).toBeNull();
    });
    it('skips non-Japanese and very short posts', () => {
        expect(translateInput('Need some penlights for OffKai LIVE tonight? — @offkai Jul 26, 2026')).toBeNull();
        expect(translateInput('最高 — @fan Aug 1, 2026')).toBeNull();
    });
    it('skips Chinese posts: kanji without any kana is not Japanese (they came back translated into Japanese)', () => {
        expect(translateInput('很喜欢的曲，但不知道为什么MV封面看起来像这个\n【官方投稿】踩到猫了。feat.可不 — @RavenKun0305 Oct 11, 2026')).toBeNull();
        expect(translateInput('花譜KAF🎤8周年應援公車 — @fan Oct 1, 2026')).toBeNull();
    });
    it('skips kanji-only Japanese titles too; a translation would just repeat them', () => {
        expect(translateInput('🌸花譜 3D衣装 & 三面図公開🌸 — 花譜-KAF- (@virtual_kaf) Oct 1, 2026')).toBeNull();
    });
    it('keeps Japanese with kana, including katakana-only prose', () => {
        expect(translateInput('新曲のMVが公開されました — @fan Oct 10, 2026')).toBe('新曲のMVが公開されました');
        expect(translateInput('ライブ グッズ ラインナップ — @fan Oct 10, 2026')).toBe('ライブ グッズ ラインナップ');
    });
    it('a hashtag ends at punctuation, so prose after it still counts', () => {
        expect(translateInput('#花譜、今日のライブ最高だった — @fan Oct 10, 2026')).toBe('#花譜、今日のライブ最高だった');
    });
    it('returns the body without the attribution line for a normal post', () => {
        expect(translateInput('本日19時から配信ありマス🐟\n是非あそびにきてね\n\n— 花譜-KAF- (@virtual_kaf) Sep 29, 2026')).toBe('本日19時から配信ありマス🐟\n是非あそびにきてね');
    });
    it('quote tweet: returns only the author\'s own commentary, without the quoted body', () => {
        const t = '花譜ちゃんのライブ最高だった！SINGULAR LIVE (@singularlive_jp)＼\u3000VOD販売 ／—  https://x.com/singularlive_jp/status/1\n\n— 理芽 - RIM (@RIM_virtual) Oct 10, 2026';
        expect(translateInput(t)).toBe('花譜ちゃんのライブ最高だった！');
    });
    it('quote tweet whose own commentary is tag-only is skipped even if the quoted body is Japanese', () => {
        const t = '#花譜\nSINGULAR LIVE (@singularlive_jp)＼ 過去ライブのVOD販売スタート！ ／—  https://x.com/singularlive_jp/status/1\n\n— 理芽 - RIM (@RIM_virtual) Oct 10, 2026';
        expect(translateInput(t)).toBeNull();
    });
});
