import test from 'node:test';
import assert from 'node:assert/strict';

import { reasoningOf, thoughtLabel } from '../src/prose.js';

test('reasoningOf reads the reasoning where SillyTavern keeps it', () => {
    assert.equal(reasoningOf({ extra: { reasoning: ' from the field ' } }), 'from the field');
    assert.equal(reasoningOf({ extra: { reasoning: 'raw', reasoning_display_text: ' shown ' } }), 'shown', 'the display twin wins, like in ST');
    assert.equal(reasoningOf({ extra: { reasoning: '' } }), '');
    assert.equal(reasoningOf(null), '');
    assert.equal(reasoningOf({}), '');
});

test('reasoningOf falls back to the variant, then to the in-band body', () => {
    const swiped = {
        extra: {},
        swipe_id: 1,
        swipes: ['one', 'two'],
        swipe_info: [{ extra: { reasoning: 'variant zero' } }, { extra: { reasoning: 'variant one' } }],
    };
    assert.equal(reasoningOf(swiped), 'variant one');

    assert.equal(
        reasoningOf({ extra: {}, mes: `${String.fromCharCode(60)}think${String.fromCharCode(62)}inline thinking${String.fromCharCode(60)}/think${String.fromCharCode(62)}prose` }),
        'inline thinking',
        'a thinking block stays readable when ST never moved it',
    );
});

test('thoughtLabel words the head like SillyTavern', () => {
    assert.equal(thoughtLabel({ extra: { reasoning_duration: 5000 } }), 'Thought for 5 seconds');
    assert.equal(thoughtLabel({ extra: { reasoning_duration: 90000 } }), 'Thought for 2 minutes');
    assert.equal(thoughtLabel({}, true), 'Thinking…');
    assert.equal(thoughtLabel({}), 'Reasoning');
});
