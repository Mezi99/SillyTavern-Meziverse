import test from 'node:test';
import assert from 'node:assert/strict';

import { splitMemory } from '../src/memory.js';

test('the pause example: every quoted line carries the sentence after it', () => {
    const body = `"Did you ever see a whale?" Rowan had asked, sixteen, mending a net on the quay, watching Kai sideways. "Like, ever?" Kai had laughed. "Nah. You?" A pause. "Never." Rowan had laughed too, the loudest sound he'd ever faked, and mended the rest of the net in silence.`;

    assert.deepEqual(splitMemory(body), [
        `"Did you ever see a whale?" Rowan had asked, sixteen, mending a net on the quay, watching Kai sideways.`,
        `"Like, ever?" Kai had laughed.`,
        `"Nah. You?" A pause.`,
        `"Never." Rowan had laughed too, the loudest sound he'd ever faked, and mended the rest of the net in silence.`,
    ]);
});

test('the lane example: dialogue leads, narration stands alone', () => {
    const body = `"You'll save me a seat, right?" Sera had asked, kicking a stone along the lane. Tomas, lounging under the elm, had grinned. "Always. You know that." It felt like a vow. Now, in the kitchen, it felt like a debt.`;

    assert.deepEqual(splitMemory(body), [
        `"You'll save me a seat, right?" Sera had asked, kicking a stone along the lane.`,
        'Tomas, lounging under the elm, had grinned.',
        `"Always. You know that." It felt like a vow.`,
        'Now, in the kitchen, it felt like a debt.',
    ]);
});

test('full stops inside a quote never split it', () => {
    assert.deepEqual(splitMemory('"Always. You know that."'), ['"Always. You know that."']);
});

test('a quote and the clause right after it read as one row', () => {
    assert.deepEqual(splitMemory('He said "Stop. Now." and left.'), ['He said "Stop. Now." and left.']);
});

test('two quoted lines read as one row', () => {
    assert.deepEqual(splitMemory('"How are you?" "Fine."'), ['"How are you?" "Fine."']);
});

test('curly quotes behave like straight ones', () => {
    assert.deepEqual(
        splitMemory('\u201cStop. Please.\u201d It felt like a plea.'),
        ['\u201cStop. Please.\u201d It felt like a plea.'],
    );
});

test('apostrophes are not quotes', () => {
    assert.deepEqual(splitMemory("It's Oren's coat. It's also Wren's."), ["It's Oren's coat.", "It's also Wren's."]);
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

test('blank lines split paragraphs, sentence ends split within them', () => {
    assert.deepEqual(splitMemory('One line.\n\nAnother.\nStill another.'), ['One line.', 'Another.', 'Still another.']);
});

test('empty bodies give no fragments', () => {
    assert.deepEqual(splitMemory(''), []);
    assert.deepEqual(splitMemory('   \n\n  '), []);
});
