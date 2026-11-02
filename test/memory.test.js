import test from 'node:test';
import assert from 'node:assert/strict';

import { splitMemory } from '../src/memory.js';

test('the example: full stops inside quotes never split, quotes stay with their attribution', () => {
    const body = `"You always pick me first, right?" Ten-year-old Mike had asked, kicking a soccer ball against the fence. Jin, sprawled in the grass, had grinned. "Duh. You're my best friend." It felt like a vow. Now, in the truck, it felt like a lie.`;

    assert.deepEqual(splitMemory(body), [
        `"You always pick me first, right?" Ten-year-old Mike had asked, kicking a soccer ball against the fence.`,
        'Jin, sprawled in the grass, had grinned.',
        `"Duh. You're my best friend."`,
        'It felt like a vow.',
        'Now, in the truck, it felt like a lie.',
    ]);
});

test('a quote without an attribution stands alone', () => {
    assert.deepEqual(splitMemory('"How are you?" "Fine."'), ['"How are you?"', '"Fine."']);
});

test('action beats stay glued to the quote before them', () => {
    assert.deepEqual(splitMemory('"Hi." She smiled and looked away.'), ['"Hi." She smiled and looked away.']);
});

test('a lowercase connector continues the sentence', () => {
    assert.deepEqual(splitMemory('He said "Stop. Now." and left.'), ['He said "Stop. Now." and left.']);
});

test('a capitalized connector is the next sentence', () => {
    assert.deepEqual(splitMemory('"Stop. Now." And then it rained.'), ['"Stop. Now."', 'And then it rained.']);
});

test('abbreviations and initials do not split', () => {
    assert.deepEqual(
        splitMemory('She met Dr. Hale at the pier. They talked.'),
        ['She met Dr. Hale at the pier.', 'They talked.'],
    );
    assert.deepEqual(
        splitMemory('J. R. R. Tolkien wrote it. Long before us.'),
        ['J. R. R. Tolkien wrote it.', 'Long before us.'],
    );
});

test('curly quotes behave like straight ones', () => {
    assert.deepEqual(
        splitMemory('\u201cDuh. You\u2019re safe.\u201d It felt like a vow.'),
        ['\u201cDuh. You\u2019re safe.\u201d', 'It felt like a vow.'],
    );
});

test('apostrophes are not quotes', () => {
    assert.deepEqual(splitMemory("It's Mike's coat. It's also Mara's."), ["It's Mike's coat.", "It's also Mara's."]);
});

test('blank lines split paragraphs, sentence ends split within them', () => {
    assert.deepEqual(splitMemory('One line.\n\nAnother.\nStill another.'), ['One line.', 'Another.', 'Still another.']);
});

test('empty bodies give no fragments', () => {
    assert.deepEqual(splitMemory(''), []);
    assert.deepEqual(splitMemory('   \n\n  '), []);
});
