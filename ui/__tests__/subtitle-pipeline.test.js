'use strict';

const pipeline = require('../modules/subtitles/pipeline');

describe('subtitle pipeline helpers', () => {
  test('formats timestamps for srt output', () => {
    expect(pipeline.formatTimestamp(65.432)).toBe('00:01:05,432');
  });

  test('wraps long subtitle lines into two lines', () => {
    const wrapped = pipeline.wrapSubtitleLine('This is a long subtitle line for wrapping', 18);
    expect(wrapped).toContain('\n');
  });

  test('preserves explicit subtitle line breaks', () => {
    const wrapped = pipeline.wrapSubtitleLine('첫 줄 \n 둘째 줄');
    expect(wrapped).toBe('첫 줄\n둘째 줄');
  });

  test('formats srt blocks from translated segments', () => {
    const srt = pipeline.formatSrt([
      {
        id: 0,
        start: 0,
        end: 2.5,
        subtitleText: '안녕하세요',
      },
    ]);
    expect(srt).toContain('00:00:00,000 --> 00:00:02,500');
    expect(srt).toContain('안녕하세요');
  });

  test('falls back when subtitle rewrite duplicates the draft', () => {
    const result = pipeline.sanitizeSubtitleText(
      '이 테스트 비디오는 한글 자막 파이프라인을 위한 것입니다.\n한글 자막 파이프라인을 위한 테스트 비디오입니다.',
      '이것은 한글 자막 파이프라인을 위한 테스트 비디오입니다.'
    );
    expect(result).toBe('이것은 한글 자막 파이프라인을 위한 테스트 비디오입니다.');
  });

  test('optimizes subtitle timing for reading speed and gap', () => {
    const optimized = pipeline.optimizeSubtitleSegments([
      {
        id: 0,
        start: 0.0,
        end: 0.45,
        subtitleText: '안녕',
      },
      {
        id: 1,
        start: 0.52,
        end: 1.1,
        subtitleText: '오늘 테스트하자',
      },
    ]);

    expect(optimized).toHaveLength(1);
    expect(optimized[0].duration).toBeGreaterThanOrEqual(1.0);
    expect(optimized[0].readingCps).toBeLessThanOrEqual(15);
  });

  test('keeps subtitle blocks separated by at least 100ms when possible', () => {
    const optimized = pipeline.optimizeSubtitleSegments([
      {
        id: 0,
        start: 0.0,
        end: 1.2,
        subtitleText: '첫 번째 자막',
      },
      {
        id: 1,
        start: 2.0,
        end: 2.7,
        subtitleText: '두 번째 자막',
      },
    ]);

    expect(optimized).toHaveLength(2);
    expect(optimized[1].start - optimized[0].end).toBeGreaterThanOrEqual(0.1);
    expect(optimized[0].duration).toBeGreaterThanOrEqual(1.0);
    expect(optimized[1].duration).toBeGreaterThanOrEqual(1.0);
  });
});
